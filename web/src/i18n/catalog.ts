/**
 * Every word of the studio, by key. Each area of the interface keeps its own words in
 * `areas/<area>.ts`, in Hebrew and English; the other languages are in `locales/<lang>.ts`,
 * read when the language is chosen, and fall back to English for a word they lack. A value holds
 * `{name}` where a number or a name goes.
 */
import * as agents from './areas/agents';
import * as chat from './areas/chat';
import * as display from './areas/display';
import * as publish from './areas/publish';
import * as rail from './areas/rail';
import * as settings from './areas/settings';
import * as shell from './areas/shell';
import * as templateVariant from './areas/templateVariant';
import * as variant from './areas/variant';

const areas = [shell, rail, chat, display, agents, settings, publish, variant, templateVariant];

export const en = Object.assign({}, ...areas.map((area) => area.en)) as Merge<typeof shell.en> &
  Merge<typeof rail.en> &
  Merge<typeof chat.en> &
  Merge<typeof display.en> &
  Merge<typeof agents.en> &
  Merge<typeof settings.en> &
  Merge<typeof publish.en> &
  Merge<typeof variant.en> &
  Merge<typeof templateVariant.en>;

export type MessageKey = keyof typeof en;

export const he = Object.assign({}, ...areas.map((area) => area.he)) as Record<MessageKey, string>;

type Merge<T> = { [K in keyof T]: string };
