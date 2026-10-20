/**
 * The sample of a built-in template in one language, from the file Claude wrote (`<lang>.json`,
 * the catalog's `SampleSlide[]`), to the slides the template library shows:
 *
 * - built by the app's own engine (`sampleSlides` of `@slidr/templates/builtin/kit`, as the
 *   catalog's export and the app build a sample), slide by slide, so a slide whose content its
 *   layout cannot seat is that slide's finding and not the end of the render;
 * - checked by the app's design check (`@slidr/lint`, every rule, as the acceptance of a template
 *   runs it), each finding set against the same slide of the sample it was written from: what the
 *   English slide (the Hebrew one, for a right-to-left language) has already is not this
 *   language's doing;
 * - held to the sample it was written from: the same slides on the same layouts, every role
 *   with as many fills, the same pictures, text in the language's own letters, no English left
 *   in it and no placeholder words;
 * - measured for what the slide holds: a template's layouts give their drawings to the slide, to
 *   edit like anything else (ADR-094), and a layout that keeps them is the template's finding.
 */
import { lintSlide } from '@slidr/lint';
import { mediaFiles, mediaUrl } from '@slidr/media-library';
import {
  languageDir,
  RichText,
  type AssetMeta,
  type Deck,
  type Slide as SlideModel,
} from '@slidr/model';
import {
  loadCharts,
  measureSlide,
  renderSlideOffscreen,
  type AssetResolver,
} from '@slidr/renderer';
import { deckFromTemplate, Template } from '@slidr/templates';
import { lockedDrawings, sampleSlides, type SampleSlide } from '@slidr/templates/builtin/kit';
import { pictures } from '@slidr/templates/builtin/pictures';
import { PLACEHOLDER, type Finding, type Lang } from './design';
import { loadFamilies } from './fonts';

export interface TemplateInput {
  kind: 'template';
  id: string;
  templateId: string;
  revision: number;
  lang: Lang;
  template: unknown;
  english: SampleSlide[];
  hebrew?: SampleSlide[] | null;
  /** What the file held; null when it is not JSON (`error` says why). */
  sample: unknown;
  error: string | null;
}

export interface SampleFinding extends Finding {
  /** The slide it is held to has the same finding on the same elements. */
  baseline?: boolean;
}

export interface SlideResult {
  index: number;
  name: string;
  layout: string;
  findings: SampleFinding[];
  issues: string[];
  error?: string;
  /** The share of what the slide shows that is its own, to edit (`holds`). */
  editability?: number;
}

export interface TemplateResult {
  kind: 'template';
  templateId: string;
  lang: Lang;
  revision: number;
  slides: SlideResult[];
  /** The sample as it was built, for publishing; null when it could not be read. */
  sample: SampleSlide[] | null;
  /** The findings and issues of the language as a whole, as a design's result has them. */
  langs: Partial<Record<Lang, { findings: SampleFinding[]; issues: string[]; error?: string }>>;
  /** Issues of the sample as a whole. */
  issues: string[];
  publishable: boolean;
}

/** A slide and the deck it was built in, to draw. */
export interface Built {
  deck: Deck;
  slide: SlideModel;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/* ---------------------------------------------------------------- pictures */

const pictureAssets: Record<string, AssetMeta> = Object.fromEntries(
  Object.values(pictures).map((picture) => [picture.id, picture]),
);

/** Where the pictures of the samples load from: the library's `images/templates/`. */
export async function templatePictures(): Promise<AssetResolver> {
  const files = await mediaFiles();
  const urls = new Map<string, string>();
  for (const picture of Object.values(pictures)) {
    const path = `images/templates/${picture.name}`;
    if (files.has(path)) urls.set(picture.id, mediaUrl(path));
  }
  return (asset) => urls.get(asset.id);
}

/* ---------------------------------------------------------------- building */

/** One sample slide on the template, in a deck of the language, by the app's engine. */
function build(template: Template, sample: SampleSlide, lang: Lang, seed: number): Built {
  const dir = languageDir(lang);
  const withPictures = { ...template, assets: { ...pictureAssets, ...template.assets } };
  const [slide] = sampleSlides(withPictures, [sample], { dir, lang, seed });
  const deck = deckFromTemplate(withPictures, { lang, dir });
  deck.assets = { ...deck.assets, ...withPictures.assets };
  deck.slides = [slide!];
  return { deck, slide: slide! };
}

async function check(built: Built, resolve: AssetResolver): Promise<SampleFinding[]> {
  const rendered = await renderSlideOffscreen({
    deck: built.deck,
    slide: built.slide,
    mode: 'thumbnail',
    resolveAsset: resolve,
  });
  try {
    const measured = await measureSlide(rendered.root);
    const findings = lintSlide(built.deck, built.slide, measured, 'all').map(
      ({ rule, severity, message: said, elementIds }) => ({
        rule,
        severity,
        message: said,
        elementIds: [...elementIds],
      }),
    );
    return [...findings, ...lockedFindings(built)];
  } finally {
    rendered.dispose();
  }
}

/* ---------------------------------------------------------------- what the slide holds */

/** The master components, which every slide shows and none holds (SLD-04). */
const MASTER = new Set<string | undefined>(['logo', 'slideNumber', 'footer']);

/**
 * How much of what a slide shows is its own, to select, move, restyle and delete (ADR-094): its
 * elements, against the drawings its layout keeps under it, the master components left out.
 */
function holds(built: Built): number {
  const layout = built.deck.layouts.find((one) => one.id === built.slide.layoutId);
  const kept = (layout?.decorations ?? []).filter((d) => !d.hidden && !MASTER.has(d.role)).length;
  const own = built.slide.elements.length;
  return own + kept > 0 ? own / (own + kept) : 1;
}

/**
 * The drawings the slide's layout keeps that the slide should hold (`lockedDrawings`): the
 * template's, so the slide it was written from has the same finding and it is not counted
 * against the language.
 */
function lockedFindings(built: Built): SampleFinding[] {
  const locked = lockedDrawings(built.deck.layouts).get(built.slide.layoutId ?? '') ?? [];
  if (locked.length === 0) return [];
  return [
    {
      rule: 'S-locked',
      severity: 'warning',
      message: `The layout keeps ${locked.length === 1 ? 'a drawing' : `${locked.length} drawings`} under the slide, out of the user's reach: only the text can be changed there. A template's layouts give their drawings to the slide (withObjects, ADR-094).`,
      elementIds: locked.map((d) => d.id),
    },
  ];
}

const key = (finding: Finding) => `${finding.rule}|${[...finding.elementIds].sort().join(',')}`;

/* ---------------------------------------------------------------- the contract */

type Content = SampleSlide['content'];
type Fill = Content[keyof Content];

const fills = (value: Fill | undefined): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const isText = (fill: unknown): fill is RichText =>
  typeof fill === 'object' && fill !== null && 'paragraphs' in fill;

const textOf = (fill: RichText) =>
  fill.paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join('')).join('\n');

/** The words of a slide: every text fill, the chart's title and labels, the table's cells. */
function words(slide: SampleSlide): string[] {
  const out: string[] = [];
  for (const value of Object.values(slide.content)) {
    for (const fill of fills(value)) if (isText(fill)) out.push(textOf(fill));
  }
  if (slide.chart?.title) out.push(slide.chart.title);
  if (slide.table) out.push(...slide.table.rows.flat());
  return out.map((text) => text.trim()).filter(Boolean);
}

/** The letters a language is written in, where they are not Latin ones. */
const LETTERS: Partial<Record<Lang, RegExp>> = {
  he: /\p{Script=Hebrew}/u,
  ar: /\p{Script=Arabic}/u,
  ru: /\p{Script=Cyrillic}/u,
  hi: /\p{Script=Devanagari}/u,
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  ko: /\p{Script=Hangul}/u,
  'zh-CN': /\p{Script=Han}/u,
};

const WORDS = /\p{L}{2,}/gu;

/** What breaks the sample's structure, beside the sample it was written from. */
function structureIssues(slide: SampleSlide, source: SampleSlide | undefined): string[] {
  if (!source) return ['The English sample has no slide here: the sample has more slides than it.'];
  const issues: string[] = [];
  if (slide.layout !== source.layout) {
    issues.push(`The slide is on ${slide.layout}; the English one is on ${source.layout}.`);
  }
  const roles = new Set([...Object.keys(source.content), ...Object.keys(slide.content)]);
  for (const role of roles) {
    const mine = fills(slide.content[role as keyof Content]);
    const theirs = fills(source.content[role as keyof Content]);
    if (mine.length !== theirs.length) {
      issues.push(
        `The role ${role} has ${mine.length} fill(s); the English slide has ${theirs.length}.`,
      );
      continue;
    }
    mine.forEach((fill, at) => {
      const other = theirs[at] as Record<string, unknown> | undefined;
      if (other && 'assetId' in other) {
        if (JSON.stringify(fill) !== JSON.stringify(other)) {
          issues.push(
            `The picture of ${role} is not the English slide's ${String(other.assetId)}.`,
          );
        }
      } else if (!RichText.safeParse(fill).success) {
        issues.push(`The text of ${role}${theirs.length > 1 ? ` ${at + 1}` : ''} is not valid.`);
      }
    });
  }
  if (Boolean(slide.chart) !== Boolean(source.chart)) issues.push('The chart is missing or extra.');
  if (Boolean(slide.table) !== Boolean(source.table)) issues.push('The table is missing or extra.');
  if (slide.table && source.table) {
    const shape = (rows: string[][]) => rows.map((row) => row.length).join();
    if (shape(slide.table.rows) !== shape(source.table.rows)) {
      issues.push("The table's rows and cells are not the English table's.");
    }
  }
  return issues;
}

/** Text that is not yet in the language: English left as it was, or none of its letters. */
function languageFindings(slide: SampleSlide, source: SampleSlide, lang: Lang): SampleFinding[] {
  const out: SampleFinding[] = [];
  if (lang === 'en') return out;
  const english = new Set(words(source));
  const letters = LETTERS[lang];
  for (const text of words(slide)) {
    const count = text.match(WORDS)?.length ?? 0;
    if (english.has(text) && count >= 3) {
      out.push({
        rule: 'S-untranslated',
        severity: 'warning',
        message: `"${text.slice(0, 80)}" is the English text.`,
        elementIds: [],
      });
    } else if (letters && count >= 2 && !letters.test(text)) {
      out.push({
        rule: 'S-script',
        severity: 'warning',
        message: `"${text.slice(0, 80)}" has none of the language's letters.`,
        elementIds: [],
      });
    }
  }
  if (PLACEHOLDER.test(words(slide).join(' '))) {
    out.push({
      rule: 'S-placeholder',
      severity: 'error',
      message: 'The slide holds placeholder words.',
      elementIds: [],
    });
  }
  return out;
}

/** The families a deck's text is drawn in: the theme's, and any a run of the sample names. */
function families(template: Template, sample: readonly SampleSlide[]): string[] {
  const named = new Set<string>();
  for (const pair of Object.values(template.theme.fonts)) {
    named.add(pair.he);
    named.add(pair.latin);
  }
  for (const slide of sample) {
    for (const value of Object.values(slide.content)) {
      for (const fill of fills(value)) {
        if (!isText(fill)) continue;
        for (const paragraph of fill.paragraphs) {
          for (const run of paragraph.runs) if (run.marks?.font) named.add(run.marks.font);
        }
      }
    }
  }
  return [...named];
}

/* ---------------------------------------------------------------- the whole */

/**
 * Builds and checks the sample of a template in a language; with what to draw, a slide each.
 * The sample is published only when it is whole: every slide built, the structure of the
 * English sample kept.
 */
export async function convertTemplate(
  input: TemplateInput,
): Promise<{ result: TemplateResult; built: (Built | undefined)[]; resolve: AssetResolver }> {
  const { lang } = input;
  const resolve = await templatePictures();
  const issues: string[] = [];
  const slides: SlideResult[] = [];
  const built: (Built | undefined)[] = [];
  const parsed = Template.safeParse(input.template);
  const sample = Array.isArray(input.sample) ? (input.sample as SampleSlide[]) : null;
  if (input.error) issues.push(input.error);
  else if (!sample) issues.push('The file does not hold a list of slides.');
  if (!parsed.success) {
    issues.push(`The template is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}.`);
  }
  if (sample && parsed.success) {
    const template = parsed.data;
    if (sample.length < input.english.length) {
      issues.push(
        `The sample has ${sample.length} slides; the English one has ${input.english.length}.`,
      );
    }
    await loadFamilies(families(template, sample));
    if (sample.some((slide) => slide?.chart)) await loadCharts();
    // The slide each is held to: the Hebrew one for a right-to-left language, as its layouts
    // are mirrored the same way; the English one otherwise.
    const rtl = languageDir(lang) === 'rtl';
    for (const [index, slide] of sample.entries()) {
      const source = input.english[index];
      const result: SlideResult = {
        index,
        name: typeof slide?.name === 'string' ? slide.name : '',
        layout: typeof slide?.layout === 'string' ? slide.layout : '',
        findings: [],
        issues: [],
      };
      slides.push(result);
      if (!slide || typeof slide !== 'object' || typeof slide.content !== 'object') {
        result.error = 'Not a slide: { layout, name, content }.';
        built.push(undefined);
        continue;
      }
      result.issues.push(...structureIssues(slide, source));
      let mine: Built | undefined;
      try {
        mine = build(template, slide, lang, 101 + index);
        result.editability = holds(mine);
        const findings: SampleFinding[] = await check(mine, resolve);
        const held = rtl ? input.hebrew?.[index] : source;
        if (held && held.layout === slide.layout) {
          // Built with the same seed, its elements have the same ids as this slide's.
          const against = build(template, held, rtl ? 'he' : 'en', 101 + index);
          const known = new Set((await check(against, resolve)).map(key));
          for (const finding of findings) if (known.has(key(finding))) finding.baseline = true;
        }
        if (source) findings.push(...languageFindings(slide, source, lang));
        result.findings = findings;
      } catch (error) {
        result.error = message(error);
      }
      built.push(mine);
    }
    // Drawn in one deck, as the library shows the sample: the slides' numbers run on.
    const whole = deckFromTemplate(template, { lang, dir: languageDir(lang) });
    whole.assets = { ...whole.assets, ...pictureAssets, ...template.assets };
    whole.slides = built.flatMap((one) => (one ? [one.slide] : []));
    for (const one of built) if (one) one.deck = whole;
    // A sample that is still mostly the English one is not a translation yet.
    if (lang !== 'en') {
      const checked = sample.flatMap((slide, at) =>
        slide && input.english[at] && typeof slide.content === 'object'
          ? words(slide).filter((text) => (text.match(WORDS)?.length ?? 0) >= 3)
          : [],
      );
      const left = slides.flatMap((slide) =>
        slide.findings.filter((f) => f.rule === 'S-untranslated' || f.rule === 'S-script'),
      ).length;
      if (checked.length > 0 && left > checked.length / 4) {
        issues.push(
          `${left} of the sample's ${checked.length} longer texts are still English, or lack the language's letters.`,
        );
      }
    }
  }
  const findings = slides.flatMap((slide) => slide.findings.filter((f) => !f.baseline));
  const slideIssues = slides.flatMap((slide) => [
    ...slide.issues,
    ...(slide.error ? [`Slide ${slide.index + 1} could not be built: ${slide.error}`] : []),
  ]);
  const publishable =
    sample !== null &&
    issues.length === 0 &&
    slideIssues.length === 0 &&
    slides.every((slide) => !slide.error);
  return {
    result: {
      kind: 'template',
      templateId: input.templateId,
      lang,
      revision: input.revision,
      slides,
      sample: publishable ? sample : null,
      langs: { [lang]: { findings, issues: [...issues, ...slideIssues] } },
      issues,
      publishable,
    },
    built,
    resolve,
  };
}
