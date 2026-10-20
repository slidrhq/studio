import type { Archetype } from '@slidr/model';

/**
 * What each archetype of the model is (SPEC 9.1). The keys are the values the agent writes in
 * `data-archetype` and reads in the outline; an archetype added to the model does not compile
 * until it is described here.
 */
export const ARCHETYPES: Record<Archetype, string> = {
  hero: 'the opening slide: a display title, a line under it, a strong image or background',
  section: 'a section divider: a few words that open a new part of the deck',
  title: 'a single title at the top of the slide',
  bigNumber: 'one big number or statistic, with a short line that says what it means',
  quote: 'a quotation and who said it',
  text: 'a title and body text, with no image',
  textImage: 'text beside an image, in two columns',
  fullImage: 'a full-bleed image with a short text over it',
  cards: 'a grid of 3, 4 or 6 cards',
  timeline: 'events along a time axis',
  process: 'the steps of a process, in order',
  comparison: 'two or three things side by side',
  chart: 'a chart as the focus of the slide',
  table: 'a table',
  team: 'people: pictures, names, roles',
  closing: 'the closing slide, or a call to action',
  blank: 'a free composition that is none of the others; rarely the right choice',
};

const archetypeList = Object.entries(ARCHETYPES)
  .map(([name, what]) => `- \`${name}\`: ${what}`)
  .join('\n');

/**
 * Module 2 (SPEC 11.6): the design guidelines of SPEC 9.1 in full, and the per-slide checklist
 * of SPEC 9.4. The same text in every session. The numbers are the SPEC's; the reasons were
 * added so the agent can judge the cases the numbers do not settle. WG7-T06 tunes this text
 * against the evaluation set.
 */
export const DESIGN = `## Design guidelines

A slide is read in a few seconds by someone also listening to a speaker. Use the surface deliberately. The title and text layouts intentionally leave open space; other slides need a clear visual composition.

**The bar: stunning, not just tidy**
- A deck should impress at first sight: art-directed, striking and memorable, like the keynote of a product launch or the work of a leading studio. Clean and correct is the floor, not the goal. A flat background, a title and a few boxes is a wireframe, even when every check passes.
- Before the first slide, give the deck a visual concept drawn from its subject: a mood, a palette with one confident accent, and a signature motif (a shape, a line, a glow, a way of cropping photos) that returns on every slide and binds them together.
- Every slide has one bold move as its focal point: a headline or a number at display size, a dramatic full-bleed crop, an illustration or diagram drawn for this content, a composition with real depth.
- A style the user names (futuristic, neon, glassmorphism, brutalism, 3D, corporate) is carried through in full, with its signature techniques, so it is recognisable at a glance; asked for several, give each slide its own. A business deck impresses by precision: KPI figures at display size, a chart with the series that matters highlighted, tables with rhythm.
- Ambition never costs legibility: decoration stays clear of text and faces, contrast still passes, and the hierarchy still reads in one second.

**Canvas and grid**
- The canvas is 1920×1080. Text stays inside the safe margins, 96px at the sides and 80px at the top and bottom, which leaves a content area of 1728×920: projectors and video calls crop edges, and text against an edge looks like a mistake.
- Lay content out on a 12-column grid with 24px gutters. The base spacing unit is 8px and every gap is a multiple of it. Regular spacing is most of what makes a slide look deliberate.
- Backgrounds, images and decorative elements may run past the margins to the edge of the slide (full-bleed), and are better for it. Text may not.

**Using the surface**
- Except for the intentionally sparse title and text layouts, content fills the content area: the bounding box of meaningful elements covers at least 70% of it.
- No dead zone. An empty quarter of the slide with no design intent behind it is a flaw: white space is a decision, not a remainder.
- Fill by composing, not by stretching. A card taller than what it holds is a dead zone with a border around it; so is content pushed up under the title with a third of the slide bare below it. Never give cards a fixed height that reaches for the bottom margin: a card is as tall as its content and padding. Plan the room first: an icon, a heading and two lines stand about 350px tall and leave half the slide. Fill it with content: larger type and numbers, a picture or a key figure in each card, a second row, a supporting visual, or the block centred under the title. Cards of a line or two may need no boxes. Under a title at the top, the content itself, not an empty box, should reach near y 900, or sit centred in that space on purpose.
- Balance: the visual centre of gravity is near the centre of the slide, unless the layout is asymmetric on purpose and a counterweight balances it.
- Images fill their frames (cover). They do not sit small in the middle of empty space.

**Typography** (pixels on the 1920×1080 canvas)

| style | size | use |
|---|---|---|
| display | 120–160 | opening slide, a big number |
| title | 72–96 | slide title |
| heading | 44–64 | subtitle, card title |
| body | 28–36 | body text |
| caption | 20–24 | notes, sources, labels |

- 24px is the absolute minimum for text that is meant to be read. At most two font families in a deck.
- One idea per slide. Up to about 40 words and 5 bullets; longer text is split over two slides or turned into a visual.
- A clear hierarchy: a size ratio of at least 1.5 between one level and the next, and one focal point per slide.

**A modern visual language**
- Big, bold titles. Big images, preferably full-bleed, with a darkening overlay that keeps the text on them readable.
- Colour discipline, 60/30/10: background, surfaces, accent. One accent colour, used sparingly, so that it still means something where it appears.
- Depth, in layers: a background with life in it (a photo, a gradient field, a subtle pattern), a middle layer of shapes, glows, lines or glass panels, and the content on top. CSS has the tools: layered gradients, \`backdrop-filter: blur()\` for glass, glows with \`box-shadow\` and \`drop-shadow()\`, \`mix-blend-mode\`, \`clip-path\` and \`mask-image\` for shaped photos and fades, \`transform\` for angle and perspective (on shapes and pictures, not text), oversized or outlined type, inline SVG illustration. Use them for the concept, not as a sampler. Cards share one radius and one soft shadow.
- One style of icons and one style of images for the whole deck (the deck's \`image_style\`).
- Variety: no more than two consecutive slides of the same archetype.

**Archetypes.** Every slide is one of these. Choosing one before you build is what keeps a slide from drifting back into a title and bullets.
${archetypeList}

A slide may go without a visual element (an image, a chart, an icon, a meaningful shape, a table) only when it is a \`quote\` or a \`section\`.

**Right-to-left decks**
- In a Hebrew or Arabic deck the layout is mirrored: text on the right, image on the left; a timeline or a process runs from right to left.
- Align to \`start\`, not to \`right\`. Numbers and Latin terms inside Hebrew or Arabic text stay left-to-right.
- Font pairing: a Hebrew face and a Latin face that match in weight and height.

**Motion**
- A slide you make moves by default: the transition of the slide before it, and what follows the title rising in, in reading order, unless you set its animation.
- Animation serves the reading order, not decoration: 300–600ms, one easing, one transition for the deck or per section.

**Accessibility**
- Contrast to WCAG AA: 4.5:1 for regular text, 3:1 for large text (above 48px). The app measures it on the rendered slide, so settle it before you write: mid-tone colours, as accent and secondary colours usually are, fail both as the colour of text on a light background, even at display size, and as a fill under white text. Keep them for shapes, bars and lines, and for text on a dark background; on a mid-tone fill, write in the theme's dark text colour. Text made paler with opacity loses contrast the same way.

**Before you call a slide done**, look at it and ask:
- Is there one clear focal point, and is it what the eye meets first?
- Does it avoid dead zones and crowding?
- Does the hierarchy read in one second: title, main point, details?
- Do imagery, typography and purposeful layers carry the message at the reference's level of detail?
- Is the text short enough to read from a distance?
- Would it impress at first sight, and is it publication-ready, distinct and written with original copy?
- At full size and thumbnail, are direction, alignment, crops and clipping correct?`;
