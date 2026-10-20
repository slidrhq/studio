// The Deck API (SPEC 11.4): tool definitions in Zod, executors over the CommandBus, the scope
// guard and the turn transaction. Transport-agnostic: nothing here may import or mention the
// wire protocol (API-02); an adapter publishes `list()` and forwards to `call()`.
export {
  createDeckApi,
  inputJsonSchema,
  summarizeWrite,
  type DeckApi,
  type DeckApiOptions,
  type ToolListing,
} from './registry';
export { availableIn, checkWrite, describeScope, type ScopeKind, type SessionScope } from './scope';
export {
  DeckApiError,
  defineTool,
  startTurn,
  type EndSignal,
  type ToolContext,
  type ToolDef,
  type ToolError,
  type ToolErrorCode,
  type ToolOutput,
  type ToolResult,
  type Turn,
  type WriteSummary,
} from './tool';
export { Background, type Finished } from './background';
export { formatZodError, toToolError } from './errors';
export { markdownToRichText, paragraphDir, parseInline, type MarkdownOptions } from './markdown';
export { deckTools } from './tools';
export { DEFAULT_TRANSITION, deckTransition, defaultTimeline, withDefaultMotion } from './motion';
export { appearances, occurrenceAt, replaceInText } from './textReplace';
export {
  closestAspect,
  imagePlaceholders,
  slidePlaceholders,
  styledPrompt,
  type ImagePlaceholder,
} from './images';
export type * from './services';
