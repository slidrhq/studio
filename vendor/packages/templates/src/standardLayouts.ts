import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type Element,
  type Frame,
  type Layout,
  type Placeholder,
} from '@slidr/model';
import type { Template } from './template';

/**
 * The layouts a template's own title over content is read from, plainest content first: the
 * standard layouts put their title where the template's content slides put theirs.
 */
const SOURCES: readonly Layout['archetype'][] = [
  'table',
  'chart',
  'comparison',
  'cards',
  'timeline',
  'process',
  'team',
  'bigNumber',
  'textImage',
];

/** How far above the foot the body of the text layout stops. */
const FOOT_GAP = 40;

/** How far above the top of the foot its rule may stand and still be part of it. */
const FOOT_ZONE = 24;

/**
 * The simple text layout every template offers, including older personal templates. A template
 * that draws its own keeps them; for one that does not they are made from its content slides:
 * the title on one line where their title stands, the body right under it, and the ground, the
 * frame and the foot (rule, mark, slide number) those slides have.
 */
export function withStandardLayouts(template: Template): Template {
  template = withoutTitleLayout(template);
  const layouts = [...template.layouts];
  const source = SOURCES.map((archetype) =>
    layouts.find(
      (layout) =>
        layout.archetype === archetype && layout.placeholders.some((p) => p.role === 'title'),
    ),
  ).find((layout) => layout !== undefined);
  const seat = source?.placeholders.find((place) => place.role === 'title');
  const styles = layouts.find((layout) => layout.archetype === 'textImage');
  const titleStyle =
    styles?.placeholders.find((place) => place.role === 'title')?.styleRef ??
    seat?.styleRef ??
    'title';
  const bodyStyle = styles?.placeholders.find((place) => place.role === 'body')?.styleRef ?? 'body';

  // One line of the title, where the source's title sets its first line (or its last, when the
  // title grows upwards from a line), across the width between the margins of that title.
  const look = template.theme.textStyles[titleStyle];
  const line = Math.ceil(look ? look.size * look.lineHeight : 90);
  const box = seat?.frame;
  const margin = box ? (template.dir === 'rtl' ? SLIDE_WIDTH - box.x - box.w : box.x) : 96;
  const spare = box ? Math.max(box.h - line, 0) : 0;
  const top =
    (box?.y ?? 96) +
    (seat?.vAlign === 'bottom' ? spare : seat?.vAlign === 'middle' ? Math.round(spare / 2) : 0);
  const titleFrame: Frame = { x: margin, y: top, w: SLIDE_WIDTH - 2 * margin, h: line };

  // The foot: what the source draws from its footer, or from its mark and number, downwards.
  const foot = source ? footTop(source) : undefined;
  const bodyTop = top + line + Math.round(line * 0.6);
  const bodyBottom = Math.max((foot ?? SLIDE_HEIGHT - 140) - FOOT_GAP, bodyTop + line);

  const taken = new Set(layouts.map((layout) => layout.id));
  const id = (archetype: 'title' | 'text'): string => {
    const base = `l_${template.theme.id}_${archetype}`;
    let candidate = base;
    let index = 2;
    while (taken.has(candidate)) candidate = `${base}_${index++}`;
    taken.add(candidate);
    return candidate;
  };
  // What the source draws around its content, and not the content: a frame around the whole
  // slide, what stands over its title (a rule, a dot before the line over it), and its foot.
  const around = (decoration: Element): boolean => {
    const { x, y, w, h } = decoration.frame;
    const whole = x <= 48 && y <= 48 && x + w >= SLIDE_WIDTH - 48 && y + h >= SLIDE_HEIGHT - 48;
    const over = box !== undefined && y + h <= box.y;
    const under = foot !== undefined && y >= foot - FOOT_ZONE;
    return whole || over || under;
  };
  const drawn = (
    archetype: 'title' | 'text',
  ): Pick<Layout, 'background' | 'decorations' | 'objects'> => ({
    ...(source?.background ? { background: source.background } : {}),
    decorations: (source?.decorations ?? [])
      .filter(around)
      .map((decoration) => renamed(decoration, archetype)),
    ...(source?.objects
      ? { objects: source.objects.filter(around).map((object) => renamed(object, archetype)) }
      : {}),
  });
  const title = (): Placeholder => ({
    id: 'p_title',
    role: 'title',
    frame: { ...titleFrame },
    styleRef: titleStyle,
    align: 'start',
    // A title that grows upwards from its line in the template keeps doing so here.
    vAlign: seat?.vAlign === 'bottom' ? 'bottom' : 'top',
  });
  if (!layouts.some((layout) => layout.archetype === 'text')) {
    const beforeImage = layouts.findIndex((layout) => layout.archetype === 'textImage');
    layouts.splice(beforeImage < 0 ? layouts.length : beforeImage, 0, {
      id: id('text'),
      name: 'Text',
      archetype: 'text',
      placeholders: [
        title(),
        {
          id: 'p_body',
          role: 'body',
          frame: { x: margin, y: bodyTop, w: SLIDE_WIDTH - 2 * margin, h: bodyBottom - bodyTop },
          styleRef: bodyStyle,
          align: 'start',
          vAlign: 'top',
        },
      ],
      ...drawn('text'),
    });
  }
  const textIndex = layouts.findIndex((layout) => layout.archetype === 'text');
  const imageIndex = layouts.findIndex((layout) => layout.archetype === 'textImage');
  if (textIndex >= 0 && imageIndex >= 0 && textIndex !== imageIndex - 1) {
    const [textLayout] = layouts.splice(textIndex, 1);
    layouts.splice(
      layouts.findIndex((layout) => layout.archetype === 'textImage'),
      0,
      textLayout!,
    );
  }
  return { ...template, layouts };
}

/**
 * The top of a layout's foot: its footer, or else the mark and the slide number it draws in the
 * lower half of the slide. Undefined for a layout without a foot.
 */
function footTop(layout: Layout): number | undefined {
  const footer = layout.placeholders.find((place) => place.role === 'footer')?.frame.y;
  if (footer !== undefined) return footer;
  const masters = layout.decorations
    .filter((d) => (d.role === 'logo' || d.role === 'slideNumber') && d.frame.y > SLIDE_HEIGHT / 2)
    .map((d) => d.frame.y);
  return masters.length > 0 ? Math.min(...masters) : undefined;
}

/** A decoration of another layout, under an id of its own in a standard layout. */
function renamed(decoration: Element, archetype: 'title' | 'text'): Element {
  const id = (old: string) => `${old}_${archetype}`;
  if (decoration.type !== 'group') return { ...decoration, id: id(decoration.id) };
  return {
    ...decoration,
    id: id(decoration.id),
    children: decoration.children.map((child) => renamed(child, archetype)),
  };
}

/** Remove the retired title-only choice and its previews in both directions. */
export function withoutTitleLayout(template: Template): Template {
  const removed = new Set(
    template.layouts.filter((layout) => layout.archetype === 'title').map((layout) => layout.id),
  );
  return {
    ...template,
    layouts: template.layouts.filter((layout) => !removed.has(layout.id)),
    ...(template.flipped
      ? { flipped: template.flipped.filter((layout) => !removed.has(layout.id)) }
      : {}),
    ...(template.sample
      ? {
          sample: template.sample.filter(
            (slide) => !slide.layoutId || !removed.has(slide.layoutId),
          ),
        }
      : {}),
  };
}
