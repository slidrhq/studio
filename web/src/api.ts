/**
 * The studio's state, as the server keeps it, and the calls that change it. The server pushes
 * every change over server-sent events; a page that reconnects reads the whole state again.
 */
import { BASE_LANGUAGES, languagesOf } from '@slidr/model';
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
 * languages. `auto` is a request in words that the server is still reading; it becomes one of
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
  /** How the server read a request in words. */
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
  cost: number;
  updatedAt: number;
}

export interface PublishReport {
  files: number;
  bytes: number;
  before: number;
  added: string[];
  changed: string[];
  removed: string[];
  blocked: string | null;
  ours: string[];
  unexpected: string[];
}

export interface PublishState {
  phase: 'idle' | 'preparing' | 'prepared' | 'publishing' | 'done' | 'failed';
  items: string[];
  report: PublishReport | null;
  log: { t: number; text: string }[];
  error: string | null;
  at: number | null;
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
  media: { dir: string; exists: boolean; url: string };
  cloudflare: { accountId: string; token: boolean };
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
  publish: PublishState;
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
  publish: { phase: 'idle', items: [], report: null, log: [], error: null, at: null },
  connected: false,
  loaded: false,
};
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    let detail = `${response.status}`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (body.detail)
        detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch {
      // Not JSON: the status says enough.
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

const post = <T = unknown>(path: string, body: unknown = {}) =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body) });

async function load() {
  const data = await call<{
    requests: StudioRequest[];
    variants: Variant[];
    publish: PublishState;
  }>('/api/state');
  set({
    requests: data.requests,
    variants: Object.fromEntries(data.variants.map((variant) => [variant.id, variant])),
    publish: data.publish,
    loaded: true,
  });
}

let source: EventSource | undefined;

function connect() {
  if (source) return;
  source = new EventSource('/api/events');
  source.onopen = () => {
    set({ connected: true });
    void load();
  };
  source.onerror = () => set({ connected: false });
  source.onmessage = (message: MessageEvent<string>) => {
    const event = JSON.parse(message.data) as
      | { type: 'request'; request: StudioRequest }
      | { type: 'requestDeleted'; id: string }
      | { type: 'variant'; variant: Variant }
      | { type: 'publish'; publish: PublishState };
    if (event.type === 'request') {
      const others = state.requests.filter((request) => request.id !== event.request.id);
      set({ requests: [...others, event.request].sort((a, b) => a.createdAt - b.createdAt) });
    } else if (event.type === 'requestDeleted') {
      set({ requests: state.requests.filter((request) => request.id !== event.id) });
    } else if (event.type === 'variant') {
      set({ variants: { ...state.variants, [event.variant.id]: event.variant } });
    } else {
      set({ publish: event.publish });
    }
  };
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
  status: () => call<ServerStatus>('/api/status'),
  library: (fresh = false) => call<LibraryInfo>(`/api/library${fresh ? '?fresh=true' : ''}`),
  templates: (fresh = false) =>
    call<{ templates: TemplateInfo[] }>(`/api/templates${fresh ? '?fresh=true' : ''}`),
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
  }) => post<StudioRequest>('/api/requests', body),
  more: (rid: string, count: number) => post(`/api/requests/${rid}/more`, { count }),
  cancelRequest: (rid: string) => post(`/api/requests/${rid}/cancel`),
  deleteRequest: (rid: string) => call(`/api/requests/${rid}`, { method: 'DELETE' }),
  retry: (vid: string) => post(`/api/variants/${vid}/retry`),
  cancel: (vid: string) => post(`/api/variants/${vid}/cancel`),
  refine: (vid: string, feedback: string) => post(`/api/variants/${vid}/refine`, { feedback }),
  newImage: (vid: string, instruction: string) =>
    post(`/api/variants/${vid}/image`, { instruction }),
  approve: (vid: string, value: boolean) => post(`/api/variants/${vid}/approve`, { value }),
  discard: (vid: string, value: boolean) => post(`/api/variants/${vid}/discard`, { value }),
  prepare: (variantIds?: string[]) =>
    post('/api/publish/prepare', { variantIds: variantIds ?? null }),
  confirm: () => post('/api/publish/confirm'),
  cancelPublish: () => post('/api/publish/cancel'),
  cloudflare: (token: string, accountId: string) =>
    post<{ accountId: string; token: boolean }>('/api/settings/cloudflare', { token, accountId }),
};

/* ---------------------------------------------------------------- renders */

const results = new Map<string, Promise<DesignResult>>();

/** The converted slides of a variant's render, read once per revision. */
export function renderResult(vid: string, revision: number): Promise<DesignResult> {
  const key = `${vid}:${revision}`;
  let pending = results.get(key);
  if (!pending) {
    pending = call<DesignResult>(`/api/variants/${vid}/result`);
    pending.catch(() => results.delete(key));
    results.set(key, pending);
  }
  return pending;
}

export const pictureUrl = (variant: Variant) =>
  `/api/variants/${variant.id}/files/subject.png?r=${variant.render?.imageRevision ?? variant.imageRevision}`;

export const isTemplate = (variant: Variant) => variant.kind === 'template';

/** A picture of a template variant's last render: `sheet`, `s01-full`, `s01-thumb`… */
export const renderPicture = (variant: Variant, name: string) =>
  `/api/variants/${variant.id}/files/renders/r${variant.render?.revision ?? 0}/${name}.png`;

const templateResults = new Map<string, Promise<TemplateResult>>();

/** The findings of a template variant's render, slide by slide, read once per revision. */
export function templateResult(vid: string, revision: number): Promise<TemplateResult> {
  const key = `${vid}:${revision}`;
  let pending = templateResults.get(key);
  if (!pending) {
    pending = call<TemplateResult>(`/api/variants/${vid}/result`);
    pending.catch(() => templateResults.delete(key));
    templateResults.set(key, pending);
  }
  return pending;
}
