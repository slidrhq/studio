/**
 * Where an output stands, as the cards, the chat and the status bar say it: being made, waiting
 * for the person's approval (of its English master, or of the whole to publish it), published,
 * or stopped. An output is a variant: a design concept, or a template's sample in one language.
 */
import { CONTENT_LANGUAGES } from '@slidr/model';
import { isRunning, isTemplate, type Lang, type Phase, type Variant } from './api';

/** A design's phase; a template's sample, and a design from before phases, are whole. */
export const phaseOf = (variant: Variant): Phase =>
  isTemplate(variant) ? 'full' : (variant.phase ?? 'full');

/** Published as it is now: no change since it went to the library. */
export const isPublished = (variant: Variant) =>
  Boolean(variant.published && variant.published.revision === variant.revision);

/**
 * What approving it does: its English master goes to be translated, or the whole is published. A
 * design from before the stages, in fewer languages than all, has the languages it lacks written
 * from its English first: the library takes a design only in every language.
 */
export const approveAction = (variant: Variant): 'translate' | 'publish' => {
  if (isTemplate(variant)) return 'publish';
  if (phaseOf(variant) === 'master') return 'translate';
  const langs = variant.languages?.length ?? 2;
  return !variant.phase && langs < CONTENT_LANGUAGES.length ? 'translate' : 'publish';
};

/** Ready, passing its contract, and not published as it is: the person's approval is next. */
export const awaitsApproval = (variant: Variant) =>
  variant.status === 'ready' &&
  !variant.discarded &&
  Boolean(variant.render?.publishable) &&
  !isPublished(variant);

export type OutputState =
  | 'working'
  | 'awaitingMaster'
  | 'awaitingPublish'
  | 'failsContract'
  | 'publishing'
  | 'published'
  | 'changedSincePublished'
  | 'publishFailed'
  | 'failed'
  | 'cancelled';

export function stateOf(variant: Variant): OutputState {
  if (variant.status === 'publishing') return 'publishing';
  if (isRunning(variant)) return 'working';
  if (variant.status === 'failed') return 'failed';
  if (variant.status === 'cancelled') return 'cancelled';
  if (isPublished(variant)) return 'published';
  if (variant.publishError) return 'publishFailed';
  if (!variant.render?.publishable) return 'failsContract';
  if (phaseOf(variant) === 'master') return 'awaitingMaster';
  return variant.published ? 'changedSincePublished' : 'awaitingPublish';
}

/**
 * The languages an output is made in so far, of those it is to be made in: the languages its
 * last render drew (a design's master, English alone; then every language).
 */
export function languageProgress(variant: Variant): { made: number; of: number } {
  if (isTemplate(variant)) return { made: variant.render ? 1 : 0, of: 1 };
  const made = Object.keys(variant.render?.editability ?? {}).length;
  const of = variant.languages?.length ?? Math.max(made, 2);
  return { made, of };
}

/** The language a design is shown in: the one asked for once it has it, else English. */
export const shownLanguage = (variant: Variant, lang: Lang): Lang =>
  variant.render?.editability && lang in variant.render.editability ? lang : 'en';
