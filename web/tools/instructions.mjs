// Writes, as one JSON object, the instructions the app gives its design agent
// (`packages/prompts`), and the names it gives its built-in templates
// (`desktop/src/templates/messages.ts`), so the studio builds its prompts from the app's own text
// and never from a copy of it. The studio carries the file in its binary
// (`src-tauri/src/instructions.rs`):
//
//   node web/tools/instructions.mjs            → { "design": "## Design guidelines …",
//                                                  "html": "## Writing a slide as HTML …",
//                                                  "templates": { "he": { "name": {…},
//                                                  "tagline": {…} }, "en": {…} }, "sources": [...] }
//   node web/tools/instructions.mjs --write    the same, into src-tauri/instructions.json
//   node web/tools/instructions.mjs --check    fails when that file is not what the app says now
//
// `pnpm vendor` writes it with the app's code it copies; `pnpm check` checks it.
//
// The modules are TypeScript that import the app's packages by name, so Vite loads them, as
// `desktop/scripts/export-designs.mjs` loads the design packs.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The app's code, copied at its paths in the app's repository (vendor/README.md).
const repo = join(studio, 'vendor');
const prompts = join(repo, 'packages', 'prompts');
const target = join(studio, 'src-tauri', 'instructions.json');

const server = await createServer({
  configFile: false,
  root: prompts,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  ssr: { noExternal: [/^@slidr\//] },
});

let text;
try {
  const { DESIGN } = await server.ssrLoadModule(join(prompts, 'src', 'design.ts'));
  const { HTML_CONVENTIONS } = await server.ssrLoadModule(join(prompts, 'src', 'html.ts'));
  const words = await server.ssrLoadModule(
    join(repo, 'desktop', 'src', 'templates', 'messages.ts'),
  );
  const named = (table) => ({ name: table.name, tagline: table.tagline });
  text = `${JSON.stringify(
    {
      design: DESIGN,
      html: HTML_CONVENTIONS,
      templates: { he: named(words.he), en: named(words.en) },
      sources: [
        'packages/prompts/src/design.ts',
        'packages/prompts/src/html.ts',
        'desktop/src/templates/messages.ts',
      ],
    },
    null,
    2,
  )}\n`;
} finally {
  await server.close();
}

if (process.argv.includes('--write')) {
  writeFileSync(target, text);
  console.log(`Wrote ${target}`);
} else if (process.argv.includes('--check')) {
  let written = '';
  try {
    written = readFileSync(target, 'utf8');
  } catch {
    // Missing: not what the app says.
  }
  if (written.replace(/\r\n/g, '\n') !== text) {
    console.error(
      "src-tauri/instructions.json is not what the app's code in vendor/ says: run `pnpm instructions`.",
    );
    process.exit(1);
  }
} else {
  process.stdout.write(text);
}
