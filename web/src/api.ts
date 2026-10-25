/**
 * The studio's state, as the studio's Rust side keeps it (src-tauri), and the commands that
 * change it. Rust sends every change as a `studio` event; the window reads the whole state once
 * it listens. A variant's files (its picture, its renders) are read through the `studio:`
 * protocol (src-tauri/src/files.rs).
 */
import { BASE_LANGUAGES, languagesOf } from '@slidr/model';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSyncExternalStore } from 'react';
import type { DesignResult, Lang } from './design';
import type { TemplateResult } from './template';

export type { Lang } from './design';
/**
 * The language the studio shows its designs and the library in: any content language. The
 * library shows only the pieces written in it; the studio shows a variant not made in it in
 * English, as the app gives it to a deck in that language.
 */
export type DisplayLang = Lang;
/** A name in the gallery: in Hebrew and English, whatever languages the design is made in. */
export type Named = { he: string; en: string };

/**
 * The languages a variant is made in: its own, else those of its render, else Hebrew and English
 * (a variant from before a request chose its languages).
 */
export function languagesOfVariant(variant: Variant, result?: DesignResult): Lang[] {
  if (variant.languages?.length) return variant.languages;
  return result ? languagesOf(result.langs) : [...BASE_LANGUAGES];
}

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
  /**
   * A design's: Hebrew and English, and the other languages asked for; none on a request from
   * before. A template's: the languages its sample is written in, a variant each.
   */
  languages?: Lang[];
  /** A template request's template, and what the person asked beyond writing it. */
  templateId?: string;
  instructions?: string;
  /** How the studio read a request in words. */
  route?: { kind: string; reason: string };
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
  'queued' | 'image' | 'writing' | 'rendering' | 'reviewing' | 'ready' | 'failed' | 'cancelled';

export interface Variant {
  id: string;
  requestId: string;
  index: number;
  /** A design (the default, and every variant from before there were kinds), or a template's
   * sample in one language (`lang`, `templateId`), which has no design id. */
  kind?: 'design' | 'template';
  designId: string | null;
  templateId?: string;
  lang?: Lang;
  /** A design's concept; a template variant's task, whose `name` is the template's. */
  brief: {
    id?: string;
    name: Named;
    group?: string;
    groupName?: Partial<Named>;
    /** The words the gallery's search finds the design by (ADR-108 of the app). */
    tags?: { he: string[]; en: string[] };
    concept?: string;
    art?: string;
    image?: { prompt: string; aspect: string };
    instructions?: string;
    rewrite?: boolean;
  };
  /** The languages it is made in, its request's; none on a variant from before (`languagesOfVariant`). */
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
  /** The upload it was sent to the library as, when it was (`POST /api/upload`). */
  upload?: { id: string; status?: string; at: number };
  cost: number;
  updatedAt: number;
}

/** An upload of the library that a publication takes, or took: what it is, and what it wrote. */
export interface LibraryUpload {
  id: string;
  type: string;
  action: string;
  target: string;
  languages: string[];
  by?: string | null;
  updated?: string;
  /** The files of the library it wrote, once it was published. */
  paths?: string[];
}

/** Where the published library is, as the library says (`GET /api/library` of its API). */
export interface LibraryState {
  /** Whether the library is in its bucket, where a publication writes. */
  live: boolean;
  published?: string;
  files?: number;
  bytes?: number;
  /** The uploads the next publication takes. */
  accepted: number;
}

/** What came of a publication (`POST /api/publish` of the library's API). */
export interface Publication {
  published?: string;
  uploads: LibraryUpload[];
  skipped: { id: string; message: string; issues?: { path: string; message: string }[] }[];
  added: string[];
  changed: string[];
  remaining: number;
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

/** What became of one approved item sent to the library's upload API. */
export interface UploadItem {
  variantId: string;
  /** The upload it waits as, in the library. */
  uploadId?: string;
  status?: string;
  missing?: string[];
  /** Why the library did not take it, and each issue at its place. */
  error?: string;
  issues?: { path: string; message: string; language?: string }[];
}

export interface LibraryInfo {
  groups: { id: string; he?: string; en?: string }[];
  ids: string[];
  managed: number;
  authored: number;
  reachable: boolean;
}

interface State {
  requests: StudioRequest[];
  variants: Record<string, Variant>;
  connected: boolean;
  loaded: boolean;
}

const RUNNING: ReadonlySet<VariantStatus> = new Set([
  'queued',
  'image',
  'writing',
  'rendering',
  'reviewing',
]);
export const isRunning = (variant: Variant) => RUNNING.has(variant.status);

let state: State = {
  requests: [],
  variants: {},
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

async function load() {
  const data = await call<{
    requests: StudioRequest[];
    variants: Variant[];
  }>('studio_state');
  set({
    requests: data.requests,
    variants: Object.fromEntries(data.variants.map((variant) => [variant.id, variant])),
    loaded: true,
  });
}

type StudioEvent =
  | { type: 'request'; request: StudioRequest }
  | { type: 'requestDeleted'; id: string }
  | { type: 'variant'; variant: Variant };

let listening = false;

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
  // Slidr Library opens a request and a variant here (src-tauri/src/local_server.rs).
  void listen<{ tab?: string | null; v?: string | null }>('open', ({ payload }) => {
    const params = new URLSearchParams();
    if (payload.tab) params.set('tab', payload.tab);
    if (payload.v) params.set('v', payload.v);
    location.hash = `#${params}`;
  });
}

function receive(event: StudioEvent) {
  if (event.type === 'request') {
    const others = state.requests.filter((request) => request.id !== event.request.id);
    set({ requests: [...others, event.request].sort((a, b) => a.createdAt - b.createdAt) });
  } else if (event.type === 'requestDeleted') {
    set({ requests: state.requests.filter((request) => request.id !== event.id) });
  } else {
    set({ variants: { ...state.variants, [event.variant.id]: event.variant } });
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

export const api = {
  status: () => call<ServerStatus>('studio_status'),
  library: (fresh = false) => call<LibraryInfo>('library_known', { fresh }),
  templates: (fresh = false) => call<{ templates: TemplateInfo[] }>('template_listing', { fresh }),
  newRequest: (body: {
    kind: RequestKind;
    prompt: string;
    templateId?: string;
    count: number;
    group: string;
    model: string;
    effort: string;
    reviewRounds: number;
    languages: Lang[];
  }) => call<StudioRequest>('request_new', { body }),
  more: (rid: string, count: number) => call('request_more', { rid, count }),
  cancelRequest: (rid: string) => call('request_cancel', { rid }),
  deleteRequest: (rid: string) => call('request_delete', { rid }),
  retry: (vid: string) => call('variant_retry', { vid }),
  cancel: (vid: string) => call('variant_cancel', { vid }),
  refine: (vid: string, feedback: string) => call('variant_refine', { vid, feedback }),
  newImage: (vid: string, instruction: string) => call('variant_image', { vid, instruction }),
  approve: (vid: string, value: boolean) => call('variant_approve', { vid, value }),
  discard: (vid: string, value: boolean) => call('variant_discard', { vid, value }),
  /** The uploads the library's editors accepted, which the next publication takes. */
  accepted: () => call<{ uploads: LibraryUpload[] }>('library_accepted'),
  /** Where the published library is, and how many uploads wait for it. */
  libraryState: () => call<LibraryState>('library_state'),
  /** Has the library publish its accepted uploads (or those named), through its API. */
  publish: (uploadIds?: string[]) =>
    call<Publication>('library_publish', { uploadIds: uploadIds ?? null }),
  upload: (variantIds?: string[]) =>
    call<{ items: UploadItem[] }>('library_upload', { variantIds: variantIds ?? null }),
  librarySettings: (token: string, url = '') =>
    call<{ url: string; token: boolean }>('library_settings', { token, url }),
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
