import {
  CommandBus,
  createDeck,
  isAssetFileName,
  layoutObjects,
  takenIds,
  walkElements,
  type AssetMeta,
  type Command,
  type CreateDeckOptions,
  type Deck,
  type Direction,
  type Element,
  type Layout,
  type Slide,
} from '@slidr/model';
import { followTheme } from './follow';
import { copyJson, equalJson } from './json';
import { isMaster } from './master';
import { mirrorBackground, mirrorElement, mirrorLayout } from './mirror';
import { layoutCopies, sameDrawing, sameObjects, untouchedObjects } from './objects';
import {
  adoptLayout,
  followPatch,
  matchLayout,
  movesOf,
  relayout,
  sitsOn,
  type Move,
} from './relayout';
import { layoutsFor, type Template } from './template';

/*
 * What a template does to a deck. Like the rest of `compose` in the model, these functions change
 * nothing: they compute commands from the catalogue (ADR-007), and a list given to
 * `CommandBus.batch` is one undo step.
 */

/**
 * The commands that switch a deck to a template (THM-04, SPEC 5.5).
 *
 * - The theme is replaced, so everything that uses tokens follows.
 * - What a slide holds of the old theme as a copy follows too (see `followTheme`): a colour of
 *   the theme inside a CSS fill, the theme's corner radius, the theme's shadow.
 * - The deck gets the template's layouts for its direction, in the template's order.
 * - Each slide moves to the layout `matchLayout` finds for it, and its elements follow their
 *   placeholders there (see `followPatch`). Nothing is deleted: an element whose role has no
 *   placeholder in the new layout stays where it is.
 * - The copies of the old layout's objects on a slide (`Layout.objects`) go, moved or restyled,
 *   and the new layout's come in under everything else (see `objectsFollow`). One the user
 *   wrote in stays.
 * - A slide whose archetype the template does not have keeps its layout, which stays in the deck
 *   after the template's own and follows the new theme through its tokens.
 * - A slide without a layout takes the layout of its archetype when that layout has a place for
 *   everything on it (see `adoptLayout`); otherwise it only follows the theme.
 *
 * Switching back gives the deck back, for everything that followed the template.
 */
export function applyTemplate(deck: Deck, template: Template): Command[] {
  const next = layoutsFor(template, deck.meta.dir);
  const moving: { slideId: string; to: Layout; updates: Command[] }[] = [];
  const adopting: typeof moving = [];
  const kept = new Set<string>();
  const taken = takenIds(deck);
  const gone = new Set<string>();
  for (const slide of deck.slides) {
    const from = deck.layouts.find((layout) => layout.id === slide.layoutId);
    if (!from) {
      const adopted = adoptLayout(slide, next, deck.meta.dir);
      // Such a slide was designed as a whole: it takes no objects of the layout (ADR-094).
      if (adopted) {
        adopting.push({ slideId: slide.id, to: adopted.layout, updates: adopted.updates });
      }
      continue;
    }
    const to = matchLayout(slide, from, next);
    if (to) {
      moving.push({
        slideId: slide.id,
        to,
        updates: [
          ...relayout(slide, from, to, deck.meta.dir),
          ...objectsFollow(slide, from, to, taken, gone),
        ],
      });
    } else kept.add(from.id);
  }

  const commands: Command[] = [];
  for (const asset of layoutAssets(template, next)) {
    if (!deck.assets[asset.id]) commands.push({ type: 'asset.add', asset: copyJson(asset) });
  }
  const themed = !equalJson(deck.theme, template.theme);
  if (themed) commands.push({ type: 'theme.replace', theme: copyJson(template.theme) });

  // The catalogue has no command that reorders layouts, so they are taken out and put in again:
  // the deck ends with the template's layouts in the template's order, whatever it had before.
  const layouts = [...next, ...deck.layouts.filter((layout) => kept.has(layout.id))];
  const replaced = !equalJson(deck.layouts, layouts);
  if (replaced) {
    for (const layout of deck.layouts) {
      if (!kept.has(layout.id)) commands.push({ type: 'layout.remove', layoutId: layout.id });
    }
    next.forEach((layout, index) => commands.push({ type: 'layout.add', layout, index }));
  }
  for (const { slideId, to, updates } of moving) {
    // `layout.remove` took the layout off its slides, so each one is put on its new layout.
    if (replaced) commands.push({ type: 'slide.update', slideId, patch: { layoutId: to.id } });
    commands.push(...updates);
  }
  for (const { slideId, to, updates } of adopting) {
    commands.push({ type: 'slide.update', slideId, patch: { layoutId: to.id } }, ...updates);
  }
  if (themed) {
    const staying = deck.layouts.filter((layout) => kept.has(layout.id));
    // What went with its layout has nothing left to follow.
    const following = followTheme(deck, template.theme, staying).filter(
      (command) => command.type !== 'element.update' || !gone.has(command.elementId),
    );
    commands.push(...following);
  }
  return commands;
}

/**
 * The commands that hand a slide from the objects of one layout to those of another
 * (`Layout.objects`): the copies of the old layout's objects are removed (`layoutCopies`), and
 * copies of the new layout's are put at the bottom of the slide, in its order
 * (`layoutObjects`, with the ids in use in the deck in `taken`). The ids of what goes, and of
 * what is inside it, move from `taken` to `gone`. Nothing changes when both layouts have the
 * same objects: what the slide took away of them stays away.
 */
export function objectsFollow(
  slide: Slide,
  from: Layout | undefined,
  to: Layout,
  taken: Set<string>,
  gone: Set<string>,
): Command[] {
  if (from && sameObjects(from, to)) return [];
  const commands: Command[] = [];
  const copies = layoutCopies(slide, from);
  const theirs = slide.elements.filter((element) => copies.has(element.id));
  if (theirs.length > 0) {
    commands.push({
      type: 'element.remove',
      slideId: slide.id,
      elementIds: theirs.map((element) => element.id),
    });
    for (const element of walkElements(theirs)) {
      gone.add(element.id);
      taken.delete(element.id);
    }
  }
  layoutObjects(to, slide.id, taken).forEach((element, index) =>
    commands.push({ type: 'element.add', slideId: slide.id, element, index }),
  );
  return commands;
}

/**
 * The assets of a template that its layouts draw: a logo, a picture behind a layout. The
 * pictures of its sample slides are not among them, so a deck that takes the template does not
 * carry them. An asset counts when its id appears anywhere in the layouts, as in the model's
 * `assetsUsedBy`.
 *
 * An asset whose `file` is not the name of a file is not among them. A template saved from a
 * deck that was made elsewhere can hold one; it has no file and is never drawn, and `asset.add`
 * refuses it, which would take the whole switch to the template with it.
 */
export function layoutAssets(template: Template, layouts: readonly Layout[]): AssetMeta[] {
  const drawn = JSON.stringify(layouts);
  return Object.values(template.assets ?? {}).filter(
    (asset) => drawn.includes(asset.id) && isAssetFileName(asset.file),
  );
}

/** The room an element keeps around its text: a text box's, and a shape's around what it holds. */
const roomOf = (element: Element) =>
  element.type === 'text' || element.type === 'shape' ? element.padding : undefined;

/** The fields mirroring changes in one element, as an `element.update` patch. */
function mirrorPatch(before: Element, after: Element): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (after.frame.x !== before.frame.x) patch.frame = after.frame;
  if (after.rotation !== before.rotation) patch.rotation = after.rotation;
  if (Boolean(after.flipH) !== Boolean(before.flipH)) patch.flipH = after.flipH ? true : null;
  const room = roomOf(after);
  if (!equalJson(room, roomOf(before))) patch.padding = room;
  return patch;
}

/** What a layout draws that is the template's: all but the deck's master components. */
function drawing(layout: Layout) {
  return {
    background: layout.background,
    placeholders: layout.placeholders,
    decorations: layout.decorations.filter((decoration) => !isMaster(decoration)),
    objects: layout.objects ?? [],
  };
}

/**
 * Whether a deck's layout is still what its template drew. The master components are left out
 * of the question: a footer, a logo and a hidden number are the deck's own, set on the layouts
 * because that is where they live (SLD-04), and they do not make the layout another drawing.
 * Neither does its name, which the app gives in the deck's language.
 */
export function asDrawn(layout: Layout, drawn: Layout | undefined): drawn is Layout {
  return drawn !== undefined && equalJson(drawing(layout), drawing(drawn));
}

/**
 * A deck's layout for the other direction. `drawn` and `drawnTurned` are the layout of the
 * deck's template for the deck's direction and for the other one.
 *
 * While the layout is still what the template drew, the template's own layout for the other
 * direction is taken, so a layout drawn by hand for a direction (`Template.flipped`: a quotation
 * mark, a glow in a corner) comes as it was drawn. The deck's master components go onto it: one
 * the deck left as the template has it is the template's there too, and one the deck set (its
 * footer, its logo, a number it hid) is mirrored with the deck's own setting. A layout that was
 * changed in the deck, or that no template knows, is mirrored as it is.
 */
export function turnedLayout(layout: Layout, drawn?: Layout, drawnTurned?: Layout): Layout {
  const mirrored = mirrorLayout(layout);
  if (!drawnTurned || !asDrawn(layout, drawn)) return mirrored;

  const masters = (decorations: readonly Element[]) =>
    new Map(decorations.filter(isMaster).map((decoration) => [decoration.id, decoration]));
  const theirs = masters(drawn.decorations);
  const mine = masters(layout.decorations);
  const mineTurned = masters(mirrored.decorations);
  const decorations = drawnTurned.decorations.flatMap((decoration) => {
    if (!isMaster(decoration)) return [decoration];
    const own = mine.get(decoration.id);
    // One the deck took away stays away.
    if (!own) return [];
    return [equalJson(own, theirs.get(decoration.id)) ? decoration : mineTurned.get(own.id)!];
  });
  // What the deck added to the layout: its footer.
  const known = new Set(drawnTurned.decorations.map((decoration) => decoration.id));
  for (const [id, decoration] of mineTurned) if (!known.has(id)) decorations.push(decoration);

  const { background: _background, objects: _objects, ...rest } = mirrored;
  return {
    ...rest,
    ...(drawnTurned.background ? { background: drawnTurned.background } : {}),
    placeholders: drawnTurned.placeholders,
    decorations,
    ...(drawnTurned.objects ? { objects: drawnTurned.objects } : {}),
  };
}

const byId = (layouts: Layout[]) => new Map(layouts.map((layout) => [layout.id, layout]));

/**
 * The direction a deck's layouts are drawn for, as far as its template can tell. A deck holds
 * its layouts for one direction only, its own (ADR-023), and nothing in a layout says which: a
 * layout that is still what the template drew for one direction, and not what it drew for the
 * other, does. Undefined when none does (the deck changed them all, or they are the same both
 * ways), and when they do not agree.
 *
 * It is how a direction that was set on the field alone is told from one the layouts have
 * already followed (`followDirection` of the app).
 */
export function layoutsDirection(deck: Deck, template: Template): Direction | undefined {
  const other: Direction = template.dir === 'rtl' ? 'ltr' : 'rtl';
  const own = byId(layoutsFor(template, template.dir));
  const turned = byId(layoutsFor(template, other));
  let found: Direction | undefined;
  for (const layout of deck.layouts) {
    const isOwn = asDrawn(layout, own.get(layout.id));
    if (isOwn === asDrawn(layout, turned.get(layout.id))) continue;
    const dir = isOwn ? template.dir : other;
    if (found !== undefined && found !== dir) return undefined;
    found = dir;
  }
  return found;
}

/**
 * The commands that turn a deck to the other direction, as one step (THM-02): the direction
 * itself, every layout, and what is on the slides.
 *
 * - A layout is mirrored. When the deck's template is given and the layout is still what the
 *   template drew, the template's layout for the new direction is taken instead, with the deck's
 *   master components on it (`turnedLayout`), so a layout corrected by hand for a direction
 *   (`Template.flipped`) comes with its corrections.
 * - An element that sits on its placeholder goes where the placeholder went. Every other element
 *   is mirrored where it stands; nested elements are mirrored inside their group.
 * - An object of the layout that the slide still has as it was (`Layout.objects`) becomes the
 *   object of the new layout: the mirror of it, unless the layout was drawn by hand for the new
 *   direction, and then a copy of what was drawn, in the same place among the elements.
 * - The text itself is not touched: the direction of a paragraph belongs to its language.
 *
 * Turning the deck back gives the deck back.
 */
export function changeDirection(deck: Deck, dir: Direction, template?: Template): Command[] {
  if (dir === deck.meta.dir) return [];
  const commands: Command[] = [{ type: 'deck.setMeta', patch: { dir } }];

  const drawn = byId(template ? layoutsFor(template, deck.meta.dir) : []);
  const drawnTurned = byId(template ? layoutsFor(template, dir) : []);
  const turned = new Map<string, Layout>();
  for (const layout of deck.layouts) {
    const to = turnedLayout(layout, drawn.get(layout.id), drawnTurned.get(layout.id));
    turned.set(layout.id, to);
    commands.push({
      type: 'layout.update',
      layoutId: layout.id,
      patch: {
        background: to.background ?? null,
        placeholders: to.placeholders,
        decorations: to.decorations,
        ...(to.objects ? { objects: to.objects } : {}),
      },
    });
  }
  const taken = takenIds(deck);

  for (const slide of deck.slides) {
    if (slide.background) {
      const background = mirrorBackground(slide.background);
      if (!equalJson(background, slide.background)) {
        commands.push({ type: 'slide.update', slideId: slide.id, patch: { background } });
      }
    }
    const from = deck.layouts.find((layout) => layout.id === slide.layoutId);
    const to = from && turned.get(from.id);
    const moves = from && to ? movesOf(slide, from, to) : new Map<string, Move>();
    const theirs = untouchedObjects(slide, from);
    for (const [index, element] of slide.elements.entries()) {
      const object = to?.objects?.[theirs.get(element.id) ?? -1];
      if (object && !sameDrawing(mirrorElement(element), object)) {
        // The layout was drawn by hand for this direction: the slide takes what was drawn.
        for (const inside of walkElements([element])) taken.delete(inside.id);
        const [copy] = layoutObjects({ ...to, objects: [object] }, slide.id, taken);
        commands.push(
          { type: 'element.remove', slideId: slide.id, elementIds: [element.id] },
          { type: 'element.add', slideId: slide.id, element: copy!, index },
        );
        continue;
      }
      const before = [...walkElements([element])];
      const after = [...walkElements([mirrorElement(element)])];
      const move = moves.get(element.id);
      before.forEach((inside, i) => {
        const patch = mirrorPatch(inside, after[i]!);
        if (move && inside === element) {
          // The placeholder decides where an element that sits on it goes, not the mirror.
          if (sitsOn(element, move.from)) delete patch.frame;
          Object.assign(patch, followPatch(element, move));
        }
        if (Object.keys(patch).length > 0) {
          commands.push({
            type: 'element.update',
            slideId: slide.id,
            elementId: inside.id,
            patch,
          });
        }
      });
    }
  }
  return commands;
}

export interface DeckFromTemplateOptions extends Omit<
  CreateDeckOptions,
  'theme' | 'layouts' | 'slides'
> {
  /** Start with the template's sample slides instead of an empty deck. */
  sample?: boolean;
}

/**
 * A new deck on a template, in the deck's direction: the theme, the layouts of that direction
 * with the assets they draw and, when asked for, the sample slides with theirs.
 */
export function deckFromTemplate(template: Template, options: DeckFromTemplateOptions = {}): Deck {
  const { sample = false, ...rest } = options;
  const deck = createDeck({ ...rest, theme: copyJson(template.theme) });
  if (!sample || !template.sample?.length) {
    deck.layouts = layoutsFor(template, deck.meta.dir);
    for (const asset of layoutAssets(template, deck.layouts))
      deck.assets[asset.id] = copyJson(asset);
    return deck;
  }
  deck.assets = copyJson(template.assets ?? {});
  const { dir } = deck.meta;
  deck.meta.dir = template.dir;
  deck.layouts = copyJson(template.layouts);
  deck.slides = copyJson(template.sample);
  if (dir === template.dir) return deck;
  // The sample is drawn for the template's direction: turn it round, as a deck would be.
  const bus = new CommandBus(deck);
  bus.batch(changeDirection(deck, dir, template));
  return copyJson(bus.deck);
}
