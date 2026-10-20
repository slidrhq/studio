import { locateElement, walkElements, type Command, type Deck, type Slide } from '@slidr/model';

/**
 * What an agent session works on (SPEC 11.2, 11.7). The same shape as `Scope` in the app's
 * agent client, so a session's scope passes through unchanged.
 */
export type SessionScope =
  | { kind: 'deck' }
  | { kind: 'slide'; slideId: string }
  | { kind: 'object'; slideId: string; elementIds: readonly string[] }
  /** An HTML import session (SPEC 13). It has the rights of a deck session. */
  | { kind: 'import'; file?: string };

export type ScopeKind = SessionScope['kind'];

/**
 * Whether a tool can be called in a session. Tools list the scopes of the catalogue
 * (SPEC 11.4: D, S, O); an import session gets every deck tool, plus the tools that name
 * `import` themselves.
 */
export function availableIn(scopes: readonly ScopeKind[], kind: ScopeKind): boolean {
  return scopes.includes(kind) || (kind === 'import' && scopes.includes('deck'));
}

export function describeScope(scope: SessionScope): string {
  switch (scope.kind) {
    case 'deck':
      return 'a deck session';
    case 'import':
      return 'an import session';
    case 'slide':
      return `a slide session, limited to slide "${scope.slideId}"`;
    case 'object':
      return `an object session, limited to element(s) ${scope.elementIds
        .map((id) => `"${id}"`)
        .join(', ')} on slide "${scope.slideId}"`;
  }
}

/** The elements an object session may change: its own and everything inside them. */
function writableElements(slide: Slide | undefined, elementIds: readonly string[]): Set<string> {
  const ids = new Set(elementIds);
  if (!slide) return ids;
  for (const element of walkElements(slide.elements)) {
    if (ids.has(element.id) && element.type === 'group') {
      for (const inside of walkElements(element.children)) ids.add(inside.id);
    }
  }
  return ids;
}

/**
 * The elements a write replaces in place: removed and, in the same write, added again under
 * the same id, in the same parent and at the same place in the layer order. To an object
 * session that is a change of its element (`element.update` cannot change `type` or
 * `children`), not a deletion and an addition: what the session works on still exists, under
 * the id it knows. `element.replace` says the same in one command, and is what
 * `element_convert` writes; the pair is still read, for a write that spells it out.
 */
function replacedInPlace(commands: readonly Command[], slide: Slide | undefined): Set<string> {
  const ids = new Set<string>();
  if (!slide) return ids;
  const removed = new Set(
    commands.flatMap((c) => (c.type === 'element.remove' ? c.elementIds : [])),
  );
  for (const command of commands) {
    if (command.type !== 'element.add' || !removed.has(command.element.id)) continue;
    const was = locateElement(slide.elements, command.element.id);
    if (was && was.parent?.id === command.parentId && was.index === command.index) {
      ids.add(command.element.id);
    }
  }
  return ids;
}

/**
 * The scope guard for writes (SPEC 11.4): undefined when every command stays inside the
 * session's scope, otherwise why not. Reads are never limited. A deck or import session may
 * do anything. A slide session may change only its slide and what is on it. An object session
 * may change only its elements (and their children): their fields, their text, their own
 * animation steps, and what kind of element they are (see `replacedInPlace`). Registering an
 * asset is allowed everywhere: it changes no slide, and the image tools need it in every
 * scope.
 */
export function checkWrite(
  scope: SessionScope,
  commands: readonly Command[],
  deck: Deck,
): string | undefined {
  if (scope.kind === 'deck' || scope.kind === 'import') return undefined;
  const where = describeScope(scope);
  const slide = deck.slides.find((s) => s.id === scope.slideId);
  const writable = scope.kind === 'object' ? writableElements(slide, scope.elementIds) : undefined;
  const replaced = writable ? replacedInPlace(commands, slide) : undefined;

  for (const command of commands) {
    if (command.type === 'asset.add') continue;
    if (!('slideId' in command)) {
      return `${command.type} changes the whole deck, which is outside ${where}.`;
    }
    if (command.slideId !== scope.slideId) {
      return `This would change slide "${command.slideId}", which is outside ${where}.`;
    }
    if (!writable) continue;

    if (command.type === 'element.update' || command.type === 'text.set') {
      if (!writable.has(command.elementId)) {
        return `This would change element "${command.elementId}", which is outside ${where}.`;
      }
    } else if (command.type === 'slide.setTimeline') {
      // Steps of other elements must stay exactly as they are, in the same order.
      const others = (steps: readonly { elementId: string }[]) =>
        JSON.stringify(steps.filter((step) => !writable.has(step.elementId)));
      if (others(command.timeline) !== others(slide?.timeline ?? [])) {
        return `This would change animation steps of other elements, which is outside ${where}.`;
      }
    } else if (command.type === 'element.remove') {
      const outside = command.elementIds.find((id) => !writable.has(id));
      if (outside) {
        return `This would remove element "${outside}", which is outside ${where}.`;
      }
      const gone = command.elementIds.find((id) => !replaced?.has(id));
      if (gone) {
        return `This would delete element "${gone}". In ${where} an element may be replaced by one that keeps its id, in the same place, not deleted.`;
      }
    } else if (command.type === 'element.add') {
      if (!replaced?.has(command.element.id)) {
        return `This would add element "${command.element.id}". In ${where} an element may be added only in place of one of its own, under the same id.`;
      }
    } else if (command.type === 'element.replace') {
      if (!writable.has(command.elementId)) {
        return `This would replace element "${command.elementId}", which is outside ${where}.`;
      }
      // The same rule as for a removal and an addition: what the session works on still
      // exists afterwards, as one element under the id it knows.
      const [only] = command.elements;
      if (command.elements.length !== 1 || only?.id !== command.elementId) {
        return `This would replace element "${command.elementId}" by elements under other ids. In ${where} an element may be replaced only by one element that keeps its id.`;
      }
    } else {
      return `${command.type} is not allowed in ${where}: it may change only the fields, text and animation of its elements.`;
    }
  }
  return undefined;
}
