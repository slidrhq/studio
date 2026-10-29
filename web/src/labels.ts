import type { MessageKey } from './i18n';

/** What a variant waits for while it runs, as Rust names it (`variant.stage`). */
export const STAGE: Record<string, MessageKey> = {
  'waiting for Claude': 'shell.stageWaitingClaude',
  'waiting for Codex': 'shell.stageWaitingCodex',
  'waiting for the browser': 'shell.stageWaitingBrowser',
  'waiting for the agent': 'shell.stageWaitingAgent',
  'waiting for the library': 'shell.stageWaitingLibrary',
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
export const LOG_PLAIN: Record<string, string> = {
  text: 'Claude',
  claude: 'Claude',
  codex: 'Codex',
};

/** The time of day in the language shown (Hebrew when none is given). */
export const time = (seconds: number, lang = 'he') =>
  new Date(seconds * 1000).toLocaleTimeString(lang === 'he' ? 'he-IL' : lang, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export const money = (usd: number) => (usd > 0 ? `$${usd.toFixed(2)}` : '');
