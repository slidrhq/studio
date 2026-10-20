/**
 * The fonts of decks, from the media library (`fonts/catalog.json`), registered with the page as
 * the app registers them (`apps/desktop/src/fonts/index.ts`): `@font-face` rules in a stylesheet,
 * with the Hebrew subsets again as Hebrew-only faces, which the renderer puts first in a font
 * pair. Rules, not `FontFace` objects: the conversion engine renders the source HTML in a sandbox
 * frame and hands it the page's `@font-face` rules. A face is fetched only when text uses it, or
 * when a conversion asks for a family ahead of measuring, so nothing unused is downloaded.
 */
import { familyForLetters, type FontFamilyEntry } from '@slidr/model';
import { hebrewFace, hebrewFaces, setFontCounterparts } from '@slidr/renderer';

export const MEDIA_URL = 'https://slidr-media.pages.dev/';

interface Face {
  family: string;
  style: string;
  weight: string;
  url: string;
  unicodeRange?: string;
}

interface Catalog {
  families: FontFamilyEntry[];
  faces: (Omit<Face, 'url'> & { path: string })[];
}

const STYLE_ID = 'slidr-library-fonts';
const families = new Set<string>();
let registered: Promise<string[]> | undefined;

const faceRule = (face: Face) =>
  `@font-face { font-family: ${JSON.stringify(face.family)}; font-style: ${face.style}; ` +
  `font-weight: ${face.weight}; font-display: block; src: url(${JSON.stringify(face.url)}) format("woff2");` +
  (face.unicodeRange ? ` unicode-range: ${face.unicodeRange};` : '') +
  ' }';

/** Registers every face of the library; resolves to the family names. */
export function registerLibraryFonts(): Promise<string[]> {
  registered ??= (async () => {
    const response = await fetch(`${MEDIA_URL}fonts/catalog.json`);
    if (!response.ok) throw new Error(`The library's font catalog: ${response.status}`);
    const catalog = (await response.json()) as Catalog;
    const faces: Face[] = catalog.faces.map(({ path, ...face }) => ({
      ...face,
      url: `${MEDIA_URL}${path}`,
    }));
    for (const face of faces) families.add(face.family);
    // A deck in a language its theme's fonts have no letters of draws them in their counterpart.
    const byName = new Map(catalog.families.map((entry) => [entry.family.toLowerCase(), entry]));
    setFontCounterparts((family, lang) => {
      const entry = byName.get(family.toLowerCase());
      return entry && familyForLetters(entry, lang);
    });
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [...faces, ...hebrewFaces(faces)].map(faceRule).join('\n');
      document.head.append(style);
    }
    return catalog.families.map((family) => family.family);
  })();
  return registered;
}

/** The library's families an HTML document names in a `font-family`. */
export function familiesIn(html: string): string[] {
  const named = new Set<string>();
  for (const match of html.matchAll(/font-family\s*:\s*([^;"}>]+)/gi)) {
    for (const part of match[1]!.split(',')) {
      const name = part
        .trim()
        .replace(/&quot;/g, '')
        .replace(/^['"]|['"]$/g, '');
      if (families.has(name)) named.add(name);
    }
  }
  return [...named];
}

/** Loads every face of the families, so that text is measured in them and not in a fallback. */
export async function loadFamilies(names: readonly string[]): Promise<void> {
  const wanted = new Set(names.flatMap((name) => [name, hebrewFace(name)]));
  const loads: Promise<unknown>[] = [];
  document.fonts.forEach((face) => {
    if (wanted.has(face.family.replace(/^["']|["']$/g, ''))) {
      loads.push(face.load().catch(() => face));
    }
  });
  await Promise.all(loads);
  await document.fonts.ready;
}
