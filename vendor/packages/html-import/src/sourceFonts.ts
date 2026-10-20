/**
 * The fonts of an imported document (SPEC 5.7, IMP-12). Two things, both about making the text
 * of an imported slide look the same in the editor as it did in the source:
 *
 * - The faces the file brought with it (`@font-face` with the font inside, as a `data:` or
 *   `blob:` URL) become font assets of the deck, once each, however many slides use them.
 * - The fonts the app itself offers are made known to the source document, so a file that
 *   names one of them without carrying it is drawn with it here, as it will be on the slide.
 * - A font the file carries under the name of one of the app's, and that is that font (a cut
 *   of it: the letters in use, one weight of a variable font), is the app's: the file is drawn
 *   with the app's own font, and the deck keeps no copy of the cut (`sameFont`).
 */
import type { AssetMeta } from '@slidr/model';
import { ASSET_URL_SCHEME } from '@slidr/renderer';

/** A face of the app's own font library, with a URL the source document can load. */
export interface AppFontFace {
  family: string;
  style: string;
  weight: string;
  url: string;
  unicodeRange?: string;
}

/** A face the file declared, as its rule says it. */
interface DeclaredFace {
  family: string;
  weight: string;
  style: string;
  unicodeRange?: string;
  /** The `src` descriptor, whole. */
  src: string;
}

const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/, '$2');

/** Every `@font-face` rule of a document's stylesheets, in order. */
function declaredFaces(doc: Document): DeclaredFace[] {
  const faces: DeclaredFace[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule.constructor.name === 'CSSFontFaceRule') {
        const style = (rule as CSSFontFaceRule).style;
        const family = unquote(style.getPropertyValue('font-family'));
        const src = style.getPropertyValue('src');
        if (!family || !src) continue;
        const range = style.getPropertyValue('unicode-range').trim();
        faces.push({
          family,
          weight: style.getPropertyValue('font-weight').trim() || 'normal',
          style: style.getPropertyValue('font-style').trim() || 'normal',
          ...(range ? { unicodeRange: range } : {}),
          src,
        });
      } else if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules);
    }
  };
  const sheets = [...Array.from(doc.styleSheets), ...Array.from(doc.adoptedStyleSheets ?? [])];
  for (const sheet of sheets) {
    try {
      visit(sheet.cssRules);
    } catch {
      // A sheet from another origin cannot be read.
    }
  }
  return faces;
}

/** The first source of a face that carries the font itself. */
function embeddedUrl(src: string): string | undefined {
  return /url\(\s*(["']?)((?:data|blob):[^"')]+)\1\s*\)/.exec(src)?.[2];
}

/** What tells one declared face from another, without holding megabytes of `src` as a key. */
function faceKey(face: DeclaredFace): string {
  const { family, weight, style, unicodeRange, src } = face;
  return [family, weight, style, unicodeRange ?? '', src.length, src.slice(-96)].join('|');
}

/** The weights a `font-weight` descriptor covers: one weight, or a range of them. */
interface Span {
  lo: number;
  hi: number;
}

function weightSpan(weight: string): Span | undefined {
  const parts = weight
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((part) => (part === 'normal' ? 400 : part === 'bold' ? 700 : Number(part)));
  if (parts.length > 2 || parts.some((n) => !Number.isFinite(n) || n < 1 || n > 1000)) {
    return undefined;
  }
  return { lo: Math.min(...parts), hi: Math.max(...parts) };
}

/** Whether two faces are one face but for the weight they are declared for. */
const alikeButWeight = (a: DeclaredFace, b: DeclaredFace) =>
  a.family === b.family && a.style === b.style && (a.unicodeRange ?? '') === (b.unicodeRange ?? '');

/**
 * The range of weights that says what several faces of one file say, each for a weight of its
 * own: `400`, `500` and `600` are `400 600`. That is how a variable font is served, a rule a
 * weight over the same file, and a face with a range draws each of those weights from the file
 * exactly as the rule of that weight did, and the nearest end for a weight outside them.
 *
 * Not when there is a gap between the weights (`400` and `700`): a weight in the gap would be
 * drawn as itself, where the source drew the nearer of the two. And not when another file of
 * the family has a weight inside the range, which the range would take text from.
 */
function weightRange(
  faces: readonly DeclaredFace[],
  others: readonly DeclaredFace[],
): Span | undefined {
  const spans: Span[] = [];
  for (const face of faces) {
    const span = weightSpan(face.weight);
    if (!span) return undefined;
    spans.push(span);
  }
  const own = spans[0];
  if (!own) return undefined;
  const sorted = [...spans].sort((a, b) => a.lo - b.lo);
  const range = { ...sorted[0]! };
  for (const next of sorted.slice(1)) {
    if (next.lo - range.hi > 100) return undefined;
    range.hi = Math.max(range.hi, next.hi);
  }
  // The first face says it all already: nothing to widen.
  if (range.lo === own.lo && range.hi === own.hi) return undefined;
  for (const other of others) {
    const span = weightSpan(other.weight);
    if (!span || (span.lo <= range.hi && span.hi >= range.lo)) return undefined;
  }
  return range;
}

/* ------------------------------------------------- a cut of one of the app's own fonts */

/** The characters a `unicode-range` holds, as spans of code points; undefined for all of them. */
type Spans = readonly (readonly [number, number])[];

function unicodeSpans(range: string | undefined): Spans | undefined {
  if (!range?.trim()) return undefined;
  const spans: [number, number][] = [];
  for (const part of range.split(',')) {
    const text = part.trim().replace(/^u\+/i, '');
    const [from, to] = text.includes('-')
      ? text.split('-')
      : [text.replace(/\?/g, '0'), text.replace(/\?/g, 'f')];
    const lo = parseInt(from ?? '', 16);
    const hi = parseInt(to ?? '', 16);
    if (Number.isFinite(lo) && Number.isFinite(hi)) spans.push([lo, hi]);
  }
  return spans;
}

const holds = (spans: Spans | undefined, code: number) =>
  !spans || spans.some(([lo, hi]) => code >= lo && code <= hi);

/** What two ranges share, as a `unicode-range`: undefined for everything, empty for nothing. */
function sharedRange(a: Spans | undefined, b: Spans | undefined): string | undefined {
  if (!a && !b) return undefined;
  const hex = (code: number) => code.toString(16).toUpperCase();
  const write = (spans: Spans) =>
    spans.map(([lo, hi]) => (lo === hi ? `U+${hex(lo)}` : `U+${hex(lo)}-${hex(hi)}`)).join(', ');
  if (!a || !b) return write((a ?? b)!);
  const shared: [number, number][] = [];
  for (const [alo, ahi] of a) {
    for (const [blo, bhi] of b) {
      const lo = Math.max(alo, blo);
      const hi = Math.min(ahi, bhi);
      if (lo <= hi) shared.push([lo, hi]);
    }
  }
  return write(shared);
}

/** More different characters than a deck draws: where reading a document for them stops. */
const MAX_CHARACTERS = 4000;

/**
 * The characters a document shows, each once, by the families their text names (lower case):
 * its text, in shadow trees too. A family is asked about the text set in it, not about a letter
 * that only another font of the page draws.
 */
function charactersOf(doc: Document): Map<string, Set<number>> {
  const view = doc.defaultView;
  const found = new Map<string, Set<number>>();
  let count = 0;
  const visit = (root: Node, families: readonly string[]) => {
    for (const child of Array.from(root.childNodes)) {
      if (count >= MAX_CHARACTERS) return;
      if (child.nodeType === 3) {
        for (const character of (child as Text).data) {
          const code = character.codePointAt(0)!;
          if (code < 0x20) continue;
          for (const family of families) {
            let codes = found.get(family);
            if (!codes) found.set(family, (codes = new Set()));
            if (!codes.has(code)) count++;
            codes.add(code);
          }
        }
      } else if (child.nodeType === 1) {
        const el = child as Element;
        if (el.localName === 'script' || el.localName === 'style') continue;
        const named = (view?.getComputedStyle(el).fontFamily ?? '')
          .split(',')
          .map((name) => unquote(name).toLowerCase())
          .filter(Boolean);
        if (el.shadowRoot) visit(el.shadowRoot, named);
        visit(el, named);
      }
    }
  };
  if (doc.body) visit(doc.body, []);
  return found;
}

/** The size the two fonts are measured at, in px: a font unit of most fonts is 1px or less. */
const PROBE_SIZE = 1000;
/**
 * How far apart two drawings of one character may be and still be one font, in px at the probe
 * size. A weight cut from a variable font has its outlines and its widths in whole font units,
 * where the variable font has them in fractions, and the browser and the cutter do not round a
 * half the same way: a letter moves the pen by a unit more in one than in the other (measured
 * on a cut of Rubik: four letters of the alphabet at weight 700, by exactly one unit). The box
 * of its ink is reported in steps of a 64th of the size, so two outlines a hair apart can be a
 * whole step apart there. Another font, or another version of the font with its letters
 * redrawn, is tens of units off in the widths of its letters.
 */
const ADVANCE_SLACK = 1.5;
const INK_SLACK = PROBE_SIZE / 64 + 1;

/** One character as a font draws it: how far it moves the pen, and the box of its ink. */
interface Drawn {
  width: number;
  left: number;
  right: number;
  up: number;
  down: number;
}

const apart = (a: Drawn, b: Drawn) => ({
  advance: Math.abs(a.width - b.width),
  ink: Math.max(
    Math.abs(a.left - b.left),
    Math.abs(a.right - b.right),
    Math.abs(a.up - b.up),
    Math.abs(a.down - b.down),
  ),
});

/** A font under two names of its own: as it is, and at half its size. */
interface Probe {
  whole: string;
  half: string;
}

/**
 * A character as `font` draws it, or undefined when the font does not have it. A character a
 * font lacks is drawn by whatever comes after it in the list, so the other font of the
 * comparison is put there, once as it is and once at half its size: a drawing that changes
 * between the two is the other font's, not this one's.
 *
 * The browser's own generic families do not tell. A Hebrew letter that a cut lacks is drawn the
 * same after `serif`, `sans-serif` and `monospace` at weight 800: the fonts those name have no
 * such letter at that weight, and all three go on to one font of the system.
 */
function draw(
  ctx: CanvasRenderingContext2D,
  font: Probe,
  beside: Probe,
  weight: number,
  style: string,
  text: string,
): Drawn | undefined {
  const before = (fallback: string): Drawn => {
    ctx.font = `${style} ${weight} ${PROBE_SIZE}px "${font.whole}", "${fallback}"`;
    const m = ctx.measureText(text);
    return {
      width: m.width,
      left: m.actualBoundingBoxLeft,
      right: m.actualBoundingBoxRight,
      up: m.actualBoundingBoxAscent,
      down: m.actualBoundingBoxDescent,
    };
  };
  const first = before(beside.whole);
  const { advance, ink } = apart(first, before(beside.half));
  return advance < 0.01 && ink < 0.01 ? first : undefined;
}

/** A face of the file, and the faces of the app that draw what it draws. */
interface Stand {
  face: DeclaredFace;
  by: { app: AppFontFace; unicodeRange?: string }[];
}

let probes = 0;

/**
 * Whether the faces a file carries of one family are the app's font of that name: every
 * character set in that family that a face of the file has, the app's face draws the same, at
 * the weight the file's face is for. Then each face of the file can be drawn from the app's
 * files instead, which is what the answer says: for each, the app's faces that stand for it.
 *
 * Undefined when they are not the same font, or when nothing shows it: a face that is not in
 * the file, a style or a weight the app's font does not have, a character the app's font lacks,
 * one that is drawn differently, or no character of the document that any of the faces has.
 */
async function sameFont(
  doc: Document,
  faces: readonly DeclaredFace[],
  app: readonly AppFontFace[],
  characters: Iterable<number>,
): Promise<Stand[] | undefined> {
  const view = doc.defaultView;
  const ctx = doc.createElement('canvas').getContext('2d');
  if (!view || !ctx) return undefined;
  /** Faces under names of their own, so that each is measured alone; taken out again below. */
  const loaded: FontFace[] = [];
  const load = async (src: string, weight: string, style: string): Promise<Probe> => {
    const whole = `slidr-probe-${++probes}`;
    const probe = { whole, half: `${whole}-half` };
    const sizes = [
      [probe.whole, {}],
      [probe.half, { sizeAdjust: '50%' }],
    ] as const;
    for (const [name, size] of sizes) {
      const face = new view.FontFace(name, src, { weight, style, ...size });
      await face.load();
      doc.fonts.add(face);
      loaded.push(face);
    }
    return probe;
  };
  const theirs = new Map<AppFontFace, Probe>();
  const probeOf = async (face: AppFontFace, style: string): Promise<Probe> => {
    let probe = theirs.get(face);
    if (!probe) {
      probe = await load(`url(${JSON.stringify(face.url)})`, face.weight, style);
      theirs.set(face, probe);
    }
    return probe;
  };
  try {
    const stands: Stand[] = [];
    let shown = 0;
    for (const face of faces) {
      const url = embeddedUrl(face.src);
      const span = weightSpan(face.weight);
      const style = face.style.toLowerCase();
      if (!url || !span || (style !== 'normal' && style !== 'italic')) return undefined;
      const spans = unicodeSpans(face.unicodeRange);
      const candidates = app.flatMap((other) => {
        const weights = weightSpan(other.weight);
        if (other.style.toLowerCase() !== style || !weights) return [];
        if (weights.lo > span.lo || weights.hi < span.hi) return [];
        const unicodeRange = sharedRange(spans, unicodeSpans(other.unicodeRange));
        return unicodeRange === ''
          ? []
          : [{ app: other, ...(unicodeRange ? { unicodeRange } : {}) }];
      });
      const fallback = candidates[0];
      if (!fallback) return undefined;
      const mine = await load(`url(${JSON.stringify(url)})`, face.weight, face.style);
      for (const code of characters) {
        if (!holds(spans, code)) continue;
        const text = String.fromCodePoint(code);
        // The face of the app that the browser would take this character from.
        const stand = candidates.find(({ app: other }) =>
          holds(unicodeSpans(other.unicodeRange), code),
        );
        const other = await probeOf((stand ?? fallback).app, style);
        for (const weight of new Set([span.lo, span.hi])) {
          const drawn = draw(ctx, mine, other, weight, style, text);
          // Not a character of this cut: the file does not draw it with this face either.
          if (!drawn) break;
          if (!stand) return undefined;
          const same = draw(ctx, other, mine, weight, style, text);
          if (!same) return undefined;
          const { advance, ink } = apart(drawn, same);
          if (advance > ADVANCE_SLACK || ink > INK_SLACK) return undefined;
          shown++;
        }
      }
      stands.push({ face, by: candidates });
    }
    return shown > 0 ? stands : undefined;
  } catch {
    // A font that does not load is no font to compare.
    return undefined;
  } finally {
    for (const face of loaded) doc.fonts.delete(face);
  }
}

/** Takes every rule of a family's faces out of a document's stylesheets. */
function removeFaces(doc: Document, family: string): void {
  const strip = (owner: { cssRules: CSSRuleList; deleteRule(index: number): void }) => {
    for (let i = owner.cssRules.length - 1; i >= 0; i--) {
      const rule = owner.cssRules[i]!;
      if (rule.constructor.name === 'CSSFontFaceRule') {
        const named = unquote((rule as CSSFontFaceRule).style.getPropertyValue('font-family'));
        if (named.toLowerCase() === family) owner.deleteRule(i);
      } else if ('cssRules' in rule) strip(rule as CSSGroupingRule);
    }
  };
  const sheets = [...Array.from(doc.styleSheets), ...Array.from(doc.adoptedStyleSheets ?? [])];
  for (const sheet of sheets) {
    try {
      strip(sheet);
    } catch {
      // A sheet from another origin cannot be read, and none of its faces was compared.
    }
  }
}

/** What a font asset says in its record. */
interface Recorded {
  face: DeclaredFace;
  /** The weights it is for, when they could be read. */
  span?: Span;
}

export interface SourceFonts {
  /**
   * Stores the embedded faces of `doc` that were not stored yet as font assets, and brings the
   * app's own fonts in line with what the file declares now. Returns what the agent should
   * know.
   */
  sync(doc: Document): Promise<string[]>;
  /**
   * `@font-face` rules for the faces whose font file is an asset that already says another
   * face, and that the asset's record cannot say as well: one file under two family names, two
   * weights of a variable font with others between them that the file does not declare. An
   * asset is its content and holds one face, so these go with the slides, as rules of the
   * slide's own stylesheet that name the asset. Empty when every face is in an asset's record.
   */
  css(): string;
}

/** A CSS string literal. */
const cssText = (value: string) => JSON.stringify(value);

/** The rule that registers a declared face from a font asset of the deck. */
function faceRule(face: DeclaredFace, assetId: string): string {
  const range = face.unicodeRange ? ` unicode-range: ${face.unicodeRange};` : '';
  return `@font-face { font-family: ${cssText(face.family)}; font-weight: ${face.weight}; font-style: ${face.style}; font-display: block; src: url("${ASSET_URL_SCHEME}${assetId}");${range} }`;
}

export function createSourceFonts(options: {
  storeAsset(
    bytes: Uint8Array<ArrayBuffer>,
    info: { mime: string; name?: string },
  ): Promise<AssetMeta>;
  /** Called with each face that became an asset. */
  stored(asset: AssetMeta): void;
  appFonts?: readonly AppFontFace[];
}): SourceFonts {
  const seen = new Set<string>();
  /**
   * The face each font asset says in its record, by asset id: the first that brought the file,
   * for every weight the file was declared for beside it when those make a range.
   */
  const recorded = new Map<string, Recorded>();
  /** The rules of the other faces of the same file. */
  const shared: string[] = [];

  /** Whether an asset's record already says a face. */
  const says = (record: Recorded, face: DeclaredFace): boolean => {
    if (!alikeButWeight(record.face, face)) return false;
    if (record.face.weight === face.weight) return true;
    const span = weightSpan(face.weight);
    return Boolean(record.span && span && span.lo >= record.span.lo && span.hi <= record.span.hi);
  };
  /** The app faces added to each document, by family (lower case). */
  const added = new WeakMap<Document, Map<string, FontFace[]>>();
  /**
   * For each document, the families it carried under the name of one of the app's fonts (lower
   * case), and whether they turned out to be that font: asked once, when a family is first met.
   */
  const judged = new WeakMap<Document, Map<string, boolean>>();

  /**
   * The families of a document that are a cut of the app's own font of the same name, made the
   * app's: the file's rules for them are taken out, and each of their faces is drawn from the
   * app's files, under the weight, style and characters the file declared it for. The text of
   * the file then finds its faces as it did, and is drawn with the font the slide will be drawn
   * with. Their files do not become assets.
   *
   * Without this the two are drawn by two files of one name: on the slide the app's font takes
   * the text, since a font asset of one weight and the app's variable font both answer for that
   * weight, and a heading set in the cut comes out a fraction of a pixel narrower or wider than
   * in the source. An HTML copy of it is drawn by the same font, so nothing the guard falls
   * back on looks like the source, and the whole slide stays HTML.
   */
  async function takeOwn(doc: Document, declared: readonly DeclaredFace[]): Promise<void> {
    const view = doc.defaultView;
    const appFonts = options.appFonts;
    if (!view || !appFonts?.length) return;
    let verdicts = judged.get(doc);
    if (!verdicts) {
      verdicts = new Map();
      judged.set(doc, verdicts);
    }
    const families = new Map<string, DeclaredFace[]>();
    for (const face of declared) {
      const family = face.family.toLowerCase();
      const faces = families.get(family);
      if (faces) faces.push(face);
      else families.set(family, [face]);
    }
    let characters: Map<string, Set<number>> | undefined;
    for (const [family, faces] of families) {
      if (verdicts.has(family)) continue;
      const app = appFonts.filter((face) => face.family.toLowerCase() === family);
      if (app.length === 0) continue;
      characters ??= charactersOf(doc);
      const stands = await sameFont(doc, faces, app, characters.get(family) ?? []);
      // The app's files first, loaded: the file's rules go only once there is a font to follow.
      const made: FontFace[] = [];
      try {
        for (const { face, by } of stands ?? []) {
          for (const { app: other, unicodeRange } of by) {
            const stand = new view.FontFace(face.family, `url(${JSON.stringify(other.url)})`, {
              style: face.style,
              weight: face.weight,
              display: 'block',
              ...(unicodeRange ? { unicodeRange } : {}),
            });
            await stand.load();
            made.push(stand);
          }
        }
      } catch {
        made.length = 0;
      }
      verdicts.set(family, made.length > 0);
      if (made.length === 0) continue;
      removeFaces(doc, family);
      for (const face of made) doc.fonts.add(face);
      for (const face of faces) seen.add(faceKey(face));
    }
  }

  /**
   * The app's fonts in a source document, as `FontFace` objects: nothing is added to its DOM.
   * A family the file declares itself is the file's, and the app's face of that name is taken
   * out, the way a deck's font assets take precedence over the built-in library on a slide. A
   * family that was made the app's (`takeOwn`) has its faces already, as the file declared them.
   */
  function alignAppFonts(doc: Document, declared: readonly DeclaredFace[]): void {
    const view = doc.defaultView;
    if (!view || !options.appFonts?.length) return;
    const own = new Set(declared.map((face) => face.family.toLowerCase()));
    for (const [family, taken] of judged.get(doc) ?? []) if (taken) own.add(family);
    let mine = added.get(doc);
    if (!mine) {
      mine = new Map();
      added.set(doc, mine);
    }
    for (const [family, faces] of mine) {
      if (!own.has(family)) continue;
      for (const face of faces) doc.fonts.delete(face);
      mine.delete(family);
    }
    for (const face of options.appFonts) {
      const family = face.family.toLowerCase();
      if (own.has(family)) continue;
      const faces = mine.get(family) ?? [];
      const key = `${face.weight}|${face.style}|${face.unicodeRange ?? ''}|${face.url}`;
      if (faces.some((f) => (f as FontFace & { slidrKey?: string }).slidrKey === key)) continue;
      try {
        const made = new view.FontFace(face.family, `url(${JSON.stringify(face.url)})`, {
          style: face.style,
          weight: face.weight,
          display: 'block',
          ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
        });
        (made as FontFace & { slidrKey?: string }).slidrKey = key;
        doc.fonts.add(made);
        faces.push(made);
        mine.set(family, faces);
      } catch {
        // A face the browser will not take is one font the file falls back for, as before.
      }
    }
  }

  return {
    async sync(doc) {
      const notes: string[] = [];
      await takeOwn(doc, declaredFaces(doc));
      // Read again: the rules of a family that was made the app's are gone.
      const declared = declaredFaces(doc);
      alignAppFonts(doc, declared);
      /** The faces this call found, by the asset their file became, in the file's order. */
      const brought = new Map<string, { asset: AssetMeta; faces: DeclaredFace[] }>();
      for (const face of declared) {
        const key = faceKey(face);
        if (seen.has(key)) continue;
        seen.add(key);
        const url = embeddedUrl(face.src);
        // A face that points at a file elsewhere did not load (no network), and drew nothing.
        if (!url) continue;
        try {
          const blob = await (await fetch(url)).blob();
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const asset = await options.storeAsset(bytes, {
            mime: blob.type.startsWith('font/') ? blob.type : 'font/woff2',
            name: face.family,
          });
          if (asset.kind !== 'font') {
            notes.push(`The embedded font "${face.family}" is not a font file the app can keep.`);
            continue;
          }
          const entry = brought.get(asset.id);
          if (entry) entry.faces.push(face);
          else brought.set(asset.id, { asset, faces: [face] });
        } catch {
          notes.push(`The embedded font "${face.family}" could not be read.`);
        }
      }
      // One file is one asset, and an asset says one face. Several rules that carry the same
      // file (a rule a weight, a second family name) are that face where its record can say
      // them all, and rules of the slides that point at the asset where it cannot.
      for (const { asset, faces } of brought.values()) {
        let record = recorded.get(asset.id);
        if (!record) {
          const first = faces[0];
          if (!first) continue;
          const alike = faces.filter((face) => alikeButWeight(face, first));
          // A rule the file wrote twice is the same face, not another file's.
          const mine = new Set(faces.map(faceKey));
          const range = weightRange(
            alike,
            declared.filter((face) => !mine.has(faceKey(face)) && alikeButWeight(face, first)),
          );
          const face = range ? { ...first, weight: `${range.lo} ${range.hi}` } : first;
          const span = range ?? weightSpan(first.weight);
          record = { face, ...(span ? { span } : {}) };
          recorded.set(asset.id, record);
          options.stored({
            ...asset,
            font: {
              family: face.family,
              weight: face.weight,
              style: face.style,
              ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
            },
          });
        }
        for (const face of faces) if (!says(record, face)) shared.push(faceRule(face, asset.id));
      }
      return notes;
    },
    css: () => shared.join('\n'),
  };
}
