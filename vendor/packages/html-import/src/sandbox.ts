/**
 * The sandbox HTML is loaded in before it is measured (SPEC 14.3 SEC-03, IMP-08): a frame
 * that runs no scripts and reaches no network, laid out as a slide would lay it out. The
 * document inside stands in for a slide: its root carries the theme's variables and its body
 * the slide's base text style, exactly as `SlideRenderer` gives them to an `html` element
 * (ADR-009), so the HTML looks here as it will look on the slide.
 */
import type { Deck } from '@slidr/model';
import {
  ASSET_URL_SCHEME,
  colorCss,
  resolveAssetUrls,
  sanitizeMarkup,
  settle,
  themeVariablesCss,
} from '@slidr/renderer';
import type { ConversionHost } from './host';
import {
  BASE_STYLE_ATTRIBUTE,
  BLANK_IMAGE_ATTRIBUTE,
  rememberAssetUrls,
  RESOLVED_BACKGROUND_ATTRIBUTE,
} from './htmlCopy';

export interface Sandbox {
  frame: HTMLIFrameElement;
  document: Document;
  /** What the agent should know about how the HTML was loaded. */
  notes: string[];
  dispose(): void;
}

export interface SandboxOptions {
  deck: Deck;
  host: ConversionHost;
  /** The size the document is laid out at, in CSS px. */
  size: { w: number; h: number };
  /** Where the frame is put; it sits at the parent's top-left corner. */
  parent: HTMLElement;
}

/** `@font-face` rules of a document, with their URLs made absolute. */
function fontFaces(doc: Document): string[] {
  const rules: string[] = [];
  const visit = (list: CSSRuleList, base: string) => {
    for (const rule of Array.from(list)) {
      if (rule.constructor.name === 'CSSFontFaceRule') {
        rules.push(
          rule.cssText.replace(/url\((["']?)(.*?)\1\)/g, (whole, _q: string, url: string) => {
            try {
              return `url("${new URL(url, base).href}")`;
            } catch {
              return whole;
            }
          }),
        );
      } else if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules, base);
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      visit(sheet.cssRules, sheet.href ?? doc.baseURI);
    } catch {
      // A sheet from another origin cannot be read.
    }
  }
  return rules;
}

/** What a Content-Security-Policy source list needs to let a URL through. */
function cspSource(url: string): string | undefined {
  try {
    const parsed = new URL(url, document.baseURI);
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return undefined;
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.origin
      : parsed.protocol;
  } catch {
    return undefined;
  }
}

function escapeStyle(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

/** Whether the HTML carries scripts: it then cannot be measured without running them. */
export function hasScripts(html: string): boolean {
  return new DOMParser().parseFromString(html, 'text/html').querySelector('script') !== null;
}

/**
 * Loads HTML in the sandbox and waits until it shows what it will show: fonts loaded, images
 * decoded. The HTML may be a fragment or a whole document; `<style>` elements stay where
 * they are.
 */
export async function openSandbox(html: string, options: SandboxOptions): Promise<Sandbox> {
  const { deck, host, size, parent } = options;
  const notes: string[] = [];
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const sources = new Set<string>();
  const allow = (url: string) => {
    const source = cspSource(url);
    if (source) sources.add(source);
  };

  for (const el of Array.from(parsed.querySelectorAll('script, base, meta[http-equiv], link'))) {
    if (el.localName === 'link' && el.getAttribute('rel')?.toLowerCase().includes('stylesheet')) {
      notes.push(
        `A linked stylesheet was ignored (${el.getAttribute('href')?.slice(0, 80) ?? ''}): write the CSS in a <style> element.`,
      );
    }
    el.remove();
  }

  // Assets of the deck, by id (SPEC 11.5): the frame loads them from where the app serves them.
  for (const el of Array.from(parsed.querySelectorAll('[data-asset]'))) {
    const id = el.getAttribute('data-asset') ?? '';
    const asset = deck.assets[id];
    const url = asset ? host.resolveAsset(asset) : undefined;
    if (!url) continue;
    allow(url);
    if (['img', 'video', 'audio', 'source'].includes(el.localName)) el.setAttribute('src', url);
    else if (el.localName === 'image' || el.localName === 'use') el.setAttribute('href', url);
    else {
      (el as HTMLElement).style.backgroundImage = `url("${url}")`;
      el.setAttribute(RESOLVED_BACKGROUND_ATTRIBUTE, '');
    }
  }
  // And by name inside CSS, where an attribute cannot say it: `url("slidr-asset:<id>")`. The
  // address each got is remembered, so that a copy made of this document names the asset again.
  const written = new Map<string, string>();
  const named = {
    assetUrl(id: string): string | undefined {
      const asset = deck.assets[id];
      const url = asset ? host.resolveAsset(asset) : undefined;
      if (!url) return undefined;
      allow(url);
      written.set(url, id);
      return url;
    },
  };
  for (const style of Array.from(parsed.querySelectorAll('style'))) {
    const css = style.textContent ?? '';
    if (css.includes(ASSET_URL_SCHEME)) style.textContent = resolveAssetUrls(css, named);
  }
  for (const el of Array.from(parsed.querySelectorAll(`[style*="${ASSET_URL_SCHEME}"]`))) {
    el.setAttribute('style', resolveAssetUrls(el.getAttribute('style') ?? '', named));
  }
  // An image that waits for its picture shows nothing, not a broken-image icon.
  for (const el of Array.from(parsed.querySelectorAll('img[data-image-prompt]:not([src])'))) {
    el.setAttribute(
      'src',
      'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
    );
    el.setAttribute(BLANK_IMAGE_ATTRIBUTE, '');
  }

  if (host.icon) {
    for (const el of Array.from(parsed.querySelectorAll('[data-icon]'))) {
      if (el.childNodes.length > 0) continue;
      const id = el.getAttribute('data-icon') ?? '';
      const svg = await host.icon(id);
      if (!svg) {
        notes.push(`data-icon="${id}" is not an icon of the library.`);
        continue;
      }
      // Sized by the text around it, like an icon font, and drawn in the text colour.
      el.innerHTML = sanitizeMarkup(svg, parsed);
      const drawn = el.querySelector('svg');
      drawn?.setAttribute('width', '1em');
      drawn?.setAttribute('height', '1em');
      if (drawn)
        (drawn as SVGElement).style.cssText += ';display:inline-block;vertical-align:-0.125em';
    }
  } else if (parsed.querySelector('[data-icon]')) {
    notes.push('data-icon was ignored: the icon library is not available.');
  }

  // Fonts: a frame does not see the faces registered in the page around it.
  const faces = new Set(fontFaces(document));
  for (const asset of Object.values(deck.assets)) {
    if (asset.kind !== 'font' || !asset.font) continue;
    const url = host.resolveAsset(asset);
    if (!url) continue;
    faces.add(
      `@font-face { font-family: ${JSON.stringify(asset.font.family)}; font-weight: ${asset.font.weight}; font-style: ${asset.font.style}; font-display: block; src: url(${JSON.stringify(url)});${asset.font.unicodeRange ? ` unicode-range: ${asset.font.unicodeRange};` : ''} }`,
    );
  }
  for (const face of faces)
    for (const match of face.matchAll(/url\("([^"]*)"\)/g)) allow(match[1]!);

  const body = deck.theme.textStyles.body;
  const base = [
    `:root { ${themeVariablesCss(deck.theme, deck.meta.lang)} }`,
    // The slide's box, whatever the HTML says about its page.
    `html, body { margin: 0 !important; width: ${size.w}px !important; height: ${size.h}px !important; overflow: hidden !important; box-sizing: border-box !important; }`,
    'html { background: transparent; }',
    // Nothing is in motion while the page is measured.
    '*, *::before, *::after { transition: none !important; }',
    `body { padding: 0; font-family: var(--font-body); font-size: ${body.size}px; font-weight: 400; font-style: normal; line-height: ${body.lineHeight}; letter-spacing: normal; color: ${colorCss(body.color)}; }`,
    ...faces,
  ].join('\n');
  const origins = Array.from(sources).join(' ');
  const policy = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data: blob: ${origins}`,
    `font-src data: blob: ${origins}`,
    `media-src data: blob: ${origins}`,
  ].join('; ');
  const head = parsed.head;
  const style = parsed.createElement('style');
  style.setAttribute(BASE_STYLE_ATTRIBUTE, '');
  style.textContent = escapeStyle(base);
  const csp = parsed.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', policy);
  const charset = parsed.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  head.prepend(charset, csp, style);
  const root = parsed.documentElement;
  if (!root.hasAttribute('lang')) root.setAttribute('lang', deck.meta.lang);
  if (!root.hasAttribute('dir')) root.setAttribute('dir', deck.meta.dir);

  const frame = document.createElement('iframe');
  // Same origin, so the engine can read the DOM; no scripts, no forms, no navigation.
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = `position:absolute;left:0;top:0;width:${size.w}px;height:${size.h}px;border:0;margin:0;padding:0;background:transparent;color-scheme:normal;pointer-events:none`;
  frame.srcdoc = `<!doctype html>${root.outerHTML}`;
  const loaded = new Promise<void>((resolve, reject) => {
    frame.addEventListener('load', () => resolve(), { once: true });
    frame.addEventListener('error', () => reject(new Error('The sandbox frame did not load.')), {
      once: true,
    });
  });
  parent.append(frame);
  await loaded;
  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    throw new Error('The sandbox frame cannot be read.');
  }
  rememberAssetUrls(doc, written);
  await settle(doc);
  return { frame, document: doc, notes, dispose: () => frame.remove() };
}
