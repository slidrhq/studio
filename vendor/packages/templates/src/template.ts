import { AssetId, AssetMeta, Direction, Layout, Slide, Theme } from '@slidr/model';
import { z } from 'zod';
import { copyJson } from './json';
import { mirrorLayout } from './mirror';

/**
 * A template (SPEC 5.5): a theme, the layouts drawn for it, and sample slides that show them. It
 * has no id or name of its own: they are the theme's, which is also how a deck remembers the
 * template it was switched to. This is what a `.slidrtheme` file holds (THM-07).
 */
export const Template = z
  .strictObject({
    theme: Theme,
    description: z.string().optional(),
    /** The direction `layouts` and `sample` are drawn for. */
    dir: Direction,
    layouts: z.array(Layout),
    /**
     * Layouts drawn by hand for the other direction (THM-02). Each replaces the automatic mirror
     * of the layout with the same id; a layout without one is mirrored.
     */
    flipped: z.array(Layout).optional(),
    /** Slides that show the template, each on one of its layouts. */
    sample: z.array(Slide).optional(),
    /** The assets the layouts and the sample use, as in a deck. */
    assets: z.record(AssetId, AssetMeta).optional(),
  })
  .superRefine((template, ctx) => {
    const ids = new Set<string>();
    for (const [index, layout] of template.layouts.entries()) {
      if (ids.has(layout.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['layouts', index, 'id'],
          message: `layout id "${layout.id}" appears twice`,
        });
      }
      ids.add(layout.id);
    }
    for (const [index, layout] of (template.flipped ?? []).entries()) {
      if (!ids.has(layout.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['flipped', index, 'id'],
          message: `"${layout.id}" is not a layout of the template`,
        });
      }
    }
    for (const [index, slide] of (template.sample ?? []).entries()) {
      if (slide.layoutId !== undefined && !ids.has(slide.layoutId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sample', index, 'layoutId'],
          message: `"${slide.layoutId}" is not a layout of the template`,
        });
      }
    }
  });
export type Template = z.infer<typeof Template>;

/**
 * The template's layouts for a direction, as a deck of that direction holds them: its own for
 * the direction they were drawn in, and for the other one the hand-drawn layout where the
 * template has one, the mirror otherwise. The ids are the template's in both directions.
 */
export function layoutsFor(template: Template, dir: Direction): Layout[] {
  if (dir === template.dir) return copyJson(template.layouts);
  return template.layouts.map((layout) => {
    const drawn = template.flipped?.find((l) => l.id === layout.id);
    return drawn ? copyJson(drawn) : mirrorLayout(layout);
  });
}
