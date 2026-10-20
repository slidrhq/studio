import { createHash } from 'node:crypto';

/** Physical Pages assets for a logical JSON file above its 25 MiB asset limit. */
export function catalogChunks(files: ReadonlyMap<string, Buffer>, limit: number) {
  const physical = new Map(files);
  const catalogs: Record<string, { parts: string[]; size: number; etag: string }> = {};
  for (const [path, bytes] of files) {
    if (bytes.length <= limit) continue;
    if (!path.endsWith('.json')) {
      throw new Error(`${path} is ${bytes.length} bytes; Cloudflare Pages takes up to ${limit}.`);
    }
    // Reject a damaged catalog before replacing its physical representation.
    JSON.parse(bytes.toString('utf8'));
    const hash = createHash('sha256').update(bytes).digest('hex');
    const parts: string[] = [];
    const size = Math.min(limit, 10 * 1024 * 1024);
    physical.delete(path);
    for (let at = 0; at < bytes.length; at += size) {
      const part = `_catalog-parts/${hash}/${parts.length}.bin`;
      if (physical.has(part)) throw new Error(`Catalog part conflicts with media: ${part}`);
      physical.set(part, bytes.subarray(at, Math.min(at + size, bytes.length)));
      parts.push(`/${part}`);
    }
    catalogs[`/${path}`] = { parts, size: bytes.length, etag: `"${hash}"` };
  }
  if (Object.keys(catalogs).length) {
    physical.set(
      '_worker.js',
      Buffer.from(`const catalogs = ${JSON.stringify(catalogs)};\n${WORKER}`),
    );
    physical.set(
      '_routes.json',
      Buffer.from(JSON.stringify({ version: 1, include: Object.keys(catalogs), exclude: [] })),
    );
  }
  return physical;
}

// Self-contained JavaScript for Pages Advanced Mode. Only the catalog routes invoke it;
// all other library requests remain static. The manifest describes the original bytes,
// so released clients and their hash-verified offline caches need no format change.
const WORKER = String.raw`
export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const entry = catalogs[url.pathname];
    if (!entry) return env.ASSETS.fetch(request);
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
      'Access-Control-Expose-Headers': 'ETag',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'ETag': entry.etag,
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD, OPTIONS' } });
    }
    const cached = request.headers.get('If-None-Match')?.split(',')
      .map(value => value.trim().replace(/^W\//, '')) ?? [];
    if (cached.includes('*') || cached.includes(entry.etag)) {
      return new Response(null, { status: 304, headers });
    }
    headers['Content-Length'] = String(entry.size);
    if (request.method === 'HEAD') return new Response(null, { headers });
    let responses;
    try {
      responses = await Promise.all(entry.parts.map(part =>
        env.ASSETS.fetch(new Request(new URL(part, url), { method: 'GET' }))));
      if (responses.some(response => !response.ok || !response.body)) throw new Error('Missing catalog part');
    } catch {
      delete headers['Content-Length'];
      headers['Cache-Control'] = 'no-store';
      return new Response('Catalog unavailable', { status: 502, headers });
    }
    // Native piping avoids invoking JavaScript for every network chunk of a large catalog. In
    // the Workers runtime a plain TransformStream is the standard one, which does run JavaScript
    // for every chunk: on a catalog of 35 MB the Function ran out of its CPU time a megabyte or
    // two in, and the body ended there, under a Content-Length of the whole. FixedLengthStream is
    // the runtime's own byte stream, and holds the body to its length. (Node, where the Worker is
    // tested, has no such stream.)
    // Keep the asynchronous copy alive after fetch returns the streaming response.
    const body = typeof FixedLengthStream === 'function'
      ? new FixedLengthStream(entry.size)
      : new TransformStream();
    const copying = (async () => {
      let next = 0;
      try {
        for (; next < responses.length; next++) {
          await responses[next].body.pipeTo(body.writable, { preventClose: true });
        }
        await body.writable.close();
      } catch (error) {
        await body.writable.abort(error).catch(() => {});
        await Promise.all(responses.slice(next + 1).map(response => response.body.cancel(error)));
      }
    })();
    context?.waitUntil(copying);
    return new Response(body.readable, { headers });
  },
};
`;
