import { z } from 'zod';
import { Id } from './primitives';

/** `start` / `end` flip with the deck direction (SPEC 5.6). */
const FlowDirection = z.enum(['up', 'down', 'start', 'end']);

export const AnimationStep = z.strictObject({
  id: Id,
  elementId: Id,
  trigger: z.enum(['onClick', 'withPrevious', 'afterPrevious']),
  category: z.enum(['entrance', 'emphasis', 'exit', 'motion']),
  /** fade, flyIn, zoom, wipe, rise, pulse, ... The runtime owns the list (WG8). */
  preset: z.string().min(1),
  direction: FlowDirection.optional(),
  /** Milliseconds. */
  duration: z.number().nonnegative(),
  delay: z.number().nonnegative(),
  easing: z.string().min(1),
  textBy: z.enum(['all', 'paragraph', 'word', 'char']).optional(),
});
export type AnimationStep = z.infer<typeof AnimationStep>;

export const Transition = z.strictObject({
  /** none, fade, push, wipe, cover, reveal, zoom, flip, morph. */
  type: z.string().min(1),
  direction: FlowDirection.optional(),
  duration: z.number().nonnegative(),
  easing: z.string().min(1),
  advance: z.strictObject({ onClick: z.boolean(), afterMs: z.number().nonnegative().optional() }),
});
export type Transition = z.infer<typeof Transition>;
