import { slideArchetype, type Archetype } from '@slidr/model';
import { slideArea } from '../geometry';
import type { Rule, SlideContext } from '../rule';
import { hasPhoto, showsVisual } from '../visual';

/**
 * Slides that may be text alone. The title and text layouts deliberately leave room open.
 * A big number is itself the visual of its slide (SPEC 9.4, step 1).
 */
const TEXT_ARCHETYPES: readonly Archetype[] = ['quote', 'section', 'title', 'text', 'bigNumber'];

function hasVisual(ctx: SlideContext): boolean {
  // A photo behind the text is the picture of a full-image slide.
  if (hasPhoto(ctx.background)) return true;
  const area = slideArea(ctx.deck);
  // The cards, the nodes and the drawings of the slide's layout are part of the picture: a
  // slide that fills a layout as the template drew it has the visual the template gave it.
  return showsVisual(ctx, area) || showsVisual(ctx.layout, area);
}

/** L16 (QG-04): a slide with content but no visual element, unless its archetype is textual. */
export const L16: Rule = {
  id: 'L16',
  severity: 'warning',
  agent: true,
  check(ctx) {
    const archetype = slideArchetype(ctx.deck, ctx.slide);
    if (archetype && TEXT_ARCHETYPES.includes(archetype)) return [];
    // An empty slide is L07's finding.
    if (ctx.items.length === 0 || hasVisual(ctx)) return [];
    return [
      {
        elementIds: [],
        message:
          'The slide has no visual element: no image, chart, icon, table or shape that carries the message, only text. Add one. If the slide is meant to be text alone, use a title, text, quote, section or bigNumber layout.',
      },
    ];
  },
};
