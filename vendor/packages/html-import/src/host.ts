import type { AssetMeta } from '@slidr/model';
import type { AssetResolver } from '@slidr/renderer';

/**
 * What the conversion engine needs from the app around it. The package runs in the webview
 * and may not reach into the app, so these come in as arguments (ADR-017).
 */
export interface ConversionHost {
  /**
   * The pixels of a region of the page the engine runs in, as a PNG with one pixel per CSS
   * pixel. `x` and `y` are in CSS pixels of the viewport. In the app this is the capture path
   * of ADR-003; the engine compares two pictures taken the same way, so the path itself does
   * not matter as long as it is the same for both.
   */
  capture(rect: { x: number; y: number; width: number; height: number }): Promise<Blob>;
  /**
   * Stores bytes as an asset of the open deck and returns its record. Assets are addressed
   * by content: the same bytes give the same asset (SPEC 5.7).
   */
  storeAsset(
    bytes: Uint8Array<ArrayBuffer>,
    info: { mime: string; name?: string },
  ): Promise<AssetMeta>;
  /** A URL the page can load an asset from, as `SlideRenderer` takes it. */
  resolveAsset: AssetResolver;
  /** The SVG markup of a library icon, e.g. "lucide:rocket"; undefined when there is none. */
  icon?(id: string): Promise<string | undefined>;
}

/** A rectangle in CSS pixels of a viewport. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
