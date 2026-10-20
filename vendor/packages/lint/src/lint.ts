import {
  rotatedBounds,
  walkElements,
  type Command,
  type Deck,
  type Element,
  type Frame,
  type Slide,
} from '@slidr/model';
import type { SlideMeasurements } from './measure';
import type { Drawn, Item, LintFinding, SlideContext } from './rule';
import { rules } from './rules';
import { drawingsIn } from './visual';

/**
 * `agent`: the rules whose findings go back to the agent after every write (L01–L07, L13, L16, L18;
 * LNT-04, QG-03, QG-04). `all`: every rule, the user's design check included.
 */
export type RuleSet = 'agent' | 'all';

/** The elements a layout draws, each where its frame puts it on the slide. Hidden ones are not drawn. */
function placed(elements: readonly Element[], dx: number, dy: number, out: Item[]): Item[] {
  for (const element of elements) {
    if (element.hidden) continue;
    const frame = { ...element.frame, x: element.frame.x + dx, y: element.frame.y + dy };
    if (element.type === 'group') placed(element.children, frame.x, frame.y, out);
    else if (element.role !== 'logo') {
      out.push({ element, measure: { box: rotatedBounds(frame, element.rotation) } });
    }
  }
  return out;
}

function drawn(elements: readonly Element[], items: readonly Item[]): Drawn {
  const boxes = new Map<string, Frame>(items.map((item) => [item.element.id, item.measure.box]));
  return { items, drawings: drawingsIn(elements, boxes) };
}

/**
 * The design lint of one slide (SPEC 9.2): the model and what its rendering measured in,
 * findings out. Pure and synchronous (LNT-01): it never touches the DOM, so the same slide and
 * measurements always give the same findings, in the order of the rule list.
 */
export function lintSlide(
  deck: Deck,
  slide: Slide,
  measured: SlideMeasurements,
  set: RuleSet = 'all',
): LintFinding[] {
  const items: Item[] = [];
  for (const element of walkElements(slide.elements)) {
    const measure = measured.elements[element.id];
    // No measurement: the element is hidden, or inside a hidden group.
    if (element.type !== 'group' && measure) items.push({ element, measure });
  }
  const tops: Item[] = [];
  for (const element of slide.elements) {
    const measure = measured.elements[element.id];
    if (measure) tops.push({ element, measure });
  }
  const turned = new Set<string>();
  const mark = (elements: readonly Element[], inside: boolean) => {
    for (const element of elements) {
      if (inside) turned.add(element.id);
      if (element.type !== 'group') continue;
      mark(
        element.children,
        inside || element.rotation !== 0 || !!element.flipH || !!element.flipV,
      );
    }
  };
  mark(slide.elements, false);
  const locked = new Set<string>();
  const lock = (elements: readonly Element[], inside: boolean) => {
    for (const element of elements) {
      const held = inside || !!element.locked;
      if (held) locked.add(element.id);
      if (element.type === 'group') lock(element.children, held);
    }
  };
  lock(slide.elements, false);
  const layout = slide.layoutId ? deck.layouts.find((l) => l.id === slide.layoutId) : undefined;
  const decorations = layout?.decorations ?? [];
  const ctx: SlideContext = {
    deck,
    slide,
    ...drawn(slide.elements, items),
    background: slide.background ?? layout?.background ?? deck.theme.background,
    layout: drawn(decorations, placed(decorations, 0, 0, [])),
    tops,
    turned,
    locked,
  };
  const findings: LintFinding[] = [];
  for (const rule of rules) {
    if (set === 'agent' && !rule.agent) continue;
    for (const problem of rule.check(ctx)) {
      const { fix, ...found } = problem;
      // A locked element is left alone by everything in the app (ARR-04), and by a fix too. The
      // finding stays, since the slide is what it is; what goes is the fix that would move,
      // resize or recolour what the user locked. All of it: half of a fix that lines objects up
      // with one that stays where it is would line them up with nothing.
      const allowed = fix && !fix.some((command) => changes(command).some((id) => locked.has(id)));
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        slideId: slide.id,
        ...found,
        ...(allowed ? { fix } : {}),
      });
    }
  }
  return findings;
}

/** The elements a command changes. A new element changes none, but for the group it is put in. */
function changes(command: Command): string[] {
  const named = command as {
    elementId?: string;
    elementIds?: string[];
    parentId?: string;
    groupId?: string;
  };
  return [named.elementId, ...(named.elementIds ?? []), named.parentId, named.groupId].filter(
    (id): id is string => id !== undefined,
  );
}
