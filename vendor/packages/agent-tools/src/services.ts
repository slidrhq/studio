/**
 * What the Deck API needs from the rest of the app. Each service is optional: a tool that
 * needs one is registered only when it is provided, so the API works today with the model
 * alone and grows as the work groups deliver. Every service gets the deck it should work on,
 * so it renders, lints or converts exactly the state the tool saw.
 */
import type {
  AssetMeta,
  Command,
  Deck,
  Element,
  PlaceholderRole,
  SelectionState,
  Slide,
} from '@slidr/model';

/** A PNG for the agent to look at, base64 encoded (SPEC 11.4: tools return image content). */
export interface PngImage {
  mimeType: 'image/png';
  /** Base64 of the PNG file, without a `data:` prefix. */
  data: string;
  width?: number;
  height?: number;
}

/**
 * A stretch of text the user selected inside a text box, a shape or a table cell, while its
 * text is being edited (ADR-072). The text editor holds it, not the `SelectionStore`.
 */
export interface TextSelection {
  slideId: string;
  elementId: string;
  /** For a table: the cell the text is in. */
  cell?: { row: number; col: number };
  /** The selected characters; paragraphs and line breaks are `\n`. */
  text: string;
  /**
   * Which appearance of `text` in the element's text (or the cell's) it is, counted from 1, as
   * `text_replace` counts them.
   */
  occurrence: number;
}

/** The user's selection, as the app's `SelectionStore` holds it (CMD-05), and selected text. */
export type SelectionSnapshot = Pick<
  SelectionState,
  'currentSlideId' | 'selectedSlideIds' | 'selectedElementIds' | 'editingElementId'
> & {
  /** Text selected in the element being edited; absent or null when there is none. */
  textSelection?: TextSelection | null;
};

/** The editor around the deck. Filled by WG3 / WG11 from `SelectionStore` and the stage. */
export interface UiPort {
  selection(): SelectionSnapshot;
  /** Shows a slide on the stage and, optionally, selects elements on it. */
  navigate(target: { slideId: string; elementIds?: readonly string[] }): void;
}

/** WG2-T08: slide capture in the hidden capture window (ADR-003), in the stage's `edit` mode. */
export interface CaptureService {
  /** One slide, `width` pixels wide (16:9). */
  renderSlide(deck: Deck, slideId: string, options: { width: number }): Promise<PngImage>;
  /** Thumbnails of the slides in a grid, each labelled with its number in the deck. */
  renderContactSheet(
    deck: Deck,
    slideIds: readonly string[],
    options: { columns: number; width: number },
  ): Promise<PngImage>;
}

/** What goes into a placeholder: Markdown text (see `text_set`), an asset, or an image prompt. */
export type RoleContent = string | { assetId: string } | { imagePrompt: string };

/** WG7-T02: the layout engine. */
export interface LayoutService {
  /**
   * A new slide from a layout: its placeholders become elements, filled by role. Ids are new
   * and free in `deck`. The tool adds the slide; the service changes nothing.
   */
  createSlide(
    deck: Deck,
    request: {
      layoutId: string;
      /** A list fills the placeholders of a role that repeats (three cards), in order. */
      content: Partial<Record<PlaceholderRole, RoleContent | RoleContent[]>>;
      name?: string;
    },
  ): Promise<Slide>;
}

/** The result of converting HTML into model elements (SPEC 11.5). */
export interface HtmlSlideConversion {
  /** The slide with new ids: elements, background, slide `css`, timeline from `data-anim`. */
  slide: Slide;
  /** Assets the conversion stored (images, fonts). The tool registers them before the slide. */
  assets: AssetMeta[];
  /** Share of the content that became regular elements, 0..1; the rest stayed `html`. */
  editability: number;
  /** What the agent should know: content kept as `html`, missing assets, unknown tokens, ... */
  notes: string[];
}

/** One place where a forced conversion looks different from the HTML it replaces (HTM-05). */
export interface ConversionDifference {
  /** The element that differs; absent for a difference no element owns. */
  elementId?: string;
  /**
   * `text`: its lines break or sit elsewhere. `look`: it is drawn differently. `region`: an area
   * that differs and no element explains.
   */
  kind: 'text' | 'look' | 'region';
  /** Where a `region` is, in slide pixels of the element's parent. */
  frame?: { x: number; y: number; w: number; h: number };
  /** The engine's own words, in English. */
  detail: string;
}

export interface ElementConversion {
  /** The elements that replace the converted one, with new ids, in z-order. */
  elements: Element[];
  assets: AssetMeta[];
  editability: number;
  notes: string[];
  /** With `force`: what looks different from the HTML, since nothing was put back as html for it. */
  differences?: ConversionDifference[];
}

/** WG9A: the HTML conversion engine, shared with HTML import (SPEC ch. 13). */
export interface ConversionService {
  /** Converts a slide written as HTML/CSS at 1920x1080 (`<style>` allowed inside). */
  htmlToSlide(deck: Deck, request: { html: string; name?: string }): Promise<HtmlSlideConversion>;
  /**
   * `elements`: breaks an `html` element into regular ones. `html`: the opposite.
   *
   * `force`, with `elements`: everything the engine can map becomes a regular element, also where
   * it then looks different from the HTML; `differences` says where. Without it, what would look
   * different stays html.
   */
  convertElement(
    deck: Deck,
    request: { slideId: string; elementId: string; to: 'elements' | 'html'; force?: boolean },
  ): Promise<ElementConversion>;
}

export interface LintFinding {
  /** `L01` ... `L18` (SPEC 9.2, QG-04, ADR-042, ADR-099). */
  rule: string;
  severity: 'error' | 'warning' | 'info';
  slideId: string;
  elementIds: string[];
  message: string;
}

/** WG7-T05: design lint. It measures the rendered DOM (LNT-02), hence async. */
export interface LintService {
  /**
   * `agent`: the rules returned after every write (L01–L07, L13, L16, L18; LNT-04, QG-03, QG-04).
   * `all`: every rule, for `slide_lint` and `deck_lint`.
   */
  lint(deck: Deck, slideIds: readonly string[], rules: 'agent' | 'all'): Promise<LintFinding[]>;
}

export interface TemplateSummary {
  id: string;
  name: string;
  description?: string;
  /** Saved by the user (THM-05, THM-09), not built in. */
  personal: boolean;
}

/** A layout written as HTML with `data-role` on its placeholders (THM-06). */
export interface LayoutDraft {
  name: string;
  archetype: string;
  html: string;
}

/** A layout of a drafted template, as the agent should know it. */
export interface DraftedLayout {
  id: string;
  name: string;
  archetype: string;
  /** Its placeholders by role: `title, body ×3, image`. */
  placeholders: string;
  /** Present for a layout this call drew: the share of its HTML that became regular elements. */
  editability?: number;
}

/** What the design lint found on a layout of a draft, filled with a text. */
export interface DraftFinding {
  layout: string;
  /** The direction of the deck the layout was tried in: as drawn, and mirrored. */
  dir: 'rtl' | 'ltr';
  /**
   * What filled the layout: the sample it was drawn with, or the app's own short words for each
   * role in the language of that direction. A deck writes what it likes, and a text of another
   * length lands elsewhere in its box.
   */
  text: 'sample' | 'other';
  rule: string;
  severity: LintFinding['severity'];
  message: string;
}

export interface TemplateDraftResult {
  templateId: string;
  layouts: DraftedLayout[];
  findings: DraftFinding[];
  notes: string[];
  /** Every layout with its sample on it, on one sheet; absent when the app cannot capture. */
  preview?: PngImage;
}

/** WG7-T03 (switching) and WG7-T11a (AI templates). */
export interface TemplateService {
  list(): Promise<TemplateSummary[]>;
  /**
   * The commands that switch the deck to a template as one step (THM-04): theme, layouts, and
   * slides mapped to the new layouts by archetype and role.
   */
  applyCommands(deck: Deck, templateId: string): Promise<Command[]>;
  /**
   * A draft template from theme tokens and layouts in HTML; not saved, not applied. With
   * `basedOn` (a draft of an earlier call, or a template of the library) the draft starts as a
   * copy of it: the tokens are merged over its theme, and each layout replaces its layout of the
   * same archetype, or is added.
   */
  create(
    deck: Deck,
    request: {
      name: string;
      theme: Record<string, unknown>;
      layouts: LayoutDraft[];
      basedOn?: string;
    },
  ): Promise<TemplateDraftResult>;
  /** Saves a draft, or the deck's own theme and layouts when `templateId` is absent. */
  save(
    deck: Deck,
    request: { templateId?: string; name: string; setDefault: boolean },
  ): Promise<{ templateId: string }>;
}

/** An image the service stored as an asset, with a preview for the agent. */
export interface StoredImage {
  asset: AssetMeta;
  preview: PngImage;
}

export type ImageAspect = '16:9' | '4:3' | '1:1' | '3:4' | '9:16';

/**
 * The image provider a call goes to, as far as a tool's result should say (ADR-025): its name,
 * and what its `edit` does to the source. `regenerate`: a new image drawn after it, with no
 * pixel kept. `exact`: the source with only what was asked changed.
 */
export interface ImageProviderInfo {
  name: string;
  edit: 'none' | 'regenerate' | 'exact';
  /** `edit` can be confined to a mask. */
  mask: boolean;
}

/** What `image_process` does to a picture on this machine (GEN-06, GEN-07). */
export type ImageOperation = 'removeBackground' | 'keyOutBackground';

/** WG12-T01, T04, T05: AI images and local image processing. */
export interface ImageService {
  /**
   * `transparent`: the subject alone on a transparent background. A provider that cannot draw
   * transparency draws it on a flat colour, which the app then keys out on this machine (GEN-07).
   */
  generate(request: {
    prompt: string;
    count: number;
    aspect: ImageAspect;
    transparent?: boolean;
  }): Promise<StoredImage[]>;
  edit(request: {
    assetId: string;
    instruction: string;
    maskAssetId?: string;
    count: number;
  }): Promise<StoredImage[]>;
  /**
   * Local processing, as a new asset. `removeBackground`: a model on this machine keeps the
   * subject and makes the rest transparent. `keyOutBackground`: a flat background colour, read
   * off the picture's border, becomes transparent.
   */
  process(request: { assetId: string; operation: ImageOperation }): Promise<StoredImage>;
  /** The provider in use now. Optional: a service that has one provider need not say. */
  describe?(): Promise<ImageProviderInfo>;
}

/** WG12-T06: stock photos. The best matches are stored as assets, with attribution. */
export interface StockService {
  search(request: {
    query: string;
    count: number;
    orientation?: 'landscape' | 'portrait' | 'square';
  }): Promise<StoredImage[]>;
}

/** WG5-T11: the icon library. */
export interface IconService {
  search(request: {
    query: string;
    count: number;
  }): Promise<{ id: string; name: string; svg: string }[]>;
}

/** A card the user can pick (AIS-03, AIO-02, AIO-03). */
export interface OptionCard {
  label: string;
  /** A text variation, in Markdown. */
  text?: string;
  /** An image variation. */
  assetId?: string;
  /** A slide variation, in HTML as for `slide_create_from_html`. */
  html?: string;
  /**
   * A variation of an element as a change to it (AIO-06 to AIO-08): for a chart or a table the
   * arguments of `chart_set` or `table_set` that make it, without the element's id; for kind
   * `element`, the patch of `element_update`.
   */
  set?: Record<string, unknown>;
}

/** WG11-T08: the variations gallery. The app applies the user's pick, not the agent. */
export interface OptionsService {
  present(request: {
    kind: 'text' | 'image' | 'layout' | 'chart' | 'table' | 'element';
    target: { slideId: string; elementId?: string };
    prompt?: string;
    options: OptionCard[];
  }): Promise<void>;
}

/** Which element of the imported page: a CSS selector, or JavaScript that evaluates to it. */
export interface ImportTarget {
  selector?: string;
  js?: string;
}

/** A slide the import captured, already checked by the app (SPEC 13.3). */
export interface ImportedSlide {
  /** The slide, with ids that are free in the deck. */
  slide: Slide;
  /** The assets it uses and the fonts the file brought. The tool registers them first. */
  assets: AssetMeta[];
  /** Share of the content that became regular elements, and of the text that is in text elements. */
  editability: number;
  textEditability: number;
  /** The fidelity guard: the slide looks like the source; the comparison was exact. */
  faithful: boolean;
  exact: boolean;
  /** Nothing on the slide became a regular element: it is html only. */
  wholeSlideHtml: boolean;
  /**
   * The size of the captured element on the page, in CSS px, and the scale the page shows it
   * through (1 when it is shown at its own size).
   */
  source: { width: number; height: number; scale?: number };
  notes: string[];
}

/**
 * WG9-T15, T16: the isolated page an imported HTML file runs in (SPEC 13.2). The file's scripts
 * run there, without network and without the app. What comes back from it is data.
 */
export interface HtmlImportService {
  /** Page facts and an outline of the live DOM, as text. */
  inspect(request: ImportTarget & { depth?: number; maxNodes?: number }): Promise<string>;
  /** Runs the body of an async function in the page; its result as JSON text. */
  evaluate(code: string): Promise<string>;
  screenshot(request: ImportTarget & { maxWidth?: number }): Promise<PngImage>;
  /** Resizes the page; says what it is now. */
  setViewport(size: { width: number; height: number }): Promise<string>;
  /** Copies an element of the page and converts it into a slide for `deck`. Changes nothing. */
  capture(
    deck: Deck,
    request: ImportTarget & { before?: string; waitMs?: number },
  ): Promise<ImportedSlide>;
  /**
   * The slide entered the deck: the app keeps what it measured, for the import report, and what
   * the agent pointed at (`from`), so an import that was cut can be told what it has (IMP-09).
   */
  captured?(slide: ImportedSlide, from?: ImportTarget & { before?: string }): void;
  /** How many slides the agent's plan has for the whole import, for the user to see (IMP-11). */
  planned?(total: number): void;
  /**
   * Goes off when the turn that is running now is stopped or over. A capture call takes it when
   * it begins: from then on it starts no slide, and adds none that the page was still working
   * on, so nothing enters the deck behind a turn that has ended. (An `AbortSignal` is one.)
   */
  interruption?(): { readonly aborted: boolean };
}

export interface Services {
  ui?: UiPort;
  capture?: CaptureService;
  layouts?: LayoutService;
  conversion?: ConversionService;
  lint?: LintService;
  templates?: TemplateService;
  images?: ImageService;
  stock?: StockService;
  icons?: IconService;
  options?: OptionsService;
  importer?: HtmlImportService;
}

export type ServiceName = keyof Services;
