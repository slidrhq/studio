import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_LIBRARY_URL } from '@slidr/media-library';
import { catalogChunks } from './mediaChunks.ts';
import type { Plugin } from 'vite';

/*
 * The media library on the side of Node (docs/media-library.md): the icon sets, the built-in
 * fonts of decks, the built-in templates and their photographs, and the content of Elements. It
 * is a site of its own on Cloudflare Pages, read by the app while it runs; none of it is built
 * into the app.
 *
 *   manifest.json                  every file below: its size and SHA-256 (written here)
 *   icons/lucide/*.json            the Lucide set: its drawings and its search words
 *   icons/tabler/*.json            the Tabler set: line and filled drawings, its search words
 *   icons/hebrew.json              the Hebrew search words of both sets
 *   fonts/catalog.json             the built-in fonts of decks, and fonts/<family>/*.woff2
 *   images/templates/*.webp        the photographs of the built-in templates
 *   images/designs/*.webp          the pictures of the ready-made slides of Elements
 *   images/frames/<lang>/*.webp    the event magnets as the Elements panel shows them, small
 *   elements/...                   the designs, card sets, shapes, graphics, frames, emoji, art
 *   templates/catalog.json         the built-in templates with their samples, as authored
 *   templates/index.json           their ids, in the order they are shown (written here)
 *   templates/<id>/template.json   each of them as a deck takes it (written here)
 *   templates/pictures.json        the pictures of their samples, by id (written here)
 *
 * Here are the two things Node does with it: a dev server serves it to a page in a plain
 * browser, as the core's `media` protocol does in the app; and `pnpm media:publish` stages an
 * author's copy of it for the site.
 */

/** Where a dev server serves the library to a page in a plain browser. */
export const MEDIA_PATH = '/media-library/';

/* ---------------------------------------------------------------- paths and types */

/**
 * The place in the library a path names: plain names joined by `/`. Undefined for a path that
 * climbs out, starts again at a root, or names a drive or a stream; the core refuses the same.
 */
export function libraryPath(path: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  const parts = decoded.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length === 0 || decoded.includes('\\') || decoded.includes(':')) return undefined;
  if (parts.some((part) => part === '.' || part === '..')) return undefined;
  return parts.join('/');
}

const TYPES: Record<string, string> = {
  json: 'application/json',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  html: 'text/html; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

/** The type a file of the library is served as, by its extension. */
export function contentType(path: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return TYPES[extension] ?? 'application/octet-stream';
}

/** `path`, ready to be joined to the address of the library. */
const encoded = (path: string) => path.split('/').map(encodeURIComponent).join('/');

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

/* ---------------------------------------------------------------- the dev server */

export interface MediaServerOptions {
  /** The site the library is read from: `SLIDR_MEDIA_URL`, or the published one. */
  upstream?: string;
  /** Where the files read are kept, so a page without the network still gets them. */
  cache?: string;
}

/** A read of a file of the library: its bytes, or why there are none. */
export interface Read {
  status: 200 | 404 | 503;
  body?: Buffer;
}

/**
 * Reads files of the library as the core's protocol does: from the site, kept in a cache, and
 * from the cache when the site cannot be reached. Each file is read from the site once per run
 * of the server, then from the cache.
 */
export function libraryReader({
  upstream = process.env.SLIDR_MEDIA_URL ?? MEDIA_LIBRARY_URL,
  cache = fileURLToPath(new URL('../node_modules/.cache/slidr-media/', import.meta.url)),
}: MediaServerOptions = {}): (path: string) => Promise<Read> {
  const base = withSlash(upstream);
  const fresh = new Set<string>();
  const kept = (path: string): Read => {
    const file = join(cache, ...path.split('/'));
    return existsSync(file) ? { status: 200, body: readFileSync(file) } : { status: 503 };
  };
  return async (path) => {
    const file = join(cache, ...path.split('/'));
    if (fresh.has(path)) {
      return existsSync(file) ? { status: 200, body: readFileSync(file) } : { status: 404 };
    }
    let response: Response;
    try {
      const timeout = path === 'manifest.json' ? 8_000 : 60_000;
      response = await fetch(base + encoded(path), { signal: AbortSignal.timeout(timeout) });
    } catch {
      return kept(path);
    }
    if (response.status === 404 || response.status === 410) {
      rmSync(file, { force: true });
      fresh.add(path);
      return { status: 404 };
    }
    if (!response.ok) return kept(path);
    let body: Buffer;
    try {
      body = Buffer.from(await response.arrayBuffer());
    } catch {
      return kept(path);
    }
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, body);
    renameSync(temp, file);
    fresh.add(path);
    return { status: 200, body };
  };
}

/**
 * Serves the library at `/media-library/` to the pages of the dev server and of `vite preview`,
 * and tells `@slidr/media-library` so (`__SLIDR_MEDIA_PATH__`). In the app the pages read it
 * through the core's protocol instead; in Node, from the site.
 */
export function mediaLibraryServer(options: MediaServerOptions = {}): Plugin {
  const read = libraryReader(options);
  const handle = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return next();
    const path = libraryPath((request.url ?? '').split('?')[0] ?? '');
    const answer = (status: number, body?: Buffer) => {
      response.statusCode = status;
      response.setHeader('Content-Type', body ? contentType(path ?? '') : 'text/plain');
      // Each run of the server reads the site again; the browser keeps nothing of it.
      response.setHeader('Cache-Control', 'no-store');
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (!path) return answer(404);
    void read(path).then(
      ({ status, body }) => answer(status, body),
      () => answer(503),
    );
  };
  return {
    name: 'slidr:media-library',
    config: () => ({ define: { __SLIDR_MEDIA_PATH__: JSON.stringify(MEDIA_PATH) } }),
    configureServer(server) {
      server.middlewares.use(MEDIA_PATH, handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(MEDIA_PATH, handle);
    },
  };
}

/* ---------------------------------------------------------------- publishing */

/** The folders of an author's library that are published. `elements/source` (the inputs of the
 * generators) and `archive` stay with the author. */
export const PUBLISHED_FOLDERS = [
  'elements/art',
  'elements/cards',
  'elements/catalogs',
  'elements/designs',
  'fonts',
  'icons',
  'images',
  'templates',
] as const;

/** The largest file Cloudflare Pages takes. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** The fields of the templates catalog the published template files come from. */
export interface TemplateCatalog {
  templates: { theme: { id: string }; sample?: unknown; assets?: unknown }[];
  pictures?: Record<string, unknown>;
}

/**
 * The files the library's publisher writes into `templates/` from its catalog, by their place in
 * that folder: the ids in their order, each template as a deck takes it (without its sample
 * slides and their pictures, which the app does not show), and the pictures of the samples.
 */
export function templateFiles(catalog: TemplateCatalog): Map<string, string> {
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const files = new Map<string, string>();
  files.set('index.json', json(catalog.templates.map((template) => template.theme.id)));
  for (const { sample: _sample, assets: _assets, ...template } of catalog.templates) {
    files.set(`${template.theme.id}/template.json`, json(template));
  }
  files.set('pictures.json', json(catalog.pictures ?? {}));
  return files;
}

export interface ManifestEntry {
  size: number;
  sha256: string;
}

/** The list of the library's files, as the core and the pages read it. */
export interface Manifest {
  version: 1;
  published: string;
  files: Record<string, ManifestEntry>;
}

export function manifestOf(files: ReadonlyMap<string, Buffer>, published: string): Manifest {
  const entries = [...files.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, bytes]): [string, ManifestEntry] => [
      path,
      { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    ]);
  return { version: 1, published, files: Object.fromEntries(entries) };
}

/** The files under `dir`, by their place in it; none when it is not there. Hidden files and the
 * thumbnail caches of Windows are not part of a library. */
function filesUnder(dir: string, prefix: string, into: Map<string, Buffer>): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'Thumbs.db' || name === 'desktop.ini') continue;
    const file = join(dir, name);
    const place = `${prefix}/${name}`;
    if (statSync(file).isDirectory()) filesUnder(file, place, into);
    else into.set(place, readFileSync(file));
  }
}

/** The files of the site besides the library's own: its headers, and a page for what is not there. */
const SITE_FILES: Record<string, string> = {
  // A page of another origin may read the library too: a page of the dev server, a test.
  _headers: [
    '/*',
    '  Access-Control-Allow-Origin: *',
    '  X-Content-Type-Options: nosniff',
    '/manifest.json',
    '  Cache-Control: no-cache',
    '',
  ].join('\n'),
  // Without a 404 page, Pages answers every address it does not have with its first page, and
  // a missing file would read as found.
  '404.html':
    '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Slidr media library: no such file.</p>\n',
};

/**
 * Writes the site of the library from an author's copy (`source`) into `target`, which is
 * emptied first: the published folders, the template files made from the catalog, the manifest
 * of them all, and the files of the site. Returns the manifest.
 */
export function stageLibrary(
  source: string,
  target: string,
  published = new Date().toISOString(),
): Manifest {
  const files = new Map<string, Buffer>();
  for (const folder of PUBLISHED_FOLDERS) filesUnder(join(source, folder), folder, files);
  const catalog = files.get('templates/catalog.json');
  if (catalog) {
    for (const [path, text] of templateFiles(
      JSON.parse(catalog.toString('utf8')) as TemplateCatalog,
    )) {
      files.set(`templates/${path}`, Buffer.from(text));
    }
  }
  for (const path of files.keys()) {
    if (libraryPath(path) !== path) throw new Error(`Not a plain path for the library: ${path}`);
  }
  const physical = catalogChunks(files, MAX_FILE_BYTES);
  const manifest = manifestOf(files, published);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const [path, bytes] of physical) {
    const file = join(target, ...path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, text] of Object.entries(SITE_FILES)) writeFileSync(join(target, name), text);
  return manifest;
}

/** What a publication changes, against the manifest published before it. */
export function changes(before: Manifest | undefined, after: Manifest) {
  const old = before?.files ?? {};
  const paths = Object.keys(after.files);
  return {
    added: paths.filter((path) => !old[path]),
    changed: paths.filter((path) => old[path] && old[path].sha256 !== after.files[path]!.sha256),
    removed: Object.keys(old).filter((path) => !after.files[path]),
  };
}

/** The address of a file of the published library. */
export const publishedUrl = (path: string, upstream = MEDIA_LIBRARY_URL) =>
  withSlash(upstream) + encoded(path);
