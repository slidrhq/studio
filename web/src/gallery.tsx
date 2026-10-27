/**
 * The slides of published designs as the galleries show them, drawn for the pictures of them the
 * library lacks (src-tauri/src/gallery.rs). Each is the slide the library publishes in its language
 * (`elements/designs/<lang>/<catalog>`), drawn as the app's gallery draws it (`designPreview` of the
 * app's `elements/designs.ts`): its pictures are the design's own, as the library serves them, of
 * the size the library gives them.
 */
import { mediaFiles, mediaUrl, readMediaJson } from '@slidr/media-library';
import { createDeck, walkElements, type AssetMeta, type Slide } from '@slidr/model';
import { ScaledSlide, settle } from '@slidr/renderer';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { Lang } from './design';

/** The width of a picture of a design made ahead for the galleries (ADR-111 of the app). */
export const GALLERY_WIDTH = 320;

/** A slide to draw: its view's name, its design, language and catalog. */
export interface GalleryItem {
  name: string;
  id: string;
  lang: Lang;
  catalog: string;
}

/** What the page reports: the slides it could not draw, and why. */
export interface GalleryResult {
  failed: { name: string; error: string }[];
}

/** A catalog of designs in one language, as far as a drawing reads it. */
interface Catalog {
  slides?: Record<string, Partial<Record<Lang, Slide>> | undefined>;
  /** A managed design's pictures' sizes, by their names. */
  sizes?: Record<string, [number, number] | undefined>;
}

/** The asset of a design's picture named `name`, as the app's gallery names it. */
const PREVIEW = 'design-preview-';

const pictureOf = (name: string) => `images/designs/${name}.webp`;

/** The record of a design's picture, of its size, as the app's `designAssets.ts` makes it. */
function asset(name: string, size: readonly number[] | undefined): AssetMeta {
  const file = `${name}.webp`;
  return {
    id: PREVIEW + name,
    file,
    mime: 'image/webp',
    kind: 'image',
    origin: 'import',
    bytes: 0,
    name: file,
    ...(size ? { width: size[0], height: size[1] } : {}),
  };
}

/** Raster artwork inside the SVGs of a slide, in the renderer's open shadow roots. */
function embeddedPictures(root: Element | ShadowRoot): string[] {
  const urls = Array.from(root.querySelectorAll('image')).flatMap((picture) => {
    const url = picture.getAttribute('href') ?? picture.getAttribute('xlink:href');
    return url ? [url] : [];
  });
  for (const element of Array.from(root.querySelectorAll('*'))) {
    if (element.shadowRoot) urls.push(...embeddedPictures(element.shadowRoot));
  }
  return urls;
}

export async function runGallery(items: GalleryItem[]): Promise<GalleryResult> {
  const [files, sizes] = await Promise.all([
    mediaFiles(),
    readMediaJson<Record<string, [number, number] | undefined>>('images/designs/sizes.json'),
  ]);
  const catalogs = new Map<string, Promise<Catalog | undefined>>();
  const catalogOf = (path: string) => {
    let read = catalogs.get(path);
    if (!read) catalogs.set(path, (read = readMediaJson<Catalog>(path)));
    return read;
  };
  const failed: GalleryResult['failed'] = [];
  const drawn: { name: string; slide: Slide; deck: ReturnType<typeof createDeck> }[] = [];
  for (const item of items) {
    const path = `elements/designs/${item.lang}/${item.catalog}`;
    const catalog = await catalogOf(path);
    const published = catalog?.slides?.[item.id]?.[item.lang];
    if (!published) {
      failed.push({ name: item.name, error: `${path} has no slide of ${item.id}.` });
      continue;
    }
    const size = (name: string) => sizes?.[name] ?? catalog?.sizes?.[name];
    const picture = asset(item.id, size(item.id));
    const backdrop = files.has(pictureOf(`${item.id}-bg`))
      ? asset(`${item.id}-bg`, size(`${item.id}-bg`))
      : undefined;
    const slide = structuredClone(published);
    for (const element of walkElements(slide.elements)) {
      if (element.type !== 'image') continue;
      if (element.assetId === '__subject__') element.assetId = picture.id;
      if (element.assetId === '__backdrop__') element.assetId = (backdrop ?? picture).id;
    }
    const deck = createDeck({ lang: item.lang, slides: [slide] });
    deck.assets[picture.id] = picture;
    if (backdrop) deck.assets[backdrop.id] = backdrop;
    drawn.push({ name: item.name, slide, deck });
  }

  const resolve = (one: AssetMeta) =>
    one.id.startsWith(PREVIEW) ? mediaUrl(pictureOf(one.id.slice(PREVIEW.length))) : undefined;
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <>
        {drawn.map(({ name, slide, deck }) => (
          <div key={name} data-snap={name} style={{ width: GALLERY_WIDTH }}>
            <ScaledSlide
              deck={deck}
              slide={slide}
              width={GALLERY_WIDTH}
              mode="thumbnail"
              resolveAsset={resolve}
            />
          </div>
        ))}
      </>,
    ),
  );
  await settle(document);
  await Promise.all(
    Array.from(new Set(embeddedPictures(host)), (url) => {
      const image = new Image();
      image.src = url;
      return image.decode().catch(() => undefined);
    }),
  );
  await settle(document);
  return { failed };
}
