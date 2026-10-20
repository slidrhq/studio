/**
 * The Markdown subset of `text_set` (ADR-011):
 *
 * - Each line is a paragraph. Blank lines only separate; spacing is a paragraph property.
 *   A line that ends with `\` continues the paragraph on a new line (a line break in the run).
 * - `- `, `* ` or `+ ` starts a bullet item, `1. ` or `1) ` a numbered one. Indenting an item
 *   more than the one above nests it one level (up to 8); a tab counts as four spaces.
 * - Inline: `**bold**`, `*italic*` or `_italic_`, `~~strike~~`, `==highlight==`,
 *   `[text](url)`. They nest. `\` before a punctuation mark makes it literal.
 * - Nothing else: headings, quotes, code and tables are plain text. The look of a paragraph
 *   comes from its style (`styleRef`), not from Markdown.
 */
import type { Color, Direction, Marks, Paragraph, RichText, Run, TextStyleRef } from '@slidr/model';

export interface MarkdownOptions {
  /** The deck's direction: the default for paragraphs. */
  deckDir: Direction;
  /**
   * Forces one direction on every paragraph. Without it, a paragraph takes the deck's direction
   * unless it has letters only of the other direction (English text in a Hebrew deck).
   */
  dir?: Paragraph['dir'];
  /** The text being replaced. New paragraphs take its paragraph and character formatting. */
  previous?: RichText;
  styleRef?: TextStyleRef;
  align?: Paragraph['align'];
  /** Alignment when neither `align` nor `previous` gives one. */
  defaultAlign?: Paragraph['align'];
}

export const HIGHLIGHT: Color = { token: 'accent', alpha: 0.35 };

const PAIRS: readonly (readonly [string, Marks])[] = [
  ['**', { weight: 700 }],
  ['~~', { strike: true }],
  ['==', { highlight: HIGHLIGHT }],
  ['*', { italic: true }],
  ['_', { italic: true }],
];

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

interface Link {
  text: string;
  url: string;
  end: number;
}

/** `[text](url)` at `start`; the url has no spaces. */
function matchLink(src: string, start: number): Link | undefined {
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') {
      j++;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']' && --depth === 0) {
      const match = /^\(([^\s()]+)\)/.exec(src.slice(j + 1));
      if (!match) return undefined;
      return { text: src.slice(start + 1, j), url: match[1]!, end: j + 1 + match[0].length };
    }
  }
  return undefined;
}

/** Where the delimiter that closes the one opened at `start` begins, or -1. */
function findCloser(src: string, start: number, delim: string): number {
  const after = src[start + delim.length];
  if (after === undefined || SPACE.test(after)) return -1;
  if (delim === '_' && start > 0 && WORD.test(src[start - 1]!)) return -1;

  for (let j = start + delim.length + 1; j < src.length; j++) {
    const ch = src[j]!;
    if (ch === '\\') {
      j++;
      continue;
    }
    if (ch === '[') {
      const link = matchLink(src, j);
      if (link) {
        j = link.end - 1;
        continue;
      }
    }
    if (delim === '*' && src.startsWith('**', j)) {
      // Bold inside italic: skip over it whole.
      const inner = findCloser(src, j, '**');
      if (inner > 0) {
        j = inner + 1;
        continue;
      }
    }
    if (!src.startsWith(delim, j) || SPACE.test(src[j - 1]!)) continue;
    if (delim === '_' && j + 1 < src.length && WORD.test(src[j + 1]!)) continue;
    if (delim === '**') {
      // `***x***`: the bold closes on the last two stars, the inner one closes the italic.
      let end = j;
      while (src[end] === '*') end++;
      return end - 2;
    }
    return j;
  }
  return -1;
}

function pushRun(out: Run[], text: string, marks: Marks | undefined): void {
  if (!text) return;
  const last = out.at(-1);
  if (last && JSON.stringify(last.marks ?? {}) === JSON.stringify(marks ?? {})) {
    last.text += text;
    return;
  }
  out.push(marks && Object.keys(marks).length > 0 ? { text, marks } : { text });
}

/** The runs of one paragraph's inline Markdown. */
export function parseInline(src: string, base?: Marks): Run[] {
  const out: Run[] = [];
  const walk = (text: string, marks: Marks | undefined) => {
    let plain = '';
    const flush = () => {
      pushRun(out, plain, marks);
      plain = '';
    };
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '\\' && i + 1 < text.length && PUNCTUATION.test(text[i + 1]!)) {
        plain += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '[') {
        const link = matchLink(text, i);
        if (link) {
          flush();
          walk(link.text, { ...marks, link: link.url });
          i = link.end;
          continue;
        }
      }
      const pair = PAIRS.find(([delim]) => text.startsWith(delim, i));
      if (pair) {
        const [delim, added] = pair;
        const close = findCloser(text, i, delim);
        if (close > 0) {
          flush();
          walk(text.slice(i + delim.length, close), { ...marks, ...added });
          i = close + delim.length;
        } else {
          plain += delim;
          i += delim.length;
        }
        continue;
      }
      plain += ch;
      i++;
    }
    flush();
  };
  walk(src, base);
  return out;
}

const RTL_LETTER =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LETTER = /\p{L}/gu;

/**
 * The deck's direction, unless the text has letters and none of them belongs to that
 * direction: then the other one.
 */
export function paragraphDir(text: string, deckDir: Direction): Direction {
  const letters = text.match(LETTER);
  if (!letters) return deckDir;
  const rtl = letters.some((letter) => RTL_LETTER.test(letter));
  const ltr = letters.some((letter) => !RTL_LETTER.test(letter));
  if (deckDir === 'rtl') return rtl ? 'rtl' : 'ltr';
  return ltr ? 'ltr' : 'rtl';
}

/** Marks every run of a paragraph shares: the paragraph's look, not a word's emphasis. */
function sharedMarks(paragraph: Paragraph | undefined): Marks | undefined {
  const runs = paragraph?.runs ?? [];
  if (runs.length === 0) return undefined;
  const shared: Record<string, unknown> = {};
  const first = (runs[0]!.marks ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(first)) {
    if (key === 'link') continue;
    const same = runs.every(
      (run) =>
        JSON.stringify((run.marks as Record<string, unknown> | undefined)?.[key]) ===
        JSON.stringify(value),
    );
    if (same) shared[key] = value;
  }
  return Object.keys(shared).length > 0 ? shared : undefined;
}

interface Line {
  text: string;
  list?: { kind: 'bullet' | 'number'; indent: number };
}

const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;

function splitLines(markdown: string): Line[] {
  const lines: Line[] = [];
  let continued: Line | undefined;
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    let line: Line;
    if (continued) {
      line = continued;
      line.text += `\n${raw.trim()}`;
    } else if (!raw.trim()) {
      continue;
    } else {
      const item = ITEM.exec(raw);
      line = item
        ? {
            text: item[3]!,
            list: {
              kind: /\d/.test(item[2]!) ? 'number' : 'bullet',
              indent: item[1]!.replace(/\t/g, '    ').length,
            },
          }
        : { text: raw.trim() };
      lines.push(line);
    }
    // A backslash at the end of the line (not itself escaped) continues the paragraph.
    const trailing = /(\\+)$/.exec(line.text);
    if (trailing && trailing[1]!.length % 2 === 1) {
      line.text = line.text.slice(0, -1);
      continued = line;
    } else {
      continued = undefined;
    }
  }
  return lines;
}

/** Rich text from the Markdown subset described at the top of this file. */
export function markdownToRichText(markdown: string, options: MarkdownOptions): RichText {
  const previous = options.previous?.paragraphs ?? [];
  const plainTemplate = previous.find((p) => !p.list) ?? previous[0];
  const listTemplate = previous.find((p) => p.list) ?? plainTemplate;

  const paragraphs: Paragraph[] = [];
  const levels: number[] = [];
  for (const line of splitLines(markdown)) {
    const template = line.list ? listTemplate : plainTemplate;
    const runs = parseInline(line.text, sharedMarks(template));
    const text = runs.map((r) => r.text).join('');

    const paragraph: Paragraph = {
      dir: options.dir ?? paragraphDir(text, options.deckDir),
      align: options.align ?? template?.align ?? options.defaultAlign ?? 'start',
      runs,
    };
    if (template?.lineHeight !== undefined) paragraph.lineHeight = template.lineHeight;
    if (template?.spaceBefore !== undefined) paragraph.spaceBefore = template.spaceBefore;
    if (template?.spaceAfter !== undefined) paragraph.spaceAfter = template.spaceAfter;
    const styleRef = options.styleRef ?? template?.styleRef;
    if (styleRef) paragraph.styleRef = styleRef;

    if (line.list) {
      const { indent, kind } = line.list;
      while (levels.length > 0 && indent < levels.at(-1)!) levels.pop();
      if (levels.length === 0 || indent > levels.at(-1)!) levels.push(indent);
      const level = Math.min(levels.length - 1, 8);
      const like = template?.list;
      paragraph.list = {
        kind,
        level,
        ...(like?.glyph && like.kind === kind ? { glyph: like.glyph } : {}),
        ...(like?.color ? { color: like.color } : {}),
      };
    } else {
      levels.length = 0;
      if (template?.indent !== undefined && !template.list) paragraph.indent = template.indent;
    }
    paragraphs.push(paragraph);
  }
  return { paragraphs };
}
