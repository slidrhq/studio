import type { Deck, Element, Slide } from '@slidr/model';
import { memo, useMemo, type CSSProperties } from 'react';
import {
  RenderContextValue,
  type AssetResolver,
  type CellSlot,
  type ElementSlot,
  type HtmlSlot,
  type RenderContext,
  type RenderMode,
  type TextSlot,
} from './context';
import { cssString, scopeSlideCss } from './css';
import { ElementView } from './elements';
import { BackgroundLayers } from './fill';
import { frameScriptNonce, resolveAssetUrls } from './markup';
import { opensAddress } from './text';
import { colorCss, deckFontFaces, themeVariables } from './theme';

export interface SlideRendererProps {
  /** The deck the slide belongs to: its theme, layouts, assets and direction. */
  deck: Deck;
  slide: Slide;
  /** Default `edit`. See `RenderMode`. */
  mode?: RenderMode;
  /**
   * Turns an asset into a loadable URL. Keep it stable (module-level or memoised): a new function
   * re-renders every element. Without it, assets do not load.
   */
  resolveAsset?: AssetResolver;
  /** Wraps or replaces an element's DOM. Keep it stable, as `resolveAsset`. */
  slot?: ElementSlot;
  /** Puts the host's content (the text editor) in a text box. Keep it stable. */
  textSlot?: TextSlot;
  /** Puts the host's content (the text editor) in a table cell. Keep it stable. */
  cellSlot?: CellSlot;
  /** Hands the content of an `html` element to the host, to edit its text. Keep it stable. */
  htmlSlot?: HtmlSlot;
  /**
   * The nonce the scripts of `html` elements carry in their frames. The page's own by default
   * (`setFrameScriptNonce`); an empty string draws them without one, as an export does: a file
   * has no policy to satisfy, and a nonce of this load has no business in it.
   */
  scriptNonce?: string;
  /**
   * Narrows the links the slide draws to the addresses its host follows: a host that hands only
   * some of them on (the app gives the system web addresses only) says so here, and a link to
   * any other address is drawn as what it is over, not as a link that does nothing. It cannot
   * widen them: an address no slide may open stays unopened. Keep it stable.
   */
  opensLink?: (address: string) => boolean;
  /**
   * How the slide's pictures are decoded. `async`, the default, lets the page show a frame before
   * a large picture is ready, and the picture follows; `sync` holds the frame until the pictures
   * are drawn with the rest, for a slide that is shown whole the moment it appears, such as a
   * template's cover in a panel that was drawn ahead.
   */
  decoding?: 'sync' | 'async';
  className?: string;
  /** Applied to the slide root, after the renderer's own styles. */
  style?: CSSProperties;
}

/**
 * Where a deck's lines may break, by its language. Japanese breaks between its phrases
 * (`auto-phrase`) and Korean between its words, at the spaces it writes (`keep-all`): a browser
 * otherwise breaks them between any two characters, and split a name or a word in the samples. A
 * word longer than its line still breaks rather than run out of its box.
 */
function wordBreak(lang: string): CSSProperties {
  const code = lang.toLowerCase();
  if (code.startsWith('ja')) return { wordBreak: 'auto-phrase', overflowWrap: 'break-word' };
  if (code.startsWith('ko')) return { wordBreak: 'keep-all', overflowWrap: 'break-word' };
  return {};
}

/**
 * A slide as DOM at its logical size, 1920x1080 (SPEC 7). It does not scale itself: the Stage,
 * the thumbnails and the presenter put it in a scaled container (see `ScaledSlide`).
 *
 * The output is self-contained: every style it relies on is inline, so it looks the same in the
 * editor (which has a page stylesheet), in the capture window and in an exported file (RND-01).
 * The root carries the theme as CSS variables (RND-08) and the slide's own `css`, scoped to it
 * (RND-07).
 */
export const SlideRenderer = memo(SlideRendererView, sameRender);

/** The number of the slide in its deck, from 1; undefined for a slide the deck does not hold. */
function numberOf(deck: Deck, slide: Slide): number | undefined {
  const at = deck.slides.findIndex((s) => s.id === slide.id);
  return at === -1 ? undefined : at + 1;
}

function sameStyle(a: CSSProperties | undefined, b: CSSProperties | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as (keyof CSSProperties)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * Whether two sets of props draw the same slide. The model keeps the identity of what a change
 * did not touch (ADR-007), so a slide is drawn again only when it, or what the deck lends it
 * (the theme, the layouts, the assets, its number), has changed: the other slides of the deck
 * change under a thumbnail with every edit, and the Stage's own state changes around its slide
 * with every hover.
 */
function sameRender(a: SlideRendererProps, b: SlideRendererProps): boolean {
  return (
    a.slide === b.slide &&
    a.deck.theme === b.deck.theme &&
    a.deck.assets === b.deck.assets &&
    a.deck.layouts === b.deck.layouts &&
    a.deck.meta === b.deck.meta &&
    a.deck.size === b.deck.size &&
    numberOf(a.deck, a.slide) === numberOf(b.deck, b.slide) &&
    a.mode === b.mode &&
    a.resolveAsset === b.resolveAsset &&
    a.slot === b.slot &&
    a.textSlot === b.textSlot &&
    a.cellSlot === b.cellSlot &&
    a.htmlSlot === b.htmlSlot &&
    a.scriptNonce === b.scriptNonce &&
    a.opensLink === b.opensLink &&
    a.decoding === b.decoding &&
    a.className === b.className &&
    sameStyle(a.style, b.style)
  );
}

function SlideRendererView({
  deck,
  slide,
  mode = 'edit',
  resolveAsset,
  slot,
  textSlot,
  cellSlot,
  htmlSlot,
  scriptNonce: givenNonce,
  opensLink: hostOpens,
  decoding,
  className,
  style,
}: SlideRendererProps) {
  const { theme, assets, layouts, meta, size } = deck;
  const slideNumber = numberOf(deck, slide);
  const scriptNonce = (givenNonce ?? frameScriptNonce()) || undefined;
  const ctx = useMemo<RenderContext>(
    () => ({
      theme,
      mode,
      dir: meta.dir,
      lang: meta.lang,
      asset: (id) => assets[id],
      assetUrl: (id) => {
        const asset = assets[id];
        return asset && resolveAsset ? resolveAsset(asset) : undefined;
      },
      slideNumber,
      slot,
      textSlot,
      cellSlot,
      htmlSlot,
      ...(scriptNonce ? { scriptNonce } : {}),
      opensLink: (address) => opensAddress(address) && (hostOpens?.(address) ?? true),
      ...(decoding ? { decoding } : {}),
    }),
    [
      theme,
      mode,
      meta.dir,
      meta.lang,
      assets,
      resolveAsset,
      slideNumber,
      slot,
      textSlot,
      cellSlot,
      htmlSlot,
      scriptNonce,
      hostOpens,
      decoding,
    ],
  );
  const vars = useMemo(() => themeVariables(theme, meta.lang), [theme, meta.lang]);
  const fontFaces = useMemo(
    () => (resolveAsset ? deckFontFaces(assets, resolveAsset) : ''),
    [assets, resolveAsset],
  );
  const layout = slide.layoutId ? layouts.find((l) => l.id === slide.layoutId) : undefined;
  // A footer the layout draws is the deck's footer, the same on every slide (SLD-04). A slide
  // whose own footer says something shows that instead: the two share one place. Its own
  // footer is one wherever it is: in a group, or as the text of a shape.
  const says = (e: Element): boolean => {
    if (e.hidden) return false;
    if (e.type === 'group') return e.children.some(says);
    const words = e.type === 'text' || e.type === 'shape' ? e.content : undefined;
    return (
      e.role === 'footer' &&
      Boolean(words?.paragraphs.some((p) => p.runs.some((run) => run.text.trim() !== '')))
    );
  };
  const ownFooter = slide.elements.some(says);
  const background = slide.background ?? layout?.background ?? theme.background;
  const body = theme.textStyles.body;
  // The slide's own stylesheet can name an asset of the deck too (`url("slidr-asset:<id>")`):
  // a face of a font the deck keeps, which has no record of its own on the asset.
  const scopedCss = useMemo(
    () =>
      slide.css
        ? scopeSlideCss(
            resolveAssetUrls(slide.css, {
              assetUrl: (id) => {
                const asset = assets[id];
                return asset && resolveAsset ? resolveAsset(asset) : undefined;
              },
            }),
            `[data-slide-id=${cssString(slide.id)}]`,
          )
        : undefined,
    [slide.css, slide.id, assets, resolveAsset],
  );

  return (
    <RenderContextValue.Provider value={ctx}>
      <div
        className={className ? `slidr-slide ${className}` : 'slidr-slide'}
        data-slide-id={slide.id}
        lang={meta.lang}
        dir={meta.dir}
        style={{
          ...(vars as CSSProperties),
          position: 'relative',
          width: size.w,
          height: size.h,
          margin: 0,
          padding: 0,
          boxSizing: 'border-box',
          overflow: 'hidden',
          contain: 'layout paint',
          isolation: 'isolate',
          // The base every element inherits; HTML written for the slide sees the body text style.
          fontFamily: 'var(--font-body)',
          fontSize: body.size,
          fontWeight: 400,
          fontStyle: 'normal',
          lineHeight: body.lineHeight,
          letterSpacing: 'normal',
          wordSpacing: 'normal',
          textAlign: 'start',
          textIndent: 0,
          textTransform: 'none',
          whiteSpace: 'normal',
          // Japanese and Chinese lines open with no small kana, prolonged sound mark or closing
          // punctuation (kinsoku): `normal` let small tsu and the prolonged sound mark open a line.
          lineBreak: 'strict',
          ...wordBreak(meta.lang),
          color: colorCss(body.color),
          ...style,
        }}
      >
        {fontFaces ? <style data-slidr-fonts="">{fontFaces}</style> : null}
        {scopedCss ? <style>{scopedCss}</style> : null}
        <BackgroundLayers background={background} ctx={ctx} />
        {layout?.decorations.map((d) =>
          d.role === 'footer' && ownFooter ? null : (
            <ElementView key={d.id} element={d} decoration />
          ),
        )}
        {slide.elements.map((e) => (
          <ElementView key={e.id} element={e} />
        ))}
      </div>
    </RenderContextValue.Provider>
  );
}

/**
 * A slide shown at a given width, e.g. a thumbnail (FLM-01). The slide is laid out at full size
 * and scaled, so it is the same picture at every size.
 */
export function ScaledSlide({ width, ...props }: SlideRendererProps & { width: number }) {
  const { w, h } = props.deck.size;
  const scale = width / w;
  return (
    <div style={{ position: 'relative', width, height: h * scale, overflow: 'hidden' }}>
      {/* Physical left/top: in an RTL page an overflowing block would otherwise hang off the right. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
          transform: `scale(${scale})`,
        }}
      >
        <SlideRenderer {...props} />
      </div>
    </div>
  );
}

/**
 * A slide as wide as the box it is in, scaled by CSS against that box (a container query): it
 * needs no measuring, so it can be drawn before it is laid out, in a panel drawn ahead and
 * hidden, and a box that changes its width does not draw it again.
 */
export function FittedSlide(props: SlideRendererProps) {
  const { w, h } = props.deck.size;
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: `${w} / ${h}`,
        overflow: 'hidden',
        containerType: 'inline-size',
      }}
    >
      {/* Physical left/top, as in `ScaledSlide`. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
          transform: `scale(calc(100cqw / ${w}px))`,
        }}
      >
        <SlideRenderer {...props} />
      </div>
    </div>
  );
}
