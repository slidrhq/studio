// Publishes the media library (docs/media-library.md) from an author's copy to its site on
// Cloudflare Pages, which the app reads from while it runs:
//
//   pnpm media:publish                      the copy beside the repository, ../Slidr-media
//   pnpm media:publish --from <dir>         another copy
//   pnpm media:publish --dry-run            stage it and say what would change, and no more
//   pnpm media:publish --branch preview     a preview deployment, not the published library
//   pnpm media:publish --report <file>      also write what it found to <file>, as JSON
//
// The report is written once the changes are known, before anything below can stop the
// publication: the files and bytes staged, the paths added, changed and removed against the
// published library, and `blocked`, the reason it stops without --force (else null).
//
// Cloudflare is reached with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the
// environment; wrangler is run through npx at a fixed version. A publication that would leave the
// library empty, or take away most of it, stops unless --force is given: a copy that is not all
// there (another machine, a folder not yet pulled) would otherwise empty the app's library.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changes, publishedUrl, stageLibrary } from '../build/media.ts';

const PROJECT = 'slidr-media';
const WRANGLER = 'wrangler@4.151.0';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const flag = (name) => args.includes(name);

const source = resolve(
  option('--from') ?? fileURLToPath(new URL('../../../Slidr-media/', import.meta.url)),
);
const target = resolve(option('--out') ?? join(tmpdir(), 'slidr-media-site'));
const branch = option('--branch') ?? 'main';

if (!existsSync(source)) {
  console.error(`There is no media library at ${source}. Name one with --from <dir>.`);
  process.exit(1);
}

const manifest = stageLibrary(source, target);
const paths = Object.keys(manifest.files);
const bytes = Object.values(manifest.files).reduce((sum, file) => sum + file.size, 0);
console.log(`Staged ${paths.length} files (${(bytes / 1024 / 1024).toFixed(1)} MB) in ${target}`);

const before = await fetch(publishedUrl('manifest.json'))
  .then((response) => (response.ok ? response.json() : undefined))
  .catch(() => undefined);
const { added, changed, removed } = changes(before, manifest);
console.log(
  `Against the published library: ${added.length} added, ${changed.length} changed, ${removed.length} removed.`,
);
for (const [sign, list] of [
  ['+', added],
  ['~', changed],
  ['-', removed],
]) {
  for (const path of list.slice(0, 20)) console.log(`  ${sign} ${path}`);
  if (list.length > 20) console.log(`  … and ${list.length - 20} more`);
}

const published = Object.keys(before?.files ?? {}).length;
const blocked =
  flag('--force') || (paths.length > 0 && removed.length <= published / 2)
    ? null
    : paths.length === 0
      ? `${source} holds no files of the library. Nothing is published; --force publishes an empty library.`
      : `This would take away ${removed.length} of the ${published} published files. Nothing is published; --force publishes it as it is.`;

const report = option('--report');
if (report) {
  const file = resolve(report);
  const found = {
    source,
    target,
    files: paths.length,
    bytes,
    published: manifest.published,
    before: published,
    added,
    changed,
    removed,
    blocked,
    dryRun: flag('--dry-run'),
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(found, null, 2)}\n`);
  console.log(`Report written to ${file}`);
}

// From here on the script sets its exit code and ends rather than calling process.exit(): after
// the fetch above, process.exit() aborts Node 24 on Windows while the connection is closing
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", exit code 0xC0000409).
process.exitCode = publish();

function publish() {
  if (blocked) {
    console.error(blocked);
    return 1;
  }

  if (flag('--dry-run')) {
    console.log('Dry run: nothing is published.');
    return 0;
  }

  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    if (!process.env[name]) {
      console.error(`${name} is not set: Cloudflare cannot be reached.`);
      return 1;
    }
  }

  // npx is a script on Windows, which only a shell runs; the shell takes the words apart again.
  const windows = process.platform === 'win32';
  const quoted = (arg) =>
    windows && /[\s"&|<>^]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg;
  const deploy = spawnSync(
    'npx',
    [
      '--yes',
      WRANGLER,
      'pages',
      'deploy',
      target,
      '--project-name',
      PROJECT,
      '--branch',
      branch,
      '--commit-dirty=true',
      '--commit-message',
      `Media library ${manifest.published}`,
    ].map(quoted),
    { stdio: 'inherit', shell: windows },
  );
  return deploy.status ?? 1;
}
