/**
 * The outline of a deck before it is built (AID-03, WG11-T05). The tool changes nothing and
 * needs no service: the outline is its own input, which the chat shows as a card with the two
 * answers a user can give without typing. What happens next is the user's next message.
 */
import { Archetype } from '@slidr/model';
import { z } from 'zod';
import { defineTool } from '../tool';

export const outlinePropose = defineTool({
  name: 'outline_propose',
  description:
    'Shows the user the outline of a deck, or of several slides, before any of it is built: a line per slide with its title, its archetype and, where it helps, a few words on what the slide shows. Nothing is built or changed. The app shows the outline with buttons to approve it or turn it down, and the user may answer in words instead, with corrections. Call it once, say in a line what you propose, and end the turn: the answer comes as the next message. Returns how many slides were shown.',
  input: z.strictObject({
    title: z.string().min(1).optional().describe('The title of the deck.'),
    slides: z
      .array(
        z.strictObject({
          title: z.string().min(1),
          archetype: Archetype,
          note: z.string().min(1).optional().describe('What the slide shows, in a few words.'),
        }),
      )
      .min(1)
      .max(60),
  }),
  scopes: ['deck'],
  writes: false,
  run({ slides }) {
    return { data: { shown: slides.length } };
  },
});
