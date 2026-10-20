import { z } from 'zod';
import { Command, commandDefs, type CommandType } from './commands';
import {
  AnimationStep,
  Background,
  Color,
  Deck,
  Element,
  Fill,
  Insets,
  Layout,
  LineElement,
  RichText,
  Shadow,
  ShapeElement,
  Slide,
  Stroke,
  SvgElement,
  TextElement,
  Theme,
  Transition,
} from './schema';

export type JsonSchema = Record<string, unknown>;

/**
 * Shared pieces that get a readable name and are written once under `$defs`. Everything else
 * is inlined: a reference to an anonymous `__schema0` that is just "a non-empty string" costs
 * the agent more than the string.
 *
 * The four kinds of element that the artwork of a picture's frame is made of are named too: an
 * element is one of them and the artwork is a list of them, and inlined they were written twice.
 */
const named = z.registry<{ id: string }>();
for (const [id, schema] of Object.entries({
  Color,
  Fill,
  Background,
  Shadow,
  Stroke,
  Insets,
  RichText,
  Element,
  TextElement,
  ShapeElement,
  LineElement,
  SvgElement,
  AnimationStep,
  Transition,
  Layout,
})) {
  named.add(schema, { id });
}

/**
 * JSON Schema (draft 2020-12) of a Zod schema. The Zod schemas are the source of truth
 * (SPEC 5.1); this is what tool definitions for the agent are built from (MCP-03). Rules that
 * JSON Schema cannot express (the cross-field checks) are enforced only by Zod.
 */
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    metadata: named,
    cycles: 'ref',
  });
}

export const deckJsonSchema = (): JsonSchema => toJsonSchema(Deck);
export const slideJsonSchema = (): JsonSchema => toJsonSchema(Slide);
export const elementJsonSchema = (): JsonSchema => toJsonSchema(Element);
export const themeJsonSchema = (): JsonSchema => toJsonSchema(Theme);

/** Any command: the shape of one entry of an atomic batch. */
export const commandJsonSchema = (): JsonSchema => toJsonSchema(Command);

/** One command type. */
export function commandJsonSchemaOf(type: CommandType): JsonSchema {
  return toJsonSchema(commandDefs[type].schema);
}
