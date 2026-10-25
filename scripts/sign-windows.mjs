// Signs a Windows binary with Authenticode, so Windows knows who made it, as the app's own
// `desktop/scripts/sign-windows.mjs` does. Tauri runs this for every binary it signs in
// `tauri build` (`bundle.windows.signCommand` in src-tauri/tauri.conf.json): the studio's exe, the
// uninstaller, and the installer itself.
//
// The certificate is the project's, in Certum's cloud (SimplySign). SimplySign Desktop, once
// logged in with a code from the SimplySign app on the phone, puts it in the user's certificate
// store, and signtool signs with it there by its thumbprint. The thumbprint is no secret (anyone
// can read it off a signed file), so the project's certificate is the default:
//
//   pnpm tauri build
//
// On a machine without that certificate (another developer's, a runner of GitHub's) the binary is
// left unsigned, so a build still works. SLIDR_SIGN_CERT names a certificate by its thumbprint,
// which must then sign (the Release workflow names the project's), or `off` to sign nothing.
// SLIDR_SIGNTOOL names signtool.exe when it is not in the newest Windows Kit;
// SLIDR_SIGN_TIMESTAMP another timestamp server.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Certum's "Open Source Developer Moshe Waisman", valid until 2027-10-19.
const PROJECT_CERT = '5C64DAC774694B59FE6427A4744A3434DDCC49F1';

const file = process.argv[2];
if (!file) {
  console.error('usage: node sign-windows.mjs <file>');
  process.exit(2);
}

const chosen = process.env.SLIDR_SIGN_CERT?.replace(/\s/g, '');
if (chosen?.toLowerCase() === 'off') {
  console.warn(`sign-windows: SLIDR_SIGN_CERT is off, ${file} is left unsigned`);
  process.exit(0);
}
const cert = chosen || PROJECT_CERT;
if (!chosen && !inStore(cert)) {
  console.warn(
    `sign-windows: the project's certificate is not on this machine, ${file} is left unsigned`,
  );
  process.exit(0);
}

const signtool = process.env.SLIDR_SIGNTOOL || findSigntool();
const timestamp = process.env.SLIDR_SIGN_TIMESTAMP || 'http://time.certum.pl';

// The timestamp keeps the signature valid after the certificate expires. Certum's server is
// sometimes slow to answer, so a failed signing is tried again before the build fails.
const args = [
  'sign',
  '/sha1',
  cert,
  '/fd',
  'sha256',
  '/tr',
  timestamp,
  '/td',
  'sha256',
  '/d',
  'Slidr Studio',
  file,
];
for (let attempt = 1; ; attempt++) {
  try {
    execFileSync(signtool, args, { stdio: 'inherit' });
    break;
  } catch {
    if (attempt === 3) {
      console.error(`sign-windows: signing ${file} failed. Is SimplySign Desktop logged in?`);
      process.exit(1);
    }
    console.warn(`sign-windows: attempt ${attempt} failed, trying again`);
  }
}
execFileSync(signtool, ['verify', '/pa', file], { stdio: 'inherit' });

function inStore(thumbprint) {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Test-Path Cert:\\CurrentUser\\My\\${thumbprint}`],
    { encoding: 'utf8' },
  );
  return out.trim() === 'True';
}

function findSigntool() {
  const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  const versions = existsSync(kits)
    ? readdirSync(kits)
        .filter((name) => /^10\./.test(name))
        .sort(byVersion)
        .reverse()
    : [];
  for (const version of versions) {
    const path = join(kits, version, 'x64', 'signtool.exe');
    if (existsSync(path)) return path;
  }
  return 'signtool.exe';
}

function byVersion(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}
