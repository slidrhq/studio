import type {
  AssetMeta,
  Direction,
  Element,
  HtmlElement,
  ShapeElement,
  TableElement,
  TextElement,
  Theme,
} from '@slidr/model';
import { createContext, useContext, type ReactNode } from 'react';

/**
 * Where a slide is shown. The renderer draws the same DOM in every mode (RND-01); the mode only
 * decides what may run or play:
 *
 * | mode        | scripts in `html` | media plays | pointer reaches content | pending placeholders |
 * |-------------|-------------------|-------------|-------------------------|----------------------|
 * | `edit`      | run               | no          | no (the Stage owns it)  | shown                |
 * | `thumbnail` | do not run        | no          | no                      | shown                |
 * | `present`   | run               | as set      | yes                     | hidden               |
 *
 * The capture window (RND-04) uses `edit`, so the agent sees what the user edits. Export uses
 * `present`.
 */
export type RenderMode = 'edit' | 'thumbnail' | 'present';

/** Turns an asset into a URL the document can load: the asset protocol in the app, data URIs in export. */
export type AssetResolver = (asset: AssetMeta) => string | undefined;

/** Lets the host wrap or replace an element's DOM, e.g. hide the one being text-edited. */
export type ElementSlot = (element: Element, rendered: ReactNode) => ReactNode;

/**
 * Puts the host's own content inside an element's text box, in place of the text: the Stage's
 * in-place editor (WG4). The box keeps its frame, padding, alignment and fitting, so the text does
 * not move. `undefined` keeps the rendered text.
 */
export type TextSlot = (element: TextElement | ShapeElement) => ReactNode | undefined;

/**
 * The same for one cell of a table: the host's content takes the place of the cell's text, inside
 * the cell, which keeps its padding, alignment, fill and borders (WG6). `undefined` keeps the text.
 */
export type CellSlot = (table: TableElement, row: number, col: number) => ReactNode | undefined;

/**
 * The host's hand on the content of an `html` element, to edit its text in place (HTM-03). The
 * renderer builds the content from the markup and hands it over; the host changes text in it and
 * writes the markup back to the model itself.
 */
export interface HtmlEditing {
  /**
   * The content already shows this markup: it is what the host wrote last. The renderer then
   * leaves the content alone, so a caret in it survives the host's own writes. Any other markup
   * (an undo, the agent) is rendered afresh and handed over again.
   */
  shows(markup: string): boolean;
  /**
   * The content of the element is in `root`. `source` is the same markup as it was parsed,
   * before it was cleaned and before its asset references were resolved; `sourceOf` gives the
   * node of `source` that a node of the content was made from. `rebuild` builds the content
   * again from the markup of the model, for a change the host could not keep; the content is then
   * handed over anew. Returns what to undo when the editing ends or the content is built again.
   */
  attach(
    root: ShadowRoot,
    source: DocumentFragment,
    sourceOf: (node: Node) => Node | undefined,
    rebuild: () => void,
  ): () => void;
}

/** Hands the content of an `html` element without scripts to the host. `undefined` leaves it be. */
export type HtmlSlot = (element: HtmlElement) => HtmlEditing | undefined;

export interface RenderContext {
  theme: Theme;
  mode: RenderMode;
  /** The deck's content direction and language, for documents that do not inherit them. */
  dir: Direction;
  lang: string;
  /** URL of an asset by id, or undefined when the deck does not have it. */
  assetUrl: (assetId: string) => string | undefined;
  asset: (assetId: string) => AssetMeta | undefined;
  /**
   * The number of the slide in its deck, from 1: what a slide-number element shows (SLD-04).
   * Undefined for a slide the deck does not hold, such as a preview or a template's cover.
   */
  slideNumber?: number;
  slot?: ElementSlot;
  textSlot?: TextSlot;
  cellSlot?: CellSlot;
  htmlSlot?: HtmlSlot;
  /** What the scripts of an `html` element's frame carry, so the page's policy lets them run. */
  scriptNonce?: string;
  /**
   * Whether a link to this address is one that will be followed where the slide is shown. A link
   * that will not be is not drawn as one: its text is text, and its element is no link.
   * Without it, every address a slide may open is followed (`opensAddress`).
   */
  opensLink?: (address: string) => boolean;
  /** How the slide's pictures are decoded (`SlideRendererProps.decoding`); `async` by default. */
  decoding?: 'sync' | 'async';
}

export const RenderContextValue = createContext<RenderContext | null>(null);

export function useRenderContext(): RenderContext {
  const ctx = useContext(RenderContextValue);
  if (!ctx) throw new Error('Element views render only inside a SlideRenderer');
  return ctx;
}

/** Ids for SVG defs (clip paths, markers, filters) that are unique on the page. */
export function domId(reactId: string, suffix: string): string {
  return `slidr${reactId.replace(/[^\w-]/g, '')}-${suffix}`;
}
