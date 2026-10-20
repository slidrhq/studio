/**
 * Every word of the studio, by key. Each area of the interface keeps its own words in
 * `areas/<area>.ts`, in Hebrew and English; the other languages are in `locales/<lang>.ts`,
 * read when the language is chosen. A value holds `{name}` where a number or a name goes.
 */
import * as form from './areas/form';
import * as publish from './areas/publish';
import * as request from './areas/request';
import * as shell from './areas/shell';
import * as templateVariant from './areas/templateVariant';
import * as variant from './areas/variant';

const areas = [shell, publish, form, request, variant, templateVariant];

export const en = Object.assign({}, ...areas.map((area) => area.en)) as Merge<typeof shell.en> &
  Merge<typeof publish.en> &
  Merge<typeof form.en> &
  Merge<typeof request.en> &
  Merge<typeof variant.en> &
  Merge<typeof templateVariant.en>;

export type MessageKey = keyof typeof en;

export const he = Object.assign({}, ...areas.map((area) => area.he)) as Record<MessageKey, string>;

type Merge<T> = { [K in keyof T]: string };
