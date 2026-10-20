// Render-and-measure converter: rendered DOM -> model elements (SPEC 11.5, 13; ADR-017).
// Knows nothing about presentation formats: no adapters, no slide-detection rules (IMP-04).
export { createConversionService } from './service';
export {
  convertSubtree,
  mountSlide,
  startConversion,
  type Conversion,
  type ConversionResult,
  type ConvertOptions,
  type Fallback,
  type GuardReport,
  type MountedSlide,
  type Placement,
  type Verdict,
} from './engine';
export { openSandbox, type Sandbox, type SandboxOptions } from './sandbox';
export type { ConversionHost } from './host';
export {
  createImportPage,
  type ImportCapture,
  type ImportCaptureRequest,
  type ImportPage,
  type ImportPageOptions,
  type ImportPicture,
  type ImportTarget,
  type ImportViewport,
} from './importPage';
export type { AppFontFace } from './sourceFonts';
