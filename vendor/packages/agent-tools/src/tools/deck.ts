import {
  Command,
  CommandBus,
  commandDefs,
  locateElement,
  type CommandType,
  type Deck,
} from '@slidr/model';
import { z } from 'zod';
import { formatZodError } from '../errors';
import { getSlide } from '../lookup';
import { DeckApiError, defineTool } from '../tool';

export const themeUpdate = defineTool({
  name: 'theme_update',
  description:
    'Changes theme tokens for the whole deck: everything that uses a token follows. colors, fonts and textStyles are merged key by key; the other fields are replaced whole. Returns `deck: ["theme"]` and lint findings.',
  input: commandDefs['theme.update'].schema.shape.patch,
  scopes: ['deck'],
  writes: true,
  run(patch, ctx) {
    if (Object.keys(patch).length === 0) {
      throw new DeckApiError('invalid_input', 'Nothing to change: give at least one field.');
    }
    ctx.write([{ type: 'theme.update', patch }]);
    return {};
  },
});

const COMMAND_TYPES = Object.keys(commandDefs) as [CommandType, ...CommandType[]];

/**
 * The shapes of the commands, in short. The full union as JSON Schema is about 40 KB, and the
 * agent knows the element, slide and RichText shapes from the other tools; each op is still
 * validated against the model's `Command` schema, with the path of any bad field.
 *
 * Three commands are left out, on purpose.
 *
 * `asset.remove` works here like any other, but the agent has no use to put it to. No tool
 * lists the deck's assets, so the only ones it could name are those its own image and stock
 * calls just added. Removing them saves nothing, since an asset nothing uses is dropped when the
 * deck is saved (`prepareForSave`); all it would do is take pictures out of the user's media
 * panel, and what is kept there is the user's to decide.
 *
 * `asset.add` is refused here (`NO_ASSET_ADD`). It registers a file the app has stored, and
 * nothing the agent sends stores one: listed among the ops, it was what a model reached for
 * when asked for a picture "from this link", with the address as the file. The deck then held a
 * picture that is never drawn, and that no save can put in the file.
 *
 * `element.replace` is left out too, for now: it is what `element_convert` writes, and it works
 * here like any other. Describing it is new wording for the agent, which the evaluation set has
 * not seen, and takes more of the listing's size than is left (`listing.test.ts`).
 */
const OPS_HELP = [
  'Each op is one model command: {"type": ..., ...fields}. Fields named patch replace each given field whole; null removes an optional field.',
  'element.update {slideId, elementId, patch} (patch.frame may be partial)',
  'text.set {slideId, elementId, content: RichText, cell?: {row, col}}',
  'element.add {slideId, element, parentId?, index?}',
  'element.remove {slideId, elementIds}',
  'element.reorder {slideId, elementIds, to: "front" | "back" | "forward" | "backward" | {index}}',
  'element.group {slideId, elementIds, groupId (new id), name?}',
  'element.ungroup {slideId, groupId}',
  'slide.add {slide (full slide JSON with new ids), index?}',
  'slide.remove {slideIds}',
  'slide.move {slideIds, toIndex (counted without the moved slides)}',
  'slide.update {slideId, patch: {name, layoutId, archetype, background, notes, transition, hidden, css}}',
  'slide.setTimeline {slideId, timeline: AnimationStep[]}',
  'deck.setMeta {patch: {title, lang, dir, imageStyle}}',
  'theme.update {patch: as theme_update}',
  'theme.replace {theme}',
  'layout.add {layout, index?} / layout.update {layoutId, patch} / layout.remove {layoutId}',
].join('\n');

/** What an agent that sends `asset.add` is told: why not, and how a picture does get in. */
const NO_ASSET_ADD =
  'asset.add is not available to you. It registers a file the app has already stored with the deck, and no call of yours stores one: an address or a path is not a file of the deck, and its picture would never be drawn or saved. Pictures enter the deck through the tools that store them (the image and stock tools you were given), which register what they bring. For a picture only the user has, ask the user to insert it.';

export const deckApplyOps = defineTool({
  name: 'deck_apply_ops',
  description:
    'Applies several model commands atomically, as one change: all of them, or none when one is refused (the error names it). Later commands see the effect of earlier ones. Use it for changes that must not be seen half done. Returns the ids created, changed and removed.',
  input: z.strictObject({
    ops: z
      .array(z.looseObject({ type: z.enum(COMMAND_TYPES) }))
      .min(1)
      .describe(OPS_HELP),
  }),
  scopes: ['deck', 'slide'],
  writes: true,
  run({ ops }, ctx) {
    const commands = ops.map((op, i) => {
      const parsed = Command.safeParse(op);
      if (!parsed.success) {
        throw new DeckApiError(
          'invalid_input',
          `Invalid input for deck_apply_ops:\n${formatZodError(parsed.error, ['ops', i])}`,
        );
      }
      if (parsed.data.type === 'asset.add') {
        throw new DeckApiError(
          'invalid_input',
          `Invalid input for deck_apply_ops:\nops[${i}]: ${NO_ASSET_ADD}`,
        );
      }
      return parsed.data;
    });
    ctx.write(withWholeFrames(commands, ctx.deck));
    return {};
  },
});

/**
 * `element.update` replaces each field of its patch whole, but an agent sends a frame with only
 * what changed (`{"x": 100}`), as `element_update` lets it, and was refused (ADR-063). Each frame
 * of an `element.update` is completed from the element as the earlier ops of the batch leave it,
 * on a scratch bus over the same immutable deck. An op the scratch bus refuses is left as it is:
 * the write refuses it again and names it.
 */
function withWholeFrames(commands: Command[], deck: Deck): Command[] {
  const partial = (command: Command) =>
    command.type === 'element.update' &&
    typeof command.patch.frame === 'object' &&
    command.patch.frame !== null;
  if (!commands.some(partial)) return commands;
  const scratch = new CommandBus(deck, { historyLimit: 0 });
  return commands.map((command) => {
    let whole = command;
    if (command.type === 'element.update' && partial(command)) {
      const slide = scratch.deck.slides.find((s) => s.id === command.slideId);
      const found = slide && locateElement(slide.elements, command.elementId);
      if (found) {
        const frame = { ...found.element.frame, ...(command.patch.frame as object) };
        whole = { ...command, patch: { ...command.patch, frame } };
      }
    }
    try {
      scratch.dispatch(whole);
    } catch {
      // The write below refuses it, with the index of the op.
    }
    return whole;
  });
}

export const uiNavigate = defineTool({
  name: 'ui_navigate',
  description:
    'Shows a slide to the user on the stage and, optionally, selects elements on it, so the user sees what you are talking about. Changes nothing in the deck. Returns the slide id.',
  input: z.strictObject({
    slideId: z.string().min(1),
    elementIds: z.array(z.string().min(1)).optional(),
  }),
  scopes: ['deck', 'slide', 'object'],
  writes: false,
  requires: 'ui',
  run({ slideId, elementIds }, { deck, services }) {
    const slide = getSlide(deck, slideId);
    for (const id of elementIds ?? []) {
      if (!locateElement(slide.elements, id)) {
        throw new DeckApiError(
          'not_found',
          `Element "${id}" is not on slide "${slideId}". It may have been deleted.`,
        );
      }
    }
    services.ui!.navigate({ slideId, ...(elementIds ? { elementIds } : {}) });
    return { data: { slideId } };
  },
});
