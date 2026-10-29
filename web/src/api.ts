/**
 * The studio's state, as the studio's Rust side keeps it (src-tauri), and the commands that
 * change it. Rust sends every change as a `studio` event; the window reads the whole state once
 * it listens. A variant's files (its picture, its renders) are read through the `studio:`
 * protocol (src-tauri/src/files.rs).
 *
 * The studio works in chats: each message the person sends either asks for work (a request,
 * which makes variants: the outputs the display panel shows) or asks for a change to outputs it
 * names. Three agents do the work, each chosen in the settings and, for one chat, in its
 * composer: the design agent makes the English master, the images agent the pictures, and the
 * translation agent the other fifteen languages and the template samples.
 */
import { BASE_LANGUAGES, languagesOf } from '@slidr/model';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSyncExternalStore } from 'react';
import type { DesignResult, Lang } from './design';
import type { TemplateResult } from './template';

export type { Lang } from './design';
/**
 * The language the studio shows its designs in: any content language. A variant not made in it
 * is shown in English, as the app gives it to a deck in that language.
 */
export type DisplayLang = Lang;
/** A name in the gallery: in Hebrew and English, whatever languages the design is made in. */
export type Named = { he: string; en: string };

/* ---------------------------------------------------------------- agents and settings */

export type AgentRole = 'design' | 'images' | 'translation';
export type AgentProgram = 'claude' | 'codex';
/** An empty model or effort is the program's default. Images take only Codex, without effort. */
export interface AgentChoice {
  program: AgentProgram;
  model: string;
  effort: string;
}
export type Agents = Record<AgentRole, AgentChoice>;
export const AGENT_ROLES: readonly AgentRole[] = ['design', 'images', 'translation'];

export interface StudioSettings {
  agents: Agents;
  /** Review rounds of every design and sample: 0 to 3. */
  reviewRounds: number;
}

/** The agents a chat works with: its own choices over the settings. */
export function agentsOf(settings: StudioSettings | undefined, chat?: Chat): Agents | undefined {
  if (!settings) return undefined;
  const own = chat?.agents ?? {};
  return {
    design: own.design ?? settings.agents.design,
    images: own.images ?? settings.agents.images,
    translation: own.translation ?? settings.agents.translation,
  };
}

/* ---------------------------------------------------------------- chats */

/**
 * What the rail makes. Only designs and templates (and `auto`, a request in words the studio
 * reads) can be made and published today; the library takes no new items of the others yet.
 */
export type ChatKind =
  'auto' | 'design' | 'template' | 'cards' | 'frames' | 'shapes' | 'graphics' | 'emoji' | 'fonts';

export interface ChatMessage {
  id: string;
  at: number;
  role: 'user' | 'studio';
  text: string;
  /** The kind chosen on the rail when it was sent. */
  kind?: ChatKind;
  /** The outputs the message is about: a change asked for in words. */
  refs?: string[];
  /** The requests it started. */
  requestIds?: string[];
  /** What could not be done for some of its outputs. */
  errors?: { variantId?: string; error: string }[];
}

export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** This chat's own agents, over the settings. */
  agents?: Partial<Agents>;
  messages: ChatMessage[];
}

/* ---------------------------------------------------------------- requests and variants */

/**
 * What a request makes: designs for the gallery, or the sample of a built-in template in
 * languages. `auto` is a request in words that the studio is still reading; it becomes one of
 * the two. A request from before there were kinds is a design.
 */
export type RequestKind = 'design' | 'template' | 'auto';

export interface StudioRequest {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: 'planning' | 'ready' | 'failed' | 'cancelled';
  kind?: RequestKind;
  prompt: string;
  title: string;
  count?: number;
  group?: string;
  model: string;
  effort: string;
  reviewRounds: number;
  languages?: Lang[];
  /** A template request's template, and what the person asked beyond writing it. */
  templateId?: string;
  instructions?: string;
  /** How the studio read a request in words. */
  route?: { kind: string; reason: string };
  /** The chat it was asked in. */
  chatId?: string;
  /** The agents in force when it was asked. */
  agents?: Agents;
  variantIds: string[];
  error: string | null;
  cost: number;
}

/** A built-in template, with the languages its sample is written in and those it lacks. */
export interface TemplateInfo {
  id: string;
  name: Named;
  tagline: Named;
  languages: Lang[];
  missing: Lang[];
}

export interface LogEntry {
  t: number;
  kind: string;
  text: string;
}

export type VariantStatus =
  | 'queued'
  | 'image'
  | 'writing'
  | 'rendering'
  | 'reviewing'
  | 'translating'
  | 'publishing'
  | 'ready'
  | 'failed'
  | 'cancelled';

/**
 * A design's phase: the English master alone, then (once the master is approved) the other
 * languages being made, then every language. None on a template's sample, and on a design from
 * before (made in all its languages at once): taken as `full`.
 */
export type Phase = 'master' | 'translating' | 'full';

export interface Variant {
  id: string;
  requestId: string;
  index: number;
  /** A design (the default), or a template's sample in one language (`lang`, `templateId`). */
  kind?: 'design' | 'template';
  designId: string | null;
  templateId?: string;
  lang?: Lang;
  phase?: Phase;
  /** A design's concept; a template variant's task, whose `name` is the template's. */
  brief: {
    id?: string;
    name: Named;
    /** The design's name in every language it has one in. */
    names?: Partial<Record<Lang, string>>;
    group?: string;
    groupName?: Partial<Named>;
    /** The words the gallery's search finds the design by, in any language (ADR-108). */
    tags?: Partial<Record<Lang, string[]>>;
    concept?: string;
    art?: string;
    image?: { prompt: string; aspect: string };
    instructions?: string;
    rewrite?: boolean;
  };
  /** The languages it is to be made in. */
  languages?: Lang[];
  status: VariantStatus;
  stage: string | null;
  error: string | null;
  log: LogEntry[];
  revision: number;
  render: {
    revision: number;
    imageRevision: number;
    publishable: boolean;
    errors: number;
    warnings: number;
    issues: number;
    editability: Partial<Record<Lang, number>>;
  } | null;
  image: { width: number; height: number; revision: number; prompt: string; aspect: string } | null;
  imageRevision: number;
  reviews: number;
  approved: boolean;
  discarded?: boolean;
  published: { at: number; revision: number } | null;
  /** The upload it was sent to the library as, when it was. */
  /** The upload it was sent as: its status in the library, and why it waits there. */
  upload?: { id: string; status?: string; at: number; note?: string };
  /** Why the last publication failed. */
  publishError?: string | null;
  cost: number;
  updatedAt: number;
}

/**
 * The languages a variant is made in: its own, else those of its render, else Hebrew and English
 * (a variant from before a request chose its languages).
 */
export function languagesOfVariant(variant: Variant, result?: DesignResult): Lang[] {
  if (variant.languages?.length) return variant.languages;
  return result ? languagesOf(result.langs) : [...BASE_LANGUAGES];
}

export interface ProgramStatus {
  name: string;
  path: string | null;
  version: string | null;
  ready: boolean;
  note: string | null;
}

export interface ServerStatus {
  programs: ProgramStatus[];
  /** Where the library is published, which the studio reads. */
  media: { url: string };
  /** Slidr Library, whose upload API takes the approved work, and whether the studio has a token. */
  library: { url: string; token: boolean };
}

/** What became of one item sent to the library's upload API. */
export interface UploadItem {
  variantId: string;
  uploadId?: string;
  status?: string;
  note?: string | null;
  missing?: string[];
  error?: string;
  issues?: { path: string; message: string; language?: string }[];
}

/** The slides of the published designs that the library has no picture of (src-tauri/src/gallery.rs). */
export interface GalleryMissing {
  slides?: number;
  designs?: number;
  /** The library's words are of it before it changed: drawing has it write them first. */
  stale?: boolean;
}

/** What a drawing of the galleries' pictures did: an upload of each design, and what failed. */
export interface GalleryDrawn {
  missing: number;
  uploads: (Omit<UploadItem, 'variantId'> & { id: string; langs: string[] })[];
  failed: { id: string; lang: string; error: string }[];
}

export interface LibraryInfo {
  groups: { id: string; he?: string; en?: string }[];
  ids: string[];
  reachable: boolean;
}

/** What approving an output did: started its translation, or its publication, or nothing. */
export interface ApproveItem {
  variantId: string;
  action: 'translate' | 'publish' | 'skip';
  error?: string;
}

/* ---------------------------------------------------------------- the store */

interface State {
  requests: StudioRequest[];
  variants: Record<string, Variant>;
  chats: Chat[];
  settings?: StudioSettings;
  connected: boolean;
  loaded: boolean;
}

const RUNNING: ReadonlySet<VariantStatus> = new Set([
  'queued',
  'image',
  'writing',
  'rendering',
  'reviewing',
  'translating',
  'publishing',
]);
export const isRunning = (variant: Variant) => RUNNING.has(variant.status);

let state: State = {
  requests: [],
  variants: {},
  chats: [],
  connected: false,
  loaded: false,
};
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/** A command of the studio; a refusal is its reason, in words. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(typeof error === 'string' ? error : JSON.stringify(error), { cause: error });
  }
}

const byCreation = <T extends { createdAt: number }>(list: T[]) =>
  [...list].sort((a, b) => a.createdAt - b.createdAt);

async function load() {
  const data = await call<{
    requests: StudioRequest[];
    variants: Variant[];
    chats?: Chat[];
  }>('studio_state');
  set({
    requests: byCreation(data.requests),
    variants: Object.fromEntries(data.variants.map((variant) => [variant.id, variant])),
    chats: byCreation(data.chats ?? []),
    loaded: true,
  });
  void call<{ settings: StudioSettings }>('settings_get').then(
    ({ settings }) => set({ settings }),
    () => undefined,
  );
}

type StudioEvent =
  | { type: 'request'; request: StudioRequest }
  | { type: 'requestDeleted'; id: string }
  | { type: 'variant'; variant: Variant }
  | { type: 'chat'; chat: Chat }
  | { type: 'chatDeleted'; id: string }
  | { type: 'settings'; settings: StudioSettings };

let listening = false;

/** Where Slidr Library asks the studio to open a request and a variant (the local server). */
export type OpenEvent = { tab?: string | null; v?: string | null };
const openers = new Set<(open: OpenEvent) => void>();

/** Hears Slidr Library ask for a request and a variant (src-tauri/src/local_server.rs). */
export function onOpen(handler: (open: OpenEvent) => void): () => void {
  openers.add(handler);
  return () => openers.delete(handler);
}

function connect() {
  if (listening) return;
  listening = true;
  void listen<StudioEvent>('studio', ({ payload }) => receive(payload)).then(
    () => {
      set({ connected: true });
      void load();
    },
    () => set({ connected: false }),
  );
  void listen<OpenEvent>('open', ({ payload }) => {
    for (const handler of openers) handler(payload);
  });
}

function receive(event: StudioEvent) {
  switch (event.type) {
    case 'request': {
      const others = state.requests.filter((request) => request.id !== event.request.id);
      set({ requests: byCreation([...others, event.request]) });
      break;
    }
    case 'requestDeleted':
      set({ requests: state.requests.filter((request) => request.id !== event.id) });
      break;
    case 'variant':
      set({ variants: { ...state.variants, [event.variant.id]: event.variant } });
      break;
    case 'chat': {
      const others = state.chats.filter((chat) => chat.id !== event.chat.id);
      set({ chats: byCreation([...others, event.chat]) });
      break;
    }
    case 'chatDeleted':
      set({ chats: state.chats.filter((chat) => chat.id !== event.id) });
      break;
    case 'settings':
      set({ settings: event.settings });
      break;
  }
}

export function useStudio(): State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      connect();
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/* ---------------------------------------------------------------- calls */

export interface ChatSend {
  chatId?: string;
  text: string;
  kind: ChatKind;
  refs?: string[];
  templateId?: string;
  languages?: Lang[];
  count?: number;
}

export const api = {
  status: () => call<ServerStatus>('studio_status'),
  library: (fresh = false) => call<LibraryInfo>('library_known', { fresh }),
  templates: (fresh = false) => call<{ templates: TemplateInfo[] }>('template_listing', { fresh }),
  settings: () =>
    call<{ settings: StudioSettings; library: { url: string; token: boolean } }>('settings_get'),
  saveSettings: async (settings: StudioSettings) => {
    const saved = await call<StudioSettings>('settings_set', { settings });
    set({ settings: saved });
    return saved;
  },
  send: async (body: ChatSend) => {
    const chat = await call<Chat>('chat_send', { body });
    receive({ type: 'chat', chat });
    return chat;
  },
  chatAgents: async (chatId: string, agents: Partial<Agents> | null) => {
    const chat = await call<Chat>('chat_agents', { chatId, agents });
    receive({ type: 'chat', chat });
    return chat;
  },
  deleteChat: (chatId: string) => call('chat_delete', { chatId }),
  approveMany: (vids: string[]) => call<{ items: ApproveItem[] }>('variants_approve', { vids }),
  more: (rid: string, count: number) => call('request_more', { rid, count }),
  cancelRequest: (rid: string) => call('request_cancel', { rid }),
  deleteRequest: (rid: string) => call('request_delete', { rid }),
  retry: (vid: string) => call('variant_retry', { vid }),
  cancel: (vid: string) => call('variant_cancel', { vid }),
  refine: (vid: string, feedback: string) => call('variant_refine', { vid, feedback }),
  newImage: (vid: string, instruction: string) => call('variant_image', { vid, instruction }),
  approve: (vid: string, value: boolean) => call('variant_approve', { vid, value }),
  discard: (vid: string, value: boolean) => call('variant_discard', { vid, value }),
  /** The status of the uploads these variants were sent as, as the library has them now. */
  statuses: (variantIds: string[]) =>
    call<{ items: UploadItem[] }>('library_statuses', { variantIds }),
  librarySettings: (token: string, url = '') =>
    call<{ url: string; token: boolean }>('library_settings', { token, url }),
  galleryMissing: () => call<GalleryMissing>('gallery_missing'),
  galleryDraw: () => call<GalleryDrawn>('gallery_draw'),
};

/** A file of a variant's working folder, through the studio's `studio:` protocol. */
export const fileUrl = (vid: string, path: string, revision?: number) =>
  convertFileSrc(`${vid}/${path}`, 'studio') + (revision === undefined ? '' : `?r=${revision}`);

/* ---------------------------------------------------------------- renders */

const results = new Map<string, Promise<DesignResult>>();

/** The converted slides of a variant's render, read once per revision. */
export function renderResult(vid: string, revision: number): Promise<DesignResult> {
  const key = `${vid}:${revision}`;
  let pending = results.get(key);
  if (!pending) {
    pending = call<DesignResult>('variant_result', { vid });
    pending.catch(() => results.delete(key));
    results.set(key, pending);
  }
  return pending;
}

export const pictureUrl = (variant: Variant) =>
  fileUrl(variant.id, 'subject.png', variant.render?.imageRevision ?? variant.imageRevision);

export const isTemplate = (variant: Variant) => variant.kind === 'template';

/** A picture of a template variant's last render: `sheet`, `s01-full`, `s01-thumb`… */
export const renderPicture = (variant: Variant, name: string) =>
  fileUrl(variant.id, `renders/r${variant.render?.revision ?? 0}/${name}.png`);

const templateResults = new Map<string, Promise<TemplateResult>>();

/** The findings of a template variant's render, slide by slide, read once per revision. */
export function templateResult(vid: string, revision: number): Promise<TemplateResult> {
  const key = `${vid}:${revision}`;
  let pending = templateResults.get(key);
  if (!pending) {
    pending = call<TemplateResult>('variant_result', { vid });
    pending.catch(() => templateResults.delete(key));
    templateResults.set(key, pending);
  }
  return pending;
}
