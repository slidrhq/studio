/**
 * What the window shows, kept here and not in Rust: the chat open, the middle panel (the chat or
 * the settings), the kind the next message makes, the outputs selected in the display panel
 * (which the next message is about), and the output open up close. The chat and the output open
 * are in the address (`#chat=<id>&v=<id>`), so a reload keeps them.
 */
import { useSyncExternalStore } from 'react';
import type { Agents, ChatKind, Lang } from './api';

export type Panel = 'chat' | 'settings';
export type Scope = 'chat' | 'all';

export interface UiState {
  /** The chat shown; null for a new one, made by its first message. */
  chatId: string | null;
  panel: Panel;
  kind: ChatKind;
  /** The outputs selected: the next message asks for a change to them. */
  selected: string[];
  scope: Scope;
  /** The language the outputs are shown in; null follows the studio's own. */
  displayLang: Lang | null;
  /** The output open up close. */
  detail: string | null;
  /** Outputs to show the person, briefly marked: those a message of the chat made. */
  highlight: string[];
  /** The agents chosen in a chat that does not exist yet, given to it once it does. */
  pendingAgents: Partial<Agents> | null;
  /** The words being written in the composer. */
  draft: string;
  /** Raised to have the composer take the focus. */
  focusComposer: number;
  /** The width of the middle panel the person dragged, as a share of the window. */
  panelShare: number | null;
}

const SHARE_KEY = 'slidr.studio.panelShare';

function readHash(): { chatId: string | null; detail: string | null; tab: string | null } {
  const params = new URLSearchParams(location.hash.slice(1));
  return { chatId: params.get('chat'), detail: params.get('v'), tab: params.get('tab') };
}

function readShare(): number | null {
  const stored = Number(localStorage.getItem(SHARE_KEY));
  return Number.isFinite(stored) && stored > 0 && stored < 1 ? stored : null;
}

const fromHash = readHash();

let state: UiState = {
  chatId: fromHash.chatId,
  panel: 'chat',
  kind: 'auto',
  selected: [],
  scope: 'chat',
  displayLang: null,
  detail: fromHash.detail,
  highlight: [],
  pendingAgents: null,
  draft: '',
  focusComposer: 0,
  panelShare: readShare(),
};

/** A request named by the address (`#tab=<rid>`, as Slidr Library opens one), to find its chat. */
export const requestedTab = fromHash.tab;

const listeners = new Set<() => void>();

function writeHash() {
  const params = new URLSearchParams();
  if (state.chatId) params.set('chat', state.chatId);
  if (state.detail) params.set('v', state.detail);
  const hash = params.size ? `#${params}` : '';
  if (hash !== location.hash) history.replaceState(null, '', hash || location.pathname);
}

export function setUi(change: Partial<UiState> | ((now: UiState) => Partial<UiState>)) {
  const next = typeof change === 'function' ? change(state) : change;
  state = { ...state, ...next };
  if ('chatId' in next || 'detail' in next) writeHash();
  if ('panelShare' in next) {
    if (state.panelShare === null) localStorage.removeItem(SHARE_KEY);
    else localStorage.setItem(SHARE_KEY, String(state.panelShare));
  }
  for (const listener of listeners) listener();
}

export function useUi(): UiState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

export const getUi = () => state;

/* ---------------------------------------------------------------- actions */

/** The rail: a kind for the next message, or back to reading the request when it is chosen. */
export function chooseKind(kind: ChatKind) {
  setUi((now) => ({
    kind: now.panel === 'chat' && now.kind === kind ? 'auto' : kind,
    panel: 'chat',
    focusComposer: now.focusComposer + 1,
  }));
}

export function toggleSettings() {
  setUi((now) => ({ panel: now.panel === 'settings' ? 'chat' : 'settings' }));
}

export function openChat(chatId: string | null) {
  setUi({ chatId, panel: 'chat', selected: [], highlight: [], pendingAgents: null });
}

export function toggleSelected(vid: string) {
  setUi((now) => ({
    selected: now.selected.includes(vid)
      ? now.selected.filter((one) => one !== vid)
      : [...now.selected, vid],
  }));
}

/** Asks for a change to an output in the chat: it alone is selected, and the composer waits. */
export function changeInChat(vid: string) {
  setUi((now) => ({
    selected: [vid],
    panel: 'chat',
    detail: null,
    focusComposer: now.focusComposer + 1,
  }));
}

let highlightTimer: ReturnType<typeof setTimeout> | undefined;

/** Marks outputs for a moment, in the chat's scope, and brings the first into view. */
export function showOutputs(vids: string[]) {
  clearTimeout(highlightTimer);
  setUi({ highlight: vids, scope: 'chat' });
  requestAnimationFrame(() =>
    document
      .querySelector(`[data-output="${CSS.escape(vids[0] ?? '')}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
  );
  highlightTimer = setTimeout(() => setUi({ highlight: [] }), 2400);
}
