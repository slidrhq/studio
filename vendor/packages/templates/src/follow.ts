import {
  mapCssColors,
  parseCssColor,
  themeColorCss,
  walkElements,
  type Background,
  type ColorToken,
  type Command,
  type CssRgba,
  type Deck,
  type Element,
  type Fill,
  type Layout,
  type Theme,
} from '@slidr/model';
import { copyJson, equalJson } from './json';

/*
 * What a deck holds of its theme as a copy (THM-04). A colour token follows a theme by itself.
 * Three things of a theme have no token, and an element that takes one holds the value it had
 * when the element was made:
 *
 * - a colour inside a `css` fill: a glow written as `color-mix(var(--color-primary) ...)` is
 *   kept as the CSS the browser computed, with the colour as numbers (SPEC 5.9); a shape has
 *   such a fill, and so have the accent along one side of it and the cell of a table;
 * - the corner radius (`var(--radius)` of a card becomes `effects.radius: 30`);
 * - the shadow (the shadow tool offers the theme's, and the element takes a copy).
 *
 * A deck built on one template and switched to another kept all three: glows in the colours of
 * the old template on the new one, where text could no longer be read on them, and round cards
 * on a template that draws none. So a switch hands them over: a value that is the old theme's is
 * taken to have come from the theme, as a slide's background that is a variant of the theme is
 * (`variantCommands` of the app), and follows it.
 */

/** Tokens in the order they win when two hold one colour, as the conversion snaps (SPEC 11.5). */
const ORDER: readonly ColorToken[] = [
  'primary',
  'secondary',
  'accent',
  'text',
  'muted',
  'bg',
  'surface',
];

/** Rendering and parsing land on fractions of a step: colours this close are one colour. */
const sameRgb = (a: CssRgba, b: CssRgba) =>
  Math.abs(a.r - b.r) < 0.5 && Math.abs(a.g - b.g) < 0.5 && Math.abs(a.b - b.b) < 0.5;

/**
 * A CSS value with every colour of the theme written as the theme's variable, so that it
 * follows this theme and any after it. A translucent colour keeps its alpha; one that is not
 * drawn at all (the clear end of a glow) is no colour of anything and stays.
 */
export function linkCssToTheme(value: string, theme: Theme): string {
  const themed = ORDER.flatMap((token) => {
    const color = parseCssColor(theme.colors[token]);
    return color && color.a === 1 ? [{ token, color }] : [];
  });
  return mapCssColors(value, (color) => {
    if (color.a <= 0) return undefined;
    const of = themed.find((t) => sameRgb(t.color, color));
    return of && themeColorCss(of.token, color.a);
  });
}

function linkFill<F extends Fill | undefined>(fill: F, theme: Theme): F {
  if (fill?.kind !== 'css') return fill;
  const value = linkCssToTheme(fill.value, theme);
  return value === fill.value ? fill : ({ kind: 'css', value } as F);
}

function linkBackground(background: Background, theme: Theme): Background {
  const fill = linkFill(background.fill, theme);
  const overlay = linkFill(background.overlay, theme);
  if (fill === background.fill && overlay === background.overlay) return background;
  return { ...background, fill, ...(overlay ? { overlay } : {}) };
}

/** The fields of one element that follow the theme, as an `element.update` patch. */
function themePatch(element: Element, from: Theme, to: Theme): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (element.type === 'shape') {
    const fill = linkFill(element.fill, from);
    if (fill !== element.fill) patch.fill = fill;
    // The coloured side of a card is a fill of its own, and holds the theme the same way.
    const { accent } = element;
    const side = accent && linkFill(accent.fill, from);
    if (accent && side !== accent.fill) patch.accent = { ...accent, fill: side };
  }
  if (element.type === 'table') {
    let changed = false;
    const cells = element.cells.map((row) =>
      row.map((cell) => {
        const fill = linkFill(cell.fill, from);
        if (fill === cell.fill) return cell;
        changed = true;
        return { ...cell, fill };
      }),
    );
    if (changed) patch.cells = cells;
  }
  const { effects } = element;
  if (effects) {
    const radius = effects.radius === from.radius && to.radius !== from.radius;
    const shadow =
      effects.shadow !== undefined &&
      equalJson(effects.shadow, from.shadow) &&
      !equalJson(from.shadow, to.shadow);
    if (radius || shadow) {
      patch.effects = {
        ...effects,
        ...(radius ? { radius: to.radius } : {}),
        ...(shadow ? { shadow: copyJson(to.shadow) } : {}),
      };
    }
  }
  return patch;
}

/** An element of a layout, and what is inside it, as it follows the theme. */
function followed(element: Element, from: Theme, to: Theme): Element {
  const next = { ...element, ...themePatch(element, from, to) };
  if (next.type !== 'group') return next;
  return { ...next, children: next.children.map((child) => followed(child, from, to)) };
}

/**
 * The commands that hand what a deck holds of its theme as a copy to the theme `to`: on every
 * slide, and on the layouts of `layouts`, which are the ones the deck keeps through the switch.
 */
export function followTheme(deck: Deck, to: Theme, layouts: readonly Layout[] = []): Command[] {
  const from = deck.theme;
  const commands: Command[] = [];
  for (const layout of layouts) {
    const background = layout.background && linkBackground(layout.background, from);
    const decorations = layout.decorations.map((decoration) => followed(decoration, from, to));
    const objects = layout.objects?.map((object) => followed(object, from, to));
    const patch = {
      ...(background !== layout.background ? { background } : {}),
      ...(equalJson(decorations, layout.decorations) ? {} : { decorations }),
      ...(objects && !equalJson(objects, layout.objects) ? { objects } : {}),
    };
    if (Object.keys(patch).length > 0) {
      commands.push({ type: 'layout.update', layoutId: layout.id, patch });
    }
  }
  for (const slide of deck.slides) {
    const background = slide.background && linkBackground(slide.background, from);
    if (background !== slide.background) {
      commands.push({ type: 'slide.update', slideId: slide.id, patch: { background } });
    }
    for (const element of walkElements(slide.elements)) {
      const patch = themePatch(element, from, to);
      if (Object.keys(patch).length === 0) continue;
      commands.push({ type: 'element.update', slideId: slide.id, elementId: element.id, patch });
    }
  }
  return commands;
}
