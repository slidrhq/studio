// SlideRenderer and the element renderers: model -> DOM (SPEC 7, ADR-009).
export { FittedSlide, SlideRenderer, ScaledSlide, type SlideRendererProps } from './SlideRenderer';
export type {
  AssetResolver,
  CellSlot,
  ElementSlot,
  HtmlEditing,
  HtmlSlot,
  RenderMode,
  TextSlot,
} from './context';
export {
  colorCss,
  familyCss,
  fontStack,
  hebrewFace,
  hebrewFaces,
  setFontCounterparts,
  shadowCss,
  themeVariables,
  themeVariablesCss,
} from './theme';
export { fillStyle } from './fill';
export {
  CELL_PADDING,
  cellLook,
  cellTextDefaults,
  tableEdges,
  tableLayout,
  tableStyle,
  tableStyles,
  type CellLook,
  type TableStyle,
} from './tableStyle';
export { presetPath, scalePath, shapePresets, isBoxPreset, type ShapePath } from './geometry';
export { extraShapes, type ExtraShape } from './extraShapes';
export { imagePlacement, linePath } from './elements';
export {
  colorRgb,
  duotonePreset,
  duotoneTokens,
  imageFilterNames,
  imageLook,
  type ImageFilterName,
  type ImageLook,
} from './imageLook';
export {
  firstStrong,
  listMarkers,
  listNumber,
  markerFontSize,
  markerWidthEm,
  paragraphDirection,
  paragraphStyle,
  readsAsNumber,
  runStyle,
  MARKER_EM,
  LEVEL_EM,
  type TextDefaults,
} from './text';
export { sanitizeMarkup } from './sanitize';
export { cleanPicture, SVG_NAMESPACE } from './picture';
export {
  ASSET_URL_SCHEME,
  cleanFreeMarkup,
  FREE_MARKUP_SELECTOR,
  normalizeColor,
  resolveAssetUrls,
  setFrameScriptNonce,
} from './markup';
export { scopeSlideCss } from './css';
export { settle } from './settle';
export { chartsSettled } from './chart/controller';
export { loadCharts } from './chart/view';
export { CHART_ATTRIBUTE, CHART_EVENT, type ChartCue } from './chart/cue';
export { chartSpec, type ChartSpec } from './chart/spec';
export { clipAttributes, CLIP_ATTRIBUTE, CLIP_TOGGLE_ATTRIBUTE } from './clip';
export { renderSlideOffscreen, type OffscreenOptions, type OffscreenSlide } from './offscreen';
export {
  measureSlide,
  type ElementMeasure,
  type SlideMeasurements,
  type TextMeasure,
  type TextSpanMeasure,
} from './measure';
