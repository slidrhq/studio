/**
 * The page the server opens in a headless browser (`tools/snap.mjs`). For a design, it converts
 * the variant's HTML files, one for each language of its request, with the app's engine, checks
 * them, and shows each language at full size and as the gallery's thumbnail (`<lang>-full`,
 * `<lang>-thumb`). For a template's sample in a language, it builds every slide on the template
 * with the app's engine, checks them, and shows each at full size and as a thumbnail
 * (`s01-full`, `s01-thumb`…), and all of them on one sheet (`sheet`). The script takes pictures
 * of each; when everything is drawn the page sets `window.__snap`.
 */
import { languageDir, languagesOf } from '@slidr/model';
import { ScaledSlide, settle, type AssetResolver } from '@slidr/renderer';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  convertDesign,
  designDeck,
  pictureResolver,
  type DesignResult,
  type Lang,
  type Picture,
} from './design';
import { registerLibraryFonts } from './fonts';
import { convertTemplate, type Built, type TemplateInput, type TemplateResult } from './template';

declare global {
  interface Window {
    __snap?: { done: boolean; result?: DesignResult | TemplateResult; error?: string };
  }
}

const THUMB_WIDTH = 384;
const SHEET_COLUMNS = 4;

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
          </div>
        );
      })}
    </>
  );
}

async function run(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const vid = params.get('v');
  if (!vid) throw new Error('No variant named (?v=).');
  const response = await fetch(`/api/variants/${encodeURIComponent(vid)}/render-input`);
  if (!response.ok) throw new Error(`render-input: ${response.status} ${await response.text()}`);
  const read = (await response.json()) as { kind?: string };
  if (read.kind === 'template') {
    await registerLibraryFonts();
    const result = await runTemplate(read as TemplateInput);
    window.__snap = { done: true, result };
    return;
  }
  const input = read as {
    designId: string;
    revision: number;
    /** The variant's languages; a server from before there was a choice sends none. */
    languages?: Lang[];
    html: Partial<Record<Lang, string>>;
    image: Picture;
  };
  await registerLibraryFonts();
  const picture = { ...input.image, url: new URL(input.image.url, location.href).href };
  const result = await convertDesign({
    ...input,
    image: picture,
    debug: params.has('debug'),
  });
  const root = createRoot(document.getElementById('root')!);
  flushSync(() => root.render(<Views result={result} picture={picture} />));
  await settle(document);
  window.__snap = { done: true, result };
}

run().catch((error: unknown) => {
  window.__snap = {
    done: true,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  };
});
