import type { VariantStatus } from './api';
import type { MessageKey } from './i18n';

/**
 * Labels are message keys: show one with `t(STATUS[status])`. Designs are shown in both
 * languages; the studio itself follows the language chosen.
 */
export const STATUS: Record<VariantStatus, MessageKey> = {
  queued: 'shell.statusQueued',
  image: 'shell.statusImage',
  writing: 'shell.statusWriting',
  rendering: 'shell.statusRendering',
  reviewing: 'shell.statusReviewing',
  ready: 'shell.statusReady',
  failed: 'shell.statusFailed',
  cancelled: 'shell.statusCancelled',
};

export const STAGE: Record<string, MessageKey> = {
  'waiting for Claude': 'shell.stageWaitingClaude',
  'waiting for Codex': 'shell.stageWaitingCodex',
  'waiting for the browser': 'shell.stageWaitingBrowser',
};

/** Log kinds that are translated; `text` and `claude` are a product name (see `LOG_PLAIN`). */
export const LOG_KIND: Record<string, MessageKey | undefined> = {
  tool: 'shell.logTool',
  image: 'shell.logImage',
  render: 'shell.logRender',
  error: 'shell.logError',
  info: 'shell.logInfo',
  feedback: 'shell.logFeedback',
  approval: 'shell.logApproval',
  publish: 'shell.logPublish',
};

/** Log kinds that are shown as a name, not translated. */
export const LOG_PLAIN: Record<string, string> = { text: 'Claude', claude: 'Claude' };

/** `labelKey` is a message key; `label` is a name that is not translated. */
export const MODELS: { value: string; label?: string; labelKey?: MessageKey }[] = [
  { value: '', labelKey: 'shell.modelDefault' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
];

export const EFFORTS: { value: string; labelKey: MessageKey }[] = [
  { value: '', labelKey: 'shell.effortDefault' },
  { value: 'medium', labelKey: 'shell.effortMedium' },
  { value: 'high', labelKey: 'shell.effortHigh' },
  { value: 'xhigh', labelKey: 'shell.effortXhigh' },
  { value: 'max', labelKey: 'shell.effortMax' },
];

/** The phase of a publish; `idle` has no label. */
export const PUBLISH_PHASE: Record<string, MessageKey | undefined> = {
  preparing: 'shell.phasePreparing',
  prepared: 'shell.phasePrepared',
  publishing: 'shell.phasePublishing',
  done: 'shell.phaseDone',
  failed: 'shell.phaseFailed',
};

/** The time of day in the language shown (Hebrew when none is given). */
export const time = (seconds: number, lang = 'he') =>
  new Date(seconds * 1000).toLocaleTimeString(lang === 'he' ? 'he-IL' : lang, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export const money = (usd: number) => (usd > 0 ? `$${usd.toFixed(2)}` : '');
