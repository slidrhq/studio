/**
 * Tools that need a service another work group builds (see ../services.ts). Each is registered
 * only when its service is provided; the tool itself is thin: it calls the service and writes
 * the commands, so the scope guard and the turn's transaction apply as for any other write.
 */
import {
  Archetype,
  commandDefs,
  createElement,
  findElementInDeck,
  PlaceholderRole,
  rotatedBounds,
  unionBounds,
  type AssetMeta,
  type Command,
  type Element,
  type Slide,
} from '@slidr/model';
import { z } from 'zod';
import { closestAspect, imagePlaceholders, slidePlaceholders, styledPrompt } from '../images';
import { getElement, getSlide, slideNumber } from '../lookup';
import type { HtmlSlideConversion, PngImage, StoredImage } from '../services';
import { DeckApiError, defineTool, type ToolContext, type ToolOutput } from '../tool';
import { animatesItself, withDefaultMotion } from '../motion';
import { afterSlide, indexAfter } from './shared';

const Id = z.string().min(1);
const ALL = ['deck', 'slide', 'object'] as const;

const HTML_HELP =
  'Write the slide as HTML/CSS for a 1920x1080 root, with any layout (flex, grid, absolute), and give every block of text a definite width. Use theme variables (var(--color-primary), var(--font-heading)) so template changes follow. <img data-asset="<id>"> places an asset, <img data-image-prompt="..."> an empty placeholder for an image to generate; data-name names an element, data-role="title" marks the title (the only role in a slide); data-anim sets an element’s entrance: a preset name, or JSON with animation_set step fields and order (0 as the slide opens, n on the n-th click); without any, the slide gets the deck’s transition and its content after the title rises in, in order; data-anim="none" on the root keeps it still; data-keep-html keeps a subtree as HTML; data-archetype on the root states the kind of slide. <i data-icon="lucide:rocket"></i> places an icon of the built-in library by its id (icon_search finds ids, when it is among your tools), sized by font-size and coloured by color. <div data-chart=\'{"chartType": …, "data": {"categories": […], "series": [{"name": …, "values": […]}]}}\'> with a definite size makes a chart element, which the app draws in the theme colours and the user edits as data: use it for a series of numbers.';

/**
 * The image placeholders of a slide (`data-image-prompt`), for the result of an HTML write: the
 * ids `image_generate` takes. The ids a write creates say nothing of their kind, and an agent
 * left to guess handed the image tool a text box (ADR-042).
 */
function placeholdersOf(slide: Slide): { elementId: string; prompt: string }[] {
  return slidePlaceholders(slide).map(({ elementId, prompt }) => ({ elementId, prompt }));
}

/** What both HTML writes report of a conversion. */
function conversionData(slideId: string, result: HtmlSlideConversion): Record<string, unknown> {
  const placeholders = placeholdersOf(result.slide);
  return {
    slideId,
    editability: result.editability,
    notes: result.notes,
    ...(placeholders.length > 0 ? { imagePlaceholders: placeholders } : {}),
  };
}

const registerAssets = (assets: readonly AssetMeta[]): Command[] =>
  assets.map((asset) => ({ type: 'asset.add', asset }));

/** A render of the slide for the result, when the capture service runs. */
async function renderIfPossible(ctx: ToolContext, slideId: string): Promise<PngImage[]> {
  const capture = ctx.services.capture;
  if (!capture) return [];
  try {
    return [await capture.renderSlide(ctx.deck, slideId, { width: 1280 })];
  } catch {
    // The slide is made; a failed render must not turn that into an error. slide_render retries.
    return [];
  }
}

export const slideRender = defineTool({
  name: 'slide_render',
  description:
    'A PNG of a slide exactly as the user sees it on the stage. Look at every slide you create or change before you finish (the quality gate checks this). Returns the image, and the slide id and number.',
  input: z.strictObject({
    slideId: Id,
    width: z
      .number()
      .int()
      .min(320)
      .max(1920)
      .optional()
      .describe('Image width in pixels. Default 1280.'),
  }),
  scopes: ALL,
  writes: false,
  requires: 'capture',
  looksAt: ({ slideId }) => [slideId],
  async run({ slideId, width }, ctx) {
    getSlide(ctx.deck, slideId);
    const image = await ctx.services.capture!.renderSlide(ctx.deck, slideId, {
      width: width ?? 1280,
    });
    return { data: { slideId, number: slideNumber(ctx.deck, slideId) }, images: [image] };
  },
});

export const deckRenderContactSheet = defineTool({
  name: 'deck_render_contact_sheet',
  description:
    'One PNG with thumbnails of the slides in a grid, each labelled with its number: for checking consistency, variety and flow across the deck. Returns the image and the slide ids shown, in order.',
  input: z.strictObject({
    slideIds: z.array(Id).optional().describe('Default: every slide.'),
    columns: z.number().int().min(1).max(8).optional().describe('Default 4.'),
  }),
  scopes: ['deck'],
  writes: false,
  requires: 'capture',
  looksAt: ({ slideIds }) => slideIds,
  async run({ slideIds, columns }, ctx) {
    const ids = slideIds ?? ctx.deck.slides.map((s) => s.id);
    for (const id of ids) getSlide(ctx.deck, id);
    const image = await ctx.services.capture!.renderContactSheet(ctx.deck, ids, {
      columns: columns ?? 4,
      width: 1600,
    });
    return { data: { slideIds: ids }, images: [image] };
  },
});

const RoleContent = z.union([
  z.string().describe('Markdown, as for text_set.'),
  z.strictObject({ assetId: Id }),
  z.strictObject({ imagePrompt: z.string().min(1) }),
]);

export const slideCreate = defineTool({
  name: 'slide_create',
  description:
    'A new slide from a layout of the deck (deck_get_theme lists them), with content placed by placeholder role. A role the layout has several placeholders of (three cards, four steps) takes a list, one value per placeholder in order. Returns `slideId`, the ids created, lint findings, and a render of the slide.',
  input: z.strictObject({
    layoutId: Id,
    content: z
      .partialRecord(PlaceholderRole, z.union([RoleContent, z.array(RoleContent).min(1)]))
      .describe(
        'By role: Markdown text, {"assetId"} for an image, or {"imagePrompt"} for a placeholder to generate; or a list of them for a role that repeats.',
      ),
    name: z.string().min(1).optional(),
    afterSlideId: afterSlide('at the end'),
  }),
  scopes: ['deck'],
  writes: true,
  requires: 'layouts',
  async run({ layoutId, content, name, afterSlideId }, ctx) {
    if (!ctx.deck.layouts.some((l) => l.id === layoutId)) {
      throw new DeckApiError(
        'not_found',
        `Layout "${layoutId}" does not exist; deck_get_theme lists the layouts.`,
      );
    }
    const slide = await ctx.services.layouts!.createSlide(ctx.deck, {
      layoutId,
      content,
      ...(name ? { name } : {}),
    });
    const index = indexAfter(ctx.deck, afterSlideId, ctx.deck.slides.length);
    ctx.write([
      {
        type: 'slide.add',
        slide: withDefaultMotion(slide, ctx.deck, index, { timeline: true }),
        index,
      },
    ]);
    // Like a slide written as HTML: the render that comes back is the look the design check asks
    // for, so a slide made exactly as its layout draws it needs no second call.
    return { data: { slideId: slide.id }, images: await renderIfPossible(ctx, slide.id) };
  },
});

export const slideCreateFromHtml = defineTool({
  name: 'slide_create_from_html',
  description: `The main way to make a new slide: write it as HTML/CSS and the app converts it into editable elements, looking exactly as written. ${HTML_HELP} Returns \`slideId\`, the ids created, \`editability\` (share of the content that became regular elements), notes from the conversion, lint findings, and a render of the slide.`,
  input: z.strictObject({
    html: z.string().min(1).describe('The whole slide; <style> is allowed inside.'),
    name: z.string().min(1).optional(),
    afterSlideId: afterSlide('at the end'),
  }),
  scopes: ['deck'],
  writes: true,
  requires: 'conversion',
  async run({ html, name, afterSlideId }, ctx) {
    // A slide that does not exist is refused now, before the conversion.
    indexAfter(ctx.deck, afterSlideId, 0);
    const result = await ctx.services.conversion!.htmlToSlide(ctx.deck, {
      html,
      ...(name ? { name } : {}),
    });
    // The place is found once the slide is there to add. The deck may have changed while the
    // conversion ran (the user added a slide, or a call beside this one did): "at the end" is the
    // end as it is now, and "after that slide" is where that slide stands now. A slide that
    // was deleted meanwhile leaves the new one at the end rather than nowhere.
    const end = ctx.deck.slides.length;
    const there = afterSlideId == null || ctx.deck.slides.some((s) => s.id === afterSlideId);
    const index = there ? indexAfter(ctx.deck, afterSlideId, end) : end;
    // It moves by default: the deck's transition, and an entrance unless the HTML chose its own.
    const slide = withDefaultMotion(result.slide, ctx.deck, index, {
      timeline: !animatesItself(html),
    });
    ctx.write([...registerAssets(result.assets), { type: 'slide.add', slide, index }]);
    return {
      data: conversionData(result.slide.id, result),
      images: await renderIfPossible(ctx, result.slide.id),
    };
  },
});

export const slideReplaceFromHtml = defineTool({
  name: 'slide_replace_from_html',
  description: `Replaces everything on an existing slide (elements, background, slide CSS, animation) with a new design written as HTML/CSS; the slide keeps its id, name, notes and place. For small edits use element_update instead, which keeps ids and the user's manual changes. ${HTML_HELP} Returns the ids created and removed, \`editability\`, notes, lint findings, and a render.`,
  input: z.strictObject({ slideId: Id, html: z.string().min(1) }),
  scopes: ['deck', 'slide'],
  writes: true,
  requires: 'conversion',
  async run({ slideId, html }, ctx) {
    getSlide(ctx.deck, slideId);
    const result = await ctx.services.conversion!.htmlToSlide(ctx.deck, { html });
    // The deck may have changed while the conversion ran.
    const current = getSlide(ctx.deck, slideId);
    const { slide } = result;
    const commands: Command[] = registerAssets(result.assets);
    if (current.elements.length > 0) {
      commands.push({
        type: 'element.remove',
        slideId,
        elementIds: current.elements.map((e) => e.id),
      });
    }
    for (const element of slide.elements) commands.push({ type: 'element.add', slideId, element });
    // The new design moves by default, as a new slide does; the transition it has stays.
    const moving = withDefaultMotion(slide, ctx.deck, ctx.deck.slides.indexOf(current), {
      timeline: !animatesItself(html),
    });
    commands.push(
      {
        type: 'slide.update',
        slideId,
        // The new design says which kind of slide it is; the old kind goes with the old design.
        patch: {
          background: slide.background ?? null,
          css: slide.css ?? null,
          layoutId: null,
          archetype: slide.archetype ?? null,
          ...(current.transition ? {} : { transition: moving.transition }),
        },
      },
      { type: 'slide.setTimeline', slideId, timeline: moving.timeline },
    );
    ctx.write(commands);
    return {
      data: conversionData(slideId, result),
      images: await renderIfPossible(ctx, slideId),
    };
  },
});

/**
 * The replacements as one element under the id of the element they replace: the element
 * itself when there is one, a group around them when there are several. An object session
 * converts this way, so that what it works on stays one element with the id it knows
 * (ADR-017); the scope guard lets an element be replaced in place under its own id.
 */
function asOneElement(elements: readonly Element[], original: Element): Element {
  const [only] = elements;
  if (!only) {
    throw new DeckApiError(
      'invalid_state',
      `Element "${original.id}" has nothing visible to convert.`,
    );
  }
  if (elements.length === 1) return { ...only, id: original.id };
  const frame = unionBounds(elements.map((e) => rotatedBounds(e.frame, e.rotation)));
  return createElement.group({
    id: original.id,
    frame,
    ...(original.name ? { name: original.name } : {}),
    children: elements.map((e) => ({
      ...e,
      frame: { ...e.frame, x: e.frame.x - frame.x, y: e.frame.y - frame.y },
    })),
  });
}

export const elementConvert = defineTool({
  name: 'element_convert',
  description:
    'Converts an `html` element into regular elements (to: "elements"), or a regular element into one `html` element (to: "html"), in the same place. Animation steps of the converted element are dropped. In an object session the result stays one element with the same id: a group when the HTML became several elements. Returns `elementIds` of the replacements, `editability` and notes.',
  input: z.strictObject({
    elementId: Id,
    slideId: Id.optional(),
    to: z.enum(['elements', 'html']),
  }),
  scopes: ALL,
  writes: true,
  requires: 'conversion',
  async run({ elementId, slideId, to }, ctx) {
    const { slide } = getElement(ctx.deck, elementId, slideId);
    const result = await ctx.services.conversion!.convertElement(ctx.deck, {
      slideId: slide.id,
      elementId,
      to,
    });
    // The deck may have changed while the conversion ran.
    const { element } = getElement(ctx.deck, elementId, slide.id);
    const elements =
      ctx.turn.scope.kind === 'object' ? [asOneElement(result.elements, element)] : result.elements;
    // In its place, as one command: a removal and an addition would take the group of an only
    // child away between the two.
    ctx.write([
      ...registerAssets(result.assets),
      { type: 'element.replace', slideId: slide.id, elementId, elements },
    ]);
    return {
      data: {
        elementIds: elements.map((e) => e.id),
        editability: result.editability,
        notes: result.notes,
      },
    };
  },
});

export const slideLint = defineTool({
  name: 'slide_lint',
  description:
    'Runs every design-lint rule on one slide. Returns `findings`: rule, severity (error, warning, info), element ids and a message.',
  input: z.strictObject({ slideId: Id }),
  scopes: ALL,
  writes: false,
  requires: 'lint',
  async run({ slideId }, ctx) {
    getSlide(ctx.deck, slideId);
    return { data: { findings: await ctx.services.lint!.lint(ctx.deck, [slideId], 'all') } };
  },
});

export const deckLint = defineTool({
  name: 'deck_lint',
  description:
    'Runs every design-lint rule on every slide, including rules across slides. Returns `findings`: rule, severity, slide id, element ids and a message.',
  input: z.strictObject({}),
  scopes: ALL,
  writes: false,
  requires: 'lint',
  async run(_input, ctx) {
    const ids = ctx.deck.slides.map((s) => s.id);
    return { data: { findings: await ctx.services.lint!.lint(ctx.deck, ids, 'all') } };
  },
});

export const templateApply = defineTool({
  name: 'template_apply',
  description:
    'Switches the deck to another template (deck_get_theme lists them): theme, layouts, and every slide mapped to the new layouts by archetype and role, as one step. Returns the ids changed.',
  input: z.strictObject({ templateId: Id }),
  scopes: ['deck'],
  writes: true,
  requires: 'templates',
  async run({ templateId }, ctx) {
    ctx.write(await ctx.services.templates!.applyCommands(ctx.deck, templateId));
    return {};
  },
});

const ThemeTokens = commandDefs['theme.update'].schema.shape.patch;

/** A full draft of sixteen layouts is sixteen conversions and two lint passes. */
const TEMPLATE_TIMEOUT_MS = 210_000;

export const templateCreate = defineTool({
  name: 'template_create',
  description:
    'Drafts a template: theme tokens, and layouts each written as one slide in HTML at 1920x1080 in the deck\'s direction, with data-role on every part a deck fills in (title, subtitle, body, caption, number, quote, attribution, footer, image, chart, table) and data-role="logo" on the logo. What carries a role becomes a placeholder, in the theme text style nearest to how it was drawn, and keeps the text it was drawn with as the sample; everything else is drawn by the layout, under the content. Nothing is saved or applied: the app shows the draft to the user, who saves it or asks for changes. With `basedOn` the draft starts as a copy of an earlier draft or of a template of the library, so a call can carry only what changes. Returns `templateId`, the layouts with their placeholders, `findings` of the design lint on each layout, filled with its sample (as drawn, and mirrored for the other direction) and with other short text in Hebrew and in English (`text: "other"`: a deck writes what it likes, and text of another length lands elsewhere in its box), notes on what a layout could not keep, and a sheet of all the layouts to look at.',
  input: z.strictObject({
    name: z.string().min(1),
    theme: ThemeTokens.describe(
      'Theme tokens, as in theme_update: over the base theme, or over the theme of `basedOn`.',
    ),
    layouts: z
      .array(
        z.strictObject({ name: z.string().min(1), archetype: Archetype, html: z.string().min(1) }),
      )
      .describe(
        'With `basedOn`, a layout replaces the one of the same archetype (of the same name, when the template has several of that archetype), or is added; the list may be empty to change the theme alone.',
      ),
    basedOn: Id.optional().describe(
      'The `templateId` of an earlier draft, or the id of a template deck_get_theme lists.',
    ),
  }),
  scopes: ['deck'],
  writes: false,
  requires: 'templates',
  timeoutMs: TEMPLATE_TIMEOUT_MS,
  async run({ name, theme, layouts, basedOn }, ctx) {
    if (layouts.length === 0 && !basedOn) {
      throw new DeckApiError('invalid_input', 'A template needs at least one layout.');
    }
    const { preview, ...draft } = await ctx.services.templates!.create(ctx.deck, {
      name,
      theme,
      layouts,
      ...(basedOn ? { basedOn } : {}),
    });
    return { data: { ...draft }, images: preview ? [preview] : [] };
  },
});

export const templateSave = defineTool({
  name: 'template_save',
  description:
    "Saves a drafted template (or, without templateId, the deck's own theme and layouts) as a personal template of the library, optionally the default for new decks. The deck itself stays on the template it is on. Returns `templateId`: the id the template has in the library, which template_apply takes.",
  input: z.strictObject({
    templateId: Id.optional(),
    name: z.string().min(1),
    setDefault: z.boolean().optional().describe('Make it the template of every new deck.'),
  }),
  scopes: ['deck'],
  writes: false,
  requires: 'templates',
  async run({ templateId, name, setDefault }, ctx) {
    const saved = await ctx.services.templates!.save(ctx.deck, {
      ...(templateId ? { templateId } : {}),
      name,
      setDefault: setDefault ?? false,
    });
    return { data: { templateId: saved.templateId } };
  },
});

/** What an image tool works on: an image element with what it holds, or an asset alone. */
interface ImageTarget {
  slideId?: string;
  elementId?: string;
  assetId?: string;
  /** The prompt a placeholder carries. */
  prompt?: string;
  frame?: { w: number; h: number };
}

/** The change that puts an image into an image element: its asset, and no prompt left to fill. */
const placement = (slideId: string, elementId: string, assetId: string): Command => ({
  type: 'element.update',
  slideId,
  elementId,
  patch: { assetId, prompt: null },
});

/**
 * The asset of an image element, or the given asset; one of the two is required. An element the
 * session may not change is refused here, before an image is made for it: the provider takes a
 * minute, and at some providers money, and the scope guard would refuse the write afterwards.
 */
function sourceAsset(
  ctx: ToolContext,
  input: { elementId?: string; assetId?: string },
): ImageTarget {
  const { deck } = ctx;
  if (input.elementId) {
    const { slide, element } = getElement(deck, input.elementId);
    if (element.type !== 'image') {
      throw new DeckApiError(
        'invalid_state',
        `Element "${input.elementId}" is a ${element.type}, not an image.`,
      );
    }
    ctx.allowed([placement(slide.id, element.id, element.assetId ?? '')]);
    return {
      slideId: slide.id,
      elementId: element.id,
      ...(element.assetId ? { assetId: element.assetId } : {}),
      ...(element.prompt ? { prompt: element.prompt } : {}),
      frame: element.frame,
    };
  }
  if (!input.assetId) throw new DeckApiError('invalid_input', 'Give elementId or assetId.');
  if (!deck.assets[input.assetId]) {
    throw new DeckApiError('not_found', `Asset "${input.assetId}" is not in the deck.`);
  }
  return { assetId: input.assetId };
}

/**
 * Registers the images, and puts the first into the element when there is one. The images took
 * a while to make, and the deck may have changed meanwhile: an element that is gone, or is no
 * longer an image, is left alone, and what was made (and paid for) stays among the assets.
 */
function placeImages(
  ctx: ToolContext,
  images: readonly StoredImage[],
  target: { elementId?: string },
) {
  const first = images[0];
  if (!first) throw new DeckApiError('failed', 'The image service returned no image.');
  const found = target.elementId ? findElementInDeck(ctx.deck, target.elementId) : undefined;
  const into = found?.element.type === 'image' ? found : undefined;
  ctx.write([
    ...registerAssets(images.map((i) => i.asset)),
    ...(into ? [placement(into.slide.id, into.element.id, first.asset.id)] : []),
  ]);
  return {
    data: {
      assets: images.map(({ asset }) => ({
        assetId: asset.id,
        ...(asset.width ? { width: asset.width, height: asset.height } : {}),
        ...(asset.attribution ? { attribution: asset.attribution } : {}),
      })),
      ...(target.elementId && !into
        ? {
            notPlaced: `Element "${target.elementId}" was deleted or changed while the image was made: the image is among the deck's assets, in no element.`,
          }
        : {}),
    },
    images: images.map((i) => i.preview),
  };
}

/**
 * A provider takes about 50 seconds for one image and up to 90 for four side by side (ADR-025):
 * past the 60 seconds a tool call gets by default.
 */
const IMAGE_TIMEOUT_MS = 300_000;

/** What a call that left its images being made says of them (ADR-097). */
const MAKING =
  'Being made: each image goes into its element when it is ready, in about a minute. Go on with the rest of the work meanwhile. A later result says under `meanwhile` how it went, and slide_render of the slide waits for it.';

export const imageGenerate = defineTool({
  name: 'image_generate',
  description:
    "Generates images from a prompt and adds them to the deck's assets. Say what the image shows; the app adds the deck's image style and palette to every prompt, so the images of one deck belong together. With elementId (an image element, e.g. a placeholder), the first image goes into it, keeping its frame and crop; a placeholder carries a prompt of its own, which is used when you give none. With optionsFor (an image element), none is placed: the user sees them as alternatives for it and picks one. With elementId it returns at once (`making`), and the image goes into the element about a minute later; a later result says how it went, under `meanwhile`. Otherwise it returns `assets` (ids, sizes) and previews.",
  input: z.strictObject({
    prompt: z
      .string()
      .min(1)
      .optional()
      .describe('What the image shows. Optional for a placeholder that carries a prompt.'),
    count: z.number().int().min(1).max(4).optional().describe('Default 1.'),
    aspect: z
      .enum(['16:9', '4:3', '1:1', '3:4', '9:16'])
      .optional()
      .describe("Default: the one nearest to the element's frame, or 16:9 without an element."),
    elementId: Id.optional(),
    optionsFor: Id.optional(),
    transparent: z
      .boolean()
      .optional()
      .describe(
        'The subject alone on a transparent background: a cut-out to lay over the slide (a product, a figure, an object). Describe the subject only; the app sees to the background.',
      ),
  }),
  scopes: ALL,
  writes: true,
  requires: 'images',
  timeoutMs: IMAGE_TIMEOUT_MS,
  async run({ prompt, count, aspect, elementId, optionsFor, transparent }, ctx) {
    if (elementId && optionsFor) {
      throw new DeckApiError(
        'invalid_input',
        'Give elementId to put the image into an element, or optionsFor to offer images for one: not both.',
      );
    }
    if (optionsFor) {
      const { element } = getElement(ctx.deck, optionsFor);
      if (element.type !== 'image') {
        throw new DeckApiError(
          'invalid_input',
          `optionsFor is for an image element; "${optionsFor}" is a ${element.type}.`,
        );
      }
    }
    // Alternatives take the shape of the element they are for; none of them is placed.
    const shape: ImageTarget = optionsFor ? sourceAsset(ctx, { elementId: optionsFor }) : {};
    const target: ImageTarget = elementId ? sourceAsset(ctx, { elementId }) : {};
    const subject = prompt ?? target.prompt;
    if (!subject) {
      throw new DeckApiError(
        'invalid_input',
        elementId
          ? `Element "${elementId}" carries no image prompt: give \`prompt\`.`
          : 'Give `prompt`: what the image shows.',
      );
    }
    const frame = target.frame ?? shape.frame;
    const make = async () => {
      const images = await ctx.services.images!.generate({
        prompt: styledPrompt(ctx.deck, subject),
        count: count ?? 1,
        aspect: aspect ?? (frame ? closestAspect(frame) : '16:9'),
        ...(transparent ? { transparent } : {}),
      });
      return placeImages(ctx, images, target);
    };
    // An image that goes into an element is made while the agent goes on (ADR-097). Images
    // without one are waited for: the agent places them, or offers them to the user.
    if (!target.slideId || !target.elementId) return make();
    return ctx.later([target.slideId], make, {
      data: { making: [{ slideId: target.slideId, elementId: target.elementId }], note: MAKING },
    });
  },
});

/** Most placeholders one call fills: two rounds of a provider that makes four at a time. */
const MAX_FILL = 8;

export const imageFillPlaceholders = defineTool({
  name: 'image_fill_placeholders',
  description: `Generates an image for every image placeholder that carries a prompt (the ones <img data-image-prompt="..."> leaves), each from its own prompt with the deck's image style and palette, at the aspect nearest to its frame, and puts each into its placeholder. The images are made side by side, so several placeholders take little longer than one. With slideId, only that slide; without it, the whole deck. At most ${MAX_FILL} per call. It returns at once (\`making\`, and \`remaining\`: placeholders left for another call), and the images go into their placeholders about a minute later; a later result says how it went (\`filled\`, \`failed\` with the reason), under \`meanwhile\`.`,
  input: z.strictObject({
    slideId: Id.optional().describe('Default: every slide; in a slide session, its slide.'),
  }),
  scopes: ['deck', 'slide'],
  writes: true,
  requires: 'images',
  timeoutMs: IMAGE_TIMEOUT_MS,
  async run({ slideId }, ctx) {
    const { scope } = ctx.turn;
    const only = slideId ?? (scope.kind === 'slide' ? scope.slideId : undefined);
    if (only) getSlide(ctx.deck, only);
    const waiting = imagePlaceholders(ctx.deck, only ? [only] : undefined);
    const batch = waiting.slice(0, MAX_FILL);
    if (batch.length === 0) return { data: { filled: [], failed: [], remaining: 0 } };
    // A slide the session may not change is refused now, not after its images were made.
    ctx.allowed(batch.map((p) => placement(p.slideId, p.elementId, '')));

    const images = ctx.services.images!;
    const remaining = waiting.length - batch.length;
    const fill = async (): Promise<ToolOutput> => {
      const settled = await Promise.allSettled(
        batch.map((placeholder) =>
          images.generate({
            prompt: styledPrompt(ctx.deck, placeholder.prompt),
            count: 1,
            aspect: closestAspect(placeholder.frame),
          }),
        ),
      );
      const filled: { slideId: string; elementId: string; image: StoredImage }[] = [];
      const failed: { elementId: string; reason: string }[] = [];
      settled.forEach((outcome, i) => {
        const { slideId: slide, elementId } = batch[i]!;
        const image = outcome.status === 'fulfilled' ? outcome.value[0] : undefined;
        if (image) filled.push({ slideId: slide, elementId, image });
        else {
          const reason =
            outcome.status === 'rejected' && outcome.reason instanceof Error
              ? outcome.reason.message
              : 'The image service returned no image.';
          failed.push({ elementId, reason });
        }
      });
      // Nothing was made: the first reason is the answer, as for one image.
      if (filled.length === 0) throw new DeckApiError('failed', failed[0]!.reason);

      // The deck may have changed while the images were made: a placeholder that is gone, or
      // was filled by the user in the meantime, is left alone, and its image stays an asset.
      const still = new Set(imagePlaceholders(ctx.deck).map((p) => p.elementId));
      ctx.write([
        ...registerAssets(filled.map(({ image }) => image.asset)),
        ...filled
          .filter(({ elementId }) => still.has(elementId))
          .map(({ slideId: slide, elementId, image }) =>
            placement(slide, elementId, image.asset.id),
          ),
      ]);
      return {
        data: {
          filled: filled.map(({ slideId: slide, elementId, image }) => ({
            slideId: slide,
            elementId,
            assetId: image.asset.id,
          })),
          failed,
          remaining,
        },
        images: filled.map(({ image }) => image.preview),
      };
    };
    // Made while the agent goes on (ADR-097), as an image for one element is.
    const making = batch.map(({ slideId: slide, elementId }) => ({ slideId: slide, elementId }));
    return ctx.later([...new Set(batch.map((p) => p.slideId))], fill, {
      data: { making, remaining, note: MAKING },
    });
  },
});

export const imageEdit = defineTool({
  name: 'image_edit',
  description:
    'Edits an image by instruction, as new assets; the original stays. With elementId, the first result replaces the image in the element, keeping frame and crop. What an edit is depends on the image provider the user chose in Settings, and the result says which it was (`edit`). An "exact" provider changes what the instruction asks and returns the image at its own size; with maskAssetId (an image whose transparent area is where the change may happen) every pixel outside the mask is kept as it was. A "regenerate" provider draws a new image after the original: the composition is similar, no pixel is kept, small details move, and a mask is refused. So with a regenerating provider do not promise a local fix: say that the image will be redrawn, or that exact edits need the other provider. Returns `assets`, `provider`, `edit` and previews.',
  input: z.strictObject({
    elementId: Id.optional().describe('An image element. Give this or assetId.'),
    assetId: Id.optional(),
    instruction: z.string().min(1),
    maskAssetId: Id.optional(),
    count: z.number().int().min(1).max(4).optional().describe('Default 1.'),
  }),
  scopes: ALL,
  writes: true,
  requires: 'images',
  timeoutMs: IMAGE_TIMEOUT_MS,
  async run({ elementId, assetId, instruction, maskAssetId, count }, ctx) {
    const source = sourceAsset(ctx, { elementId, assetId });
    if (!source.assetId)
      throw new DeckApiError('invalid_state', 'The image element has no image yet.');
    const service = ctx.services.images!;
    const images = await service.edit({
      assetId: source.assetId,
      instruction,
      ...(maskAssetId ? { maskAssetId } : {}),
      count: count ?? 1,
    });
    const placed = placeImages(ctx, images, source);
    // Which kind of edit it was: the same call is a touch-up with one provider and a redraw
    // with another, and only the app knows which one the user has chosen.
    const provider = await service.describe?.().catch(() => undefined);
    return provider
      ? { ...placed, data: { ...placed.data, provider: provider.name, edit: provider.edit } }
      : placed;
  },
});

export const imageProcess = defineTool({
  name: 'image_process',
  description:
    'Processes an image on this machine, as a new asset with a transparent background; the original stays. removeBackground: a local model cuts the subject of a photo out. keyOutBackground: a flat background colour, read off the border of the picture, becomes transparent; right for a logo or an illustration on one colour, where a model is not needed. With elementId, the result replaces the image in the element, keeping its frame and crop. (Crop, mask, filter and colour adjustments are element fields: use element_update.) Returns `assets` and a preview.',
  input: z.strictObject({
    elementId: Id.optional().describe('An image element. Give this or assetId.'),
    assetId: Id.optional(),
    operation: z.enum(['removeBackground', 'keyOutBackground']),
  }),
  scopes: ALL,
  writes: true,
  requires: 'images',
  async run({ elementId, assetId, operation }, ctx) {
    const source = sourceAsset(ctx, { elementId, assetId });
    if (!source.assetId)
      throw new DeckApiError('invalid_state', 'The image element has no image yet.');
    const image = await ctx.services.images!.process({ assetId: source.assetId, operation });
    return placeImages(ctx, [image], source);
  },
});

export const stockSearch = defineTool({
  name: 'stock_search',
  description:
    "Searches stock photos and adds the best matches to the deck's assets (not to a slide), with attribution. Place one with element_add or element_update (assetId); unused ones are dropped on save. The photo libraries index English, so write the query in English whatever the deck's language. Returns `assets` (ids, sizes, and whom each photo is credited to) and previews.",
  input: z.strictObject({
    query: z.string().min(1).describe('A few English words: what the photo shows.'),
    count: z.number().int().min(1).max(8).optional().describe('Default 4.'),
    orientation: z.enum(['landscape', 'portrait', 'square']).optional(),
  }),
  scopes: ALL,
  writes: true,
  requires: 'stock',
  async run({ query, count, orientation }, ctx) {
    const images = await ctx.services.stock!.search({
      query,
      count: count ?? 4,
      ...(orientation ? { orientation } : {}),
    });
    if (images.length === 0) return { data: { assets: [] } };
    return placeImages(ctx, images, {});
  },
});

export const iconSearch = defineTool({
  name: 'icon_search',
  description:
    'Searches the built-in icon library (Lucide and Tabler: line icons of one style) by a word or two, in Hebrew or English. Returns `icons`: id (as in data-icon="lucide:rocket"), name and SVG markup drawn in currentColor, ready for HTML or for an svg element.',
  input: z.strictObject({
    query: z.string().min(1),
    count: z.number().int().min(1).max(24).optional().describe('Default 8.'),
  }),
  scopes: ALL,
  writes: false,
  requires: 'icons',
  async run({ query, count }, ctx) {
    return { data: { icons: await ctx.services.icons!.search({ query, count: count ?? 8 }) } };
  },
});

export const uiPresentOptions = defineTool({
  name: 'ui_present_options',
  description:
    "Shows the user 2 to 8 variations as cards (text in Markdown, an image asset, a slide layout in HTML, or a change to a chart, a table or any other element). Options are for an element, a layout for a slide. Hovering previews a card and clicking applies it: the app applies the user's pick, so do not apply it yourself. Returns how many cards were shown.",
  input: z.strictObject({
    kind: z.enum(['text', 'image', 'layout', 'chart', 'table', 'element']),
    prompt: z.string().optional().describe('A line above the cards.'),
    elementId: Id.optional().describe(
      "The element the options are for. Default: the session's element.",
    ),
    slideId: Id.optional().describe("Default: elementId's slide, or the session's."),
    options: z
      .array(
        z.strictObject({
          label: z.string().min(1),
          text: z.string().optional(),
          assetId: Id.optional(),
          html: z.string().optional(),
          set: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .min(2)
      .max(8)
      .describe(
        'Each option has a label and what its kind takes: text, assetId, html, or, for kind chart or table, set: the arguments of chart_set or table_set that make this variation of the element, without elementId, as in {"chartType": "line"}, {"title": "…"} or {"styleId": "lines", "bandedRows": true}. For kind element, set is the patch of element_update, as in {"geometry": {"kind": "preset", "preset": "ellipse"}}.',
      ),
  }),
  scopes: ALL,
  writes: false,
  requires: 'options',
  async run({ kind, prompt, elementId, slideId, options }, ctx) {
    const { scope } = ctx.turn;
    // A slide or object session offers options on its own slide; a deck session names it.
    const own = scope.kind === 'slide' || scope.kind === 'object' ? scope.slideId : undefined;
    const target = elementId ?? (scope.kind === 'object' ? scope.elementIds[0] : undefined);
    const onSlide = target
      ? getElement(ctx.deck, target, own ?? slideId).slide.id
      : (own ?? slideId);
    if (!onSlide) {
      throw new DeckApiError(
        'invalid_input',
        'Say what the options are for: elementId for the options of an element, slideId for layouts.',
      );
    }
    if (own && onSlide !== own) {
      throw new DeckApiError('out_of_scope', `This session offers options on slide "${own}" only.`);
    }
    getSlide(ctx.deck, onSlide);
    await ctx.services.options!.present({
      kind,
      target: { slideId: onSlide, ...(target ? { elementId: target } : {}) },
      ...(prompt ? { prompt } : {}),
      options,
    });
    return { data: { shown: options.length } };
  },
});
