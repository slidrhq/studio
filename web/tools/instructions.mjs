// Prints, as one JSON object, the instructions the app gives its design agent
// (`packages/prompts`), and the names it gives its built-in templates
// (`apps/desktop/src/templates/messages.ts`), so the studio's server builds its prompts from the
// app's own text and never from a copy of it:
//
//   node web/tools/instructions.mjs
//   → { "design": "## Design guidelines …", "html": "## Writing a slide as HTML …",
//       "templates": { "he": { "name": {…}, "tagline": {…} }, "en": {…} }, "sources": [...] }
//
// The modules are TypeScript that import the app's packages by name, so Vite loads them, as
// `apps/desktop/scripts/export-designs.mjs` loads the design packs.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// The app's code, copied at its paths in the app's repository (vendor/README.md).
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor');
const prompts = join(repo, 'packages', 'prompts');

const server = await createServer({
  configFile: false,
  root: prompts,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  ssr: { noExternal: [/^@slidr\//] },
});

try {
  const { DESIGN } = await server.ssrLoadModule(join(prompts, 'src', 'design.ts'));
  const { HTML_CONVENTIONS } = await server.ssrLoadModule(join(prompts, 'src', 'html.ts'));
  const words = await server.ssrLoadModule(
    join(repo, 'apps', 'desktop', 'src', 'templates', 'messages.ts'),
  );
  const named = (table) => ({ name: table.name, tagline: table.tagline });
  process.stdout.write(
    JSON.stringify({
      design: DESIGN,
      html: HTML_CONVENTIONS,
      templates: { he: named(words.he), en: named(words.en) },
      sources: [
        'packages/prompts/src/design.ts',
        'packages/prompts/src/html.ts',
        'apps/desktop/src/templates/messages.ts',
      ],
    }),
  );
} finally {
  await server.close();
}
