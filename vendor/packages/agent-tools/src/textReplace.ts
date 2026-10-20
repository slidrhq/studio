import { plainText, type Marks, type Paragraph, type RichText, type Run } from '@slidr/model';

/*
 * A stretch of a text, found by what it says (ADR-072): what `text_replace` changes, and how the
 * app counts the stretch the user selected. Both count the same way, so the `occurrence` the
 * context block reports is the one the tool finds.
 */

/**
 * Where `find` appears in a text written as `plainText` writes it (paragraphs joined by `\n`):
 * left to right, each search starting after the last match.
 */
export function appearances(text: string, find: string): number[] {
  const found: number[] = [];
  if (!find) return found;
  for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + find.length)) {
    found.push(at);
  }
  return found;
}

/**
 * Which appearance of `find` the stretch that starts at `offset` is, counted from 1: the last
 * one that starts there or before it.
 */
export function occurrenceAt(text: string, find: string, offset: number): number {
  return Math.max(1, appearances(text, find).filter((at) => at <= offset).length);
}

const sameMarks = (a: Marks | undefined, b: Marks | undefined) =>
  JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

function withMarks(text: string, marks: Marks | undefined): Run {
  return marks && Object.keys(marks).length > 0 ? { text, marks } : { text };
}

/** Joins neighbouring runs of the same formatting, and drops empty ones. */
function tidy(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out.at(-1);
    if (last && sameMarks(last.marks, run.marks)) {
      out[out.length - 1] = withMarks(last.text + run.text, last.marks);
    } else out.push(run);
  }
  return out;
}

/** Characters `from` to `to` of a paragraph, written anew; `from` is before its end. */
function changeParagraph(
  paragraph: Paragraph,
  from: number,
  to: number,
  change: { replace?: string; marks?: Marks },
): Paragraph {
  const runs: Run[] = [];
  let start = 0;
  for (const run of paragraph.runs) {
    const end = start + run.text.length;
    const before = run.text.slice(0, Math.max(0, from - start));
    const inside = run.text.slice(Math.max(0, from - start), Math.max(0, to - start));
    const after = run.text.slice(Math.max(0, to - start));
    if (before) runs.push(withMarks(before, run.marks));
    if (from >= start && from < end && change.replace !== undefined) {
      // The new words take the formatting of the first character they replace.
      runs.push(withMarks(change.replace, { ...run.marks, ...change.marks }));
    }
    if (inside && change.replace === undefined) {
      runs.push(withMarks(inside, { ...run.marks, ...change.marks }));
    }
    if (after) runs.push(withMarks(after, run.marks));
    start = end;
  }
  return { ...paragraph, runs: tidy(runs) };
}

export type ReplaceOutcome =
  | { ok: true; content: RichText }
  | { ok: false; reason: 'missing'; found: number }
  | { ok: false; reason: 'paragraphs' };

/**
 * The text with the `occurrence`th appearance of `find` replaced by `replace`, or given `marks`,
 * or both. The rest of the text keeps every run and every mark it had. A stretch that runs from
 * one paragraph into the next is refused: what becomes of the paragraph break is not this
 * function's to guess.
 */
export function replaceInText(
  content: RichText,
  find: string,
  occurrence: number,
  change: { replace?: string; marks?: Marks },
): ReplaceOutcome {
  const found = appearances(plainText(content), find);
  const at = found[occurrence - 1];
  if (at === undefined) return { ok: false, reason: 'missing', found: found.length };
  let start = 0;
  for (const [i, paragraph] of content.paragraphs.entries()) {
    const length = paragraph.runs.reduce((sum, run) => sum + run.text.length, 0);
    if (at <= start + length) {
      if (at + find.length > start + length) return { ok: false, reason: 'paragraphs' };
      const paragraphs = [...content.paragraphs];
      paragraphs[i] = changeParagraph(paragraph, at - start, at - start + find.length, change);
      return { ok: true, content: { ...content, paragraphs } };
    }
    start += length + 1;
  }
  return { ok: false, reason: 'missing', found: found.length };
}
