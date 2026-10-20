/**
 * What the rules need from a rendered slide (LNT-02). The rules read these plain numbers and
 * never the DOM, so they run in Node on measurements written by hand. `measureSlide` of
 * `@slidr/renderer` produces them from the rendered DOM; neither package imports the other, and
 * the app's lint service is where TypeScript checks that one fits the other.
 */
import type { Frame } from '@slidr/model';

/** A colour as drawn: red, green and blue, 0..255. */
export type Rgb = readonly [number, number, number];

/** The text of one colour and size inside an element. */
export interface TextSpanMeasure {
  color: Rgb;
  /** Opacity of the glyphs, 0..1: the colour's alpha times the opacity of the element. */
  alpha: number;
  /** Font size as drawn, in slide pixels: after `shrink`, and after an `html` element's scaling. */
  fontSize: number;
  /**
   * Colours under the glyphs, sampled across the text with the text itself left out: the slide
   * background and whatever else is drawn there, images and gradients included. Empty when what
   * is under the text could not be read.
   */
  backdrop: readonly Rgb[];
}

export interface TextMeasure {
  /** The box around the glyphs as drawn on the slide, after rotation. */
  ink: Frame;
  /** How far the text runs past the inside of its box, in slide pixels; 0 where it fits. */
  overflow: { x: number; y: number };
  /** The scale `autoFit: shrink` settled on; 1 when the text is at its own size. */
  scale: number;
  spans: readonly TextSpanMeasure[];
}

export interface ElementMeasure {
  /**
   * The box the element covers on the slide: after rotation, inside its groups, and with the
   * real height of a text box that grows with its text.
   */
  box: Frame;
  /**
   * Present when the element shows text: a text box, a shape with text, a table, `html`, and a
   * chart, whose labels, legend and titles are text it draws itself.
   */
  text?: TextMeasure;
}

export interface SlideMeasurements {
  /** By element id. Hidden elements are not rendered and so are absent. */
  elements: Readonly<Record<string, ElementMeasure>>;
}
