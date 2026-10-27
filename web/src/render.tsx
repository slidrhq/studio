/**
 * The page the studio opens in a hidden window to render a variant (src-tauri/src/render). For a
 * design, it converts the variant's HTML files, one for each language of its request, with the
 * app's engine, checks them, and shows each language at full size and as the gallery's thumbnail
 * (`<lang>-full`, `<lang>-thumb`), and at the size the galleries show it, the picture of it made
 * ahead that is published with it (`<lang>-gallery`). For a template's sample in a language, it builds every slide on
 * the template with the app's engine, checks them, and shows each at full size and as a thumbnail
 * (`s01-full`, `s01-thumb`…), and all of them on one sheet (`sheet`). When everything is drawn it
 * tells Rust the views it drew (`[data-snap]`), and Rust takes a picture of each. And it draws slides
 * of published designs as the galleries show them, for the pictures of them the library lacks
 * (`gallery.tsx`).
 *
 * The engine compares its result with the HTML it converts, by pictures of the page: Rust takes
 * them (`capture_clip`), as the app's capture window does, so a part that would not look the same
 * stays `html` here exactly as in the app.
 */
import { languageDir, languagesOf } from '@slidr/model';
import { ScaledSlide, settle, type AssetResolver } from '@slidr/renderer';
import { invoke } from '@tauri-apps/api/core';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { fileUrl } from './api';
import {
  convertDesign,
  designDeck,
  pictureResolver,
  type DesignResult,
  type Lang,
  type Picture,
} from './design';
import { registerLibraryFonts } from './fonts';
import { GALLERY_WIDTH, runGallery, type GalleryItem, type GalleryResult } from './gallery';
import { convertTemplate, type Built, type TemplateInput, type TemplateResult } from './template';

const THUMB_WIDTH = 384;
const SHEET_COLUMNS = 4;

/** What the page said went wrong, beside the error that stopped it. */
const said: string[] = [];
window.addEventListener('error', (event) => said.push(`page error: ${event.message}`));
window.addEventListener('unhandledrejection', (event) =>
  said.push(`page error: ${String(event.reason)}`),
);
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  said.push(`console: ${args.map(String).join(' ')}`);
  consoleError(...args);
};

window.__slidrCapture = (rect) =>
  invoke<ArrayBuffer>('capture_clip', { rect, dpr: window.devicePixelRatio });

/** The name of a slide's pictures: `s01`, `s02`… */
const slideName = (index: number) => `s${String(index + 1).padStart(2, '0')}`;

/**
 * A template's sample in one language: every slide as a thumbnail on one sheet, which reads in
 * the language's direction, and every slide at full size. A slide that could not be built keeps
 * its place on the sheet, struck through.
 */
function TemplateViews({
  built,
  resolve,
  lang,
}: {
  built: (Built | undefined)[];
  resolve: AssetResolver;
  lang: Lang;
}) {
  const height = (THUMB_WIDTH * 9) / 16;
  return (
    <>
      <div
        data-snap="sheet"
        dir={languageDir(lang)}
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(SHEET_COLUMNS, Math.max(1, built.length))}, ${THUMB_WIDTH}px)`,
          gap: 8,
          padding: 8,
          background: '#0e1014',
          width: 'max-content',
        }}
      >
        {built.map((one, index) =>
          one ? (
            <div key={index} data-snap={`${slideName(index)}-thumb`} style={{ width: THUMB_WIDTH }}>
              <ScaledSlide
                deck={one.deck}
                slide={one.slide}
                width={THUMB_WIDTH}
                mode="thumbnail"
                resolveAsset={resolve}
              />
            </div>
          ) : (
            <div
              key={index}
              style={{
                width: THUMB_WIDTH,
                height,
                background: 'repeating-linear-gradient(135deg, #3a1214 0 12px, #2a0d0f 12px 24px)',
              }}
            />
          ),
        )}
      </div>
      {built.map((one, index) =>
        one ? (
          <div key={index} data-snap={`${slideName(index)}-full`} style={{ width: 1920 }}>
            <ScaledSlide
              deck={one.deck}
              slide={one.slide}
              width={1920}
              mode="thumbnail"
              resolveAsset={resolve}
            />
          </div>
        ) : null,
      )}
    </>
  );
}

async function runTemplate(input: TemplateInput): Promise<TemplateResult> {
  const { result, built, resolve } = await convertTemplate(input);
  const root = createRoot(document.getElementById('root')!);
  flushSync(() => root.render(<TemplateViews built={built} resolve={resolve} lang={input.lang} />));
  await settle(document);
  return result;
}

function Views({ result, picture }: { result: DesignResult; picture: Picture }) {
  const resolve = pictureResolver(picture);
  return (
    <>
      {languagesOf(result.langs).map((lang) => {
        const slide = result.langs[lang]?.slide;
        if (!slide) return null;
        const deck = designDeck(lang, picture, [slide]);
        return (
          <div key={lang}>
            <div data-snap={`${lang}-full`} style={{ width: 1920 }}>
              <ScaledSlide
                deck={deck}
                slide={slide}
                width={1920}
                mode="thumbnail"
                resolveAsset={resolve}
              />
            </div>
            <div data-snap={`${lang}-thumb`} style={{ width: THUMB_WIDTH }}>
              <ScaledSlide
                deck={deck}
                slide={slide}
                width={THUMB_WIDTH}
                mode="thumbnail"
                resolveAsset={resolve}
              />
            </div>
            <div data-snap={`${lang}-gallery`} style={{ width: GALLERY_WIDTH }}>
              <ScaledSlide
                deck={deck}
                slide={slide}
                width={GALLERY_WIDTH}
                mode="thumbnail"
                resolveAsset={resolve}
              />
            </div>
          </div>
        );
      })}
    </>
  );
}

/** Every view the page drew, where it is on the page, in CSS px. */
function views() {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-snap]'), (view) => {
    const box = view.getBoundingClientRect();
    return {
      name: view.dataset.snap!,
      x: Math.round(box.left + window.scrollX),
      y: Math.round(box.top + window.scrollY),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  });
}

async function run(): Promise<DesignResult | TemplateResult | GalleryResult> {
  // Rust first sets the page to 1920×1080, one device pixel each, then hands over the variant.
  const read = await invoke<{ kind?: string; id: string }>('render_input');
  await registerLibraryFonts();
  if (read.kind === 'template') return runTemplate(read as unknown as TemplateInput);
  if (read.kind === 'gallery') {
    return runGallery((read as unknown as { items: GalleryItem[] }).items);
  }
  const input = read as unknown as {
    id: string;
    designId: string;
    revision: number;
    languages?: Lang[];
    html: Partial<Record<Lang, string>>;
    image: { file: string; revision: number; width: number; height: number };
  };
  const picture: Picture = {
    url: fileUrl(input.id, input.image.file, input.image.revision),
    width: input.image.width,
    height: input.image.height,
  };
  const result = await convertDesign({
    ...input,
    image: picture,
    debug: new URLSearchParams(location.search).has('debug'),
  });
  const root = createRoot(document.getElementById('root')!);
  flushSync(() => root.render(<Views result={result} picture={picture} />));
  await settle(document);
  return result;
}

run().then(
  (result) => invoke('render_done', { done: { result, views: views() } }),
  (error: unknown) => {
    const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return invoke('render_done', { done: { error: [stack, ...said].join('\n') } });
  },
);
