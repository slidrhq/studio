import {
  createElement,
  plainText,
  type Command,
  type Deck,
  type Element,
  type Layout,
  type Paragraph,
  type TextElement,
} from '@slidr/model';
import { seatAlign, textDirection } from './align';

/*
 * The master components of a deck (SLD-04): what every slide shows without holding it. They
 * are elements a layout draws, known by their role: the slide's number, the deck's footer, and
 * the logo (`role: 'logo'`, which the app's template area replaces and hides). Like the rest of
 * this package, these functions change nothing: they compute commands of the catalogue, and a
 * list given to `CommandBus.batch` is one undo step.
 *
 * No field of the schema is new. The number is a text of role `slideNumber`, in which the
 * renderer writes the number of the slide it draws; the footer is a text of role `footer`,
 * which the renderer leaves out on a slide whose own footer says something.
 */

type Role = 'slideNumber' | 'footer';

const of = (role: Role) => (element: Element) => element.role === role;

/**
 * Whether a decoration of a layout is a master component: what the deck sets for itself on the
 * layouts of its template (its footer, its logo in place of the mark, a number it hid).
 */
export function isMaster(decoration: Element): boolean {
  return (
    decoration.role === 'slideNumber' || decoration.role === 'footer' || decoration.role === 'logo'
  );
}

const update = (layout: Layout, decorations: Element[]): Command => ({
  type: 'layout.update',
  layoutId: layout.id,
  patch: { decorations },
});

/** The layouts that draw the slide's number. */
export function slideNumberLayouts(deck: Deck): Layout[] {
  return deck.layouts.filter((layout) => layout.decorations.some(of('slideNumber')));
}

/** True when every slide number the layouts draw is hidden. */
export function slideNumberHidden(deck: Deck): boolean {
  const numbers = deck.layouts.flatMap((layout) => layout.decorations.filter(of('slideNumber')));
  return numbers.length > 0 && numbers.every((number) => number.hidden);
}

/** Shows the slide number on every layout that draws one, or hides it. Its place is kept. */
export function showSlideNumber(deck: Deck, shown: boolean): Command[] {
  return slideNumberLayouts(deck).flatMap((layout) => {
    if (layout.decorations.every((d) => !of('slideNumber')(d) || !d.hidden === shown)) return [];
    return [
      update(
        layout,
        layout.decorations.map((decoration) => {
          if (!of('slideNumber')(decoration)) return decoration;
          const { hidden: _hidden, ...rest } = decoration;
          return shown ? rest : { ...rest, hidden: true };
        }),
      ),
    ];
  });
}

/** The layouts that have a place for a footer: a footer placeholder, or a footer they draw. */
export function footerLayouts(deck: Deck): Layout[] {
  return deck.layouts.filter(
    (layout) =>
      layout.placeholders.some((p) => p.role === 'footer') || layout.decorations.some(of('footer')),
  );
}

const drawnFooter = (layout: Layout) => {
  const footer = layout.decorations.find(of('footer'));
  return footer?.type === 'text' ? footer : undefined;
};

/** The footer the layouts draw on every slide; empty when there is none. */
export function deckFooter(deck: Deck): string {
  for (const layout of deck.layouts) {
    const footer = drawnFooter(layout);
    if (footer) return plainText(footer.content);
  }
  return '';
}

/**
 * A footer for a layout: in the frame, the style and on the side of its footer placeholder.
 *
 * The words are laid out as the app lays out all the text it sets (`textDirection`): an English
 * company name in a Hebrew deck reads left to right, with its full stop after its last letter.
 * And they are seated like the text of a placeholder (`seatAlign`): on the side of the box the
 * layout means, whichever way they read.
 */
function footerOf(layout: Layout, text: string, dir: Deck['meta']['dir']): TextElement | undefined {
  const seat = layout.placeholders.find((p) => p.role === 'footer');
  const drawn = drawnFooter(layout);
  const [first] = drawn?.content.paragraphs ?? [];
  // The side of the box: the one the layout seats a footer on; without a seat, the one the words
  // that are there stand on.
  const side = seat?.align ?? (first ? seatAlign(first.align, first, dir) : 'start');
  const words = (look: Partial<Paragraph>): Paragraph => {
    const paragraph = { ...look, dir: textDirection(text, dir), align: side, runs: [{ text }] };
    return { ...paragraph, align: seatAlign(side, paragraph, dir) };
  };
  // The one that is there keeps its look, and takes the new words.
  if (drawn) return { ...drawn, content: { paragraphs: [words(first ?? {})] } };
  if (!seat) return undefined;
  return createElement.text({
    id: `d_footer_${layout.id}`,
    name: 'footer',
    role: 'footer',
    frame: { ...seat.frame },
    vAlign: seat.vAlign ?? 'top',
    content: { paragraphs: [words(seat.styleRef ? { styleRef: seat.styleRef } : {})] },
  });
}

/**
 * Sets the footer every slide shows: on each layout that has a place for a footer, a text the
 * layout draws there. An empty text takes the footer away. A slide that wrote a footer of its
 * own keeps showing its own.
 */
export function setDeckFooter(deck: Deck, text: string): Command[] {
  const words = text.trim();
  return footerLayouts(deck).flatMap((layout) => {
    const drawn = drawnFooter(layout);
    if (drawn ? plainText(drawn.content) === words : words === '') return [];
    const rest = layout.decorations.filter((decoration) => !of('footer')(decoration));
    const footer = words ? footerOf(layout, words, deck.meta.dir) : undefined;
    return [update(layout, footer ? [...rest, footer] : rest)];
  });
}

/** What the master components of a deck are set to: enough to give them to other layouts. */
export interface MasterState {
  footer: string;
  /** The user hid the slide number. */
  numberHidden: boolean;
}

export function masterState(deck: Deck): MasterState {
  return { footer: deckFooter(deck), numberHidden: slideNumberHidden(deck) };
}

/**
 * The commands that give a deck the master components it had before its layouts were replaced
 * by a switch of template: the footer the user wrote, and a slide number they had hidden.
 */
export function restoreMaster(deck: Deck, before: MasterState): Command[] {
  const footer = before.footer ? setDeckFooter(deck, before.footer) : [];
  if (!before.numberHidden) return footer;
  // The two patch the decorations of the same layouts: the second starts from what the first
  // leaves, and its patch is the one that goes out for a layout both touch.
  const patched = new Map<string, Element[]>();
  for (const command of footer) {
    if (command.type === 'layout.update' && command.patch.decorations) {
      patched.set(command.layoutId, command.patch.decorations);
    }
  }
  const after: Deck = {
    ...deck,
    layouts: deck.layouts.map((layout) => {
      const decorations = patched.get(layout.id);
      return decorations ? { ...layout, decorations } : layout;
    }),
  };
  const hide = showSlideNumber(after, false);
  const both = new Set(hide.map((c) => (c.type === 'layout.update' ? c.layoutId : '')));
  return [...footer.filter((c) => c.type !== 'layout.update' || !both.has(c.layoutId)), ...hide];
}
