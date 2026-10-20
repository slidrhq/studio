// Copies into vendor/ the files of the app's repository (github.com/slidrhq/app) that this
// repository uses, as vendor/FILES.txt lists them, at the same paths, and the package files of the
// app's packages among them. Run it to take a newer version of the app's code:
//
//   node scripts/vendor.mjs --from ../app
//
// vendor/FILES.txt lists the files themselves; a file the app's code comes to import is added to
// it by hand (the type check names what is missing). The copy is never edited here.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor');
const at = process.argv.indexOf('--from');
if (at < 0) throw new Error("Name the app's repository: --from <dir>");
const app = resolve(process.argv[at + 1]);

const listed = readFileSync(join(vendor, 'FILES.txt'), 'utf8')
  .split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#'));
const packages = [...new Set(listed.flatMap((path) => path.match(/^packages\/[^/]+/) ?? []))];
const files = [
  ...listed,
  'tsconfig.base.json',
  ...packages.flatMap((dir) => [`${dir}/package.json`, `${dir}/tsconfig.json`]),
];

for (const entry of ['packages', 'desktop', 'tsconfig.base.json', 'AGENTS.md']) {
  rmSync(join(vendor, entry), { recursive: true, force: true });
}
for (const path of files) {
  mkdirSync(dirname(join(vendor, path)), { recursive: true });
  copyFileSync(join(app, path), join(vendor, path));
}

// The packages' scripts build or check them inside the app's workspace: none of them runs here.
for (const dir of packages) {
  const file = join(vendor, dir, 'package.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  delete json.scripts;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: app, encoding: 'utf8' }).trim();
writeFileSync(join(vendor, 'COMMIT'), `${commit}\n`);
console.log(`Copied ${files.length} files of the app at ${commit.slice(0, 7)}.`);
