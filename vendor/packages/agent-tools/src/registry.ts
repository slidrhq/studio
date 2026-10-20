import {
  allElementIds,
  mergeAffected,
  refitAfter,
  toJsonSchema,
  walkElements,
  type Affected,
  type Command,
  type CommandBus,
  type Deck,
  type JsonSchema,
  type Slide,
} from '@slidr/model';
import { z } from 'zod';
import { formatZodError, toToolError } from './errors';
import { availableIn, checkWrite, describeScope, type ScopeKind } from './scope';
import type { Services } from './services';
import { deckTools } from './tools';
import {
  DeckApiError,
  type ToolContext,
  type ToolDef,
  type ToolErrorCode,
  type ToolOutput,
  type ToolResult,
  type Turn,
  type WriteSummary,
} from './tool';

/** What a transport adapter publishes for one tool (name, description, JSON Schema input). */
export interface ToolListing {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  scopes: readonly ScopeKind[];
  writes: boolean;
  /** Present when the tool may take longer than a transport's default limit for a call. */
  timeoutMs?: number;
}

export interface DeckApi {
  /** The registered tools: those whose service is provided. */
  readonly tools: readonly ToolDef[];
  /** The tools with JSON Schema inputs; with a scope, only those a session of it may call. */
  list(scope?: ScopeKind): ToolListing[];
  /**
   * Runs one tool call of a turn. It never throws: every failure comes back as an error
   * result with a message for the agent, and leaves the deck as the last successful write
   * of the call left it. The work of the turn's calls that ended since its last call is told
   * with it: `meanwhile` in the data, or at the end of the message of a failure (ADR-097).
   */
  call(turn: Turn, name: string, input: unknown): Promise<ToolResult>;
  /**
   * Resolves once the turn's work that the call would show the agent a picture of has ended
   * (ADR-097): a picture of a slide waits for the images still being made for it. At once for
   * any other call. Never rejects.
   */
  ready(turn: Turn, name: string, input: unknown): Promise<void>;
}

export interface DeckApiOptions {
  /**
   * What the app makes of a write of the agent: commands that have to follow it, which go into
   * the same undo step and into the result of the call (the layouts of a deck whose direction
   * the write turned). Asked after every write, with the deck as the write left it and as it
   * was just before: what changed between the two is the write's own doing, and nothing else is.
   */
  follow?: (write: { deck: Deck; previous: Deck }) => readonly Command[];
}

function descriptionOf(schema: z.ZodType): string | undefined {
  let current: z.ZodType | undefined = schema;
  while (current) {
    if (current.description) return current.description;
    current =
      current instanceof z.ZodOptional || current instanceof z.ZodNullable
        ? (current.unwrap() as z.ZodType)
        : undefined;
  }
  return undefined;
}

/**
 * The model's JSON Schema of the input (shared model types become `$defs`), with the
 * descriptions of the top-level fields, which the model's export leaves out.
 */
export function inputJsonSchema(schema: z.ZodType): JsonSchema {
  const json = toJsonSchema(schema);
  const properties = json.properties as Record<string, JsonSchema> | undefined;
  if (schema instanceof z.ZodObject && properties) {
    const shape: unknown = schema.shape;
    for (const [key, field] of Object.entries(shape as Record<string, z.ZodType>)) {
      const description = descriptionOf(field);
      if (description && properties[key]) {
        properties[key] = { description, ...properties[key] };
      }
    }
  }
  return json;
}

const NOTHING: Affected = {
  meta: false,
  theme: false,
  slideOrder: false,
  layouts: [],
  slides: [],
  elements: [],
  assets: [],
};

function elementIdsOn(deck: Deck, slideIds: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>();
  for (const slide of deck.slides) {
    if (!slideIds.has(slide.id)) continue;
    for (const element of walkElements(slide.elements)) ids.add(element.id);
  }
  return ids;
}

/** A slide changed in itself, not only in its elements. The model keeps untouched parts identical. */
function slideFieldsChanged(was: Slide, is: Slide): boolean {
  const keys = new Set([...Object.keys(was), ...Object.keys(is)]) as Set<keyof Slide>;
  return [...keys].some((key) => key !== 'elements' && was[key] !== is[key]);
}

/** What a write did, by id, from what the bus reported and the deck before and after. */
export function summarizeWrite(before: Deck, after: Deck, affected: Affected): WriteSummary {
  const created: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const oldSlides = new Map(before.slides.map((s) => [s.id, s]));
  const newSlides = new Map(after.slides.map((s) => [s.id, s]));
  for (const id of affected.slides) {
    const was = oldSlides.get(id);
    const is = newSlides.get(id);
    if (!was && is) created.push(id);
    else if (was && !is) removed.push(id);
    else if (was && is && slideFieldsChanged(was, is)) changed.push(id);
  }
  const slideIds = new Set(affected.slides);
  const oldElements = elementIdsOn(before, slideIds);
  const newElements = elementIdsOn(after, slideIds);
  for (const id of affected.elements) {
    const was = oldElements.has(id);
    const is = newElements.has(id);
    if (!was && is) created.push(id);
    else if (was && !is) removed.push(id);
    else if (was && is) changed.push(id);
  }

  const deck: NonNullable<WriteSummary['deck']> = [];
  if (affected.meta) deck.push('meta');
  if (affected.theme) deck.push('theme');
  if (affected.layouts.length > 0) deck.push('layouts');
  const addedOrRemoved = [...created, ...removed].some(
    (id) => oldSlides.has(id) || newSlides.has(id),
  );
  if (affected.slideOrder && !addedOrRemoved) deck.push('slideOrder');
  if (affected.assets.length > 0) deck.push('assets');

  return {
    created,
    changed,
    removed,
    slides: affected.slides.filter((id) => newSlides.has(id)),
    ...(deck.length > 0 ? { deck } : {}),
  };
}

function failure(code: ToolErrorCode, message: string): ToolResult {
  return { ok: false, error: { code, message } };
}

/** What a call is told when its turn can no longer write. Mostly nobody is left to read it. */
const TURN_OVER =
  'the turn this call belongs to is over (it was stopped, or another document was opened).';

/** A result with the work of the turn that ended since its last call (ADR-097). */
function withFinished(turn: Turn, result: ToolResult): ToolResult {
  const finished = turn.background?.takeFinished() ?? [];
  if (finished.length === 0) return result;
  if (result.ok) return { ...result, data: { ...result.data, meanwhile: finished } };
  const message = `${result.error.message}\nMeanwhile: ${JSON.stringify(finished)}`;
  return { ok: false, error: { ...result.error, message } };
}

/** "deck sessions", "deck and slide sessions", "deck, slide and object sessions". */
function scopeNames(scopes: readonly ScopeKind[]): string {
  const names =
    scopes.length > 1 ? `${scopes.slice(0, -1).join(', ')} and ${scopes.at(-1)}` : scopes[0];
  return `${names} sessions`;
}

/**
 * The Deck API over a command bus (SPEC 11.4). `services` decides which of the tools that
 * need another part of the app are registered. Plain closures over the bus: the transport
 * adapter, the harness and the tests all call `call` the same way (API-01).
 */
export function createDeckApi(
  bus: CommandBus,
  services: Services = {},
  options: DeckApiOptions = {},
): DeckApi {
  const tools = deckTools.filter((tool) => !tool.requires || services[tool.requires]);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const schemas = new Map<string, JsonSchema>();

  // A turn belongs to the document it began on. The bus outlives its documents (File > New and
  // Open put another deck into it), and a deck's id does not tell them apart: the same file can
  // be opened again. So the documents are counted, and a turn keeps the number of its own.
  let opened = 0;
  bus.subscribe((event) => {
    if (event.kind === 'reset') opened++;
  });
  const homes = new WeakMap<Turn, number>();

  function list(scope?: ScopeKind): ToolListing[] {
    return tools
      .filter((tool) => !scope || availableIn(tool.scopes, scope))
      .map((tool) => {
        let inputSchema = schemas.get(tool.name);
        if (!inputSchema) {
          inputSchema = inputJsonSchema(tool.input);
          schemas.set(tool.name, inputSchema);
        }
        return {
          name: tool.name,
          description: tool.description,
          inputSchema,
          scopes: tool.scopes,
          writes: tool.writes,
          ...(tool.timeoutMs ? { timeoutMs: tool.timeoutMs } : {}),
        };
      });
  }

  async function ready(turn: Turn, name: string, input: unknown): Promise<void> {
    const tool = byName.get(name);
    if (!tool?.looksAt || !turn.background) return;
    const parsed = tool.input.safeParse(input ?? {});
    if (parsed.success) await turn.background.settled(tool.looksAt(parsed.data));
  }

  async function call(turn: Turn, name: string, input: unknown): Promise<ToolResult> {
    return withFinished(turn, await run(turn, name, input));
  }

  async function run(turn: Turn, name: string, input: unknown): Promise<ToolResult> {
    const tool = byName.get(name);
    if (!tool) {
      const known = deckTools.find((t) => t.name === name);
      return known
        ? failure('unavailable', `${name} is not available in this version of the app.`)
        : failure('unknown_tool', `There is no tool named "${name}".`);
    }
    if (!availableIn(tool.scopes, turn.scope.kind)) {
      return failure(
        'out_of_scope',
        `${name} is not available in ${describeScope(turn.scope)}; it works in ${scopeNames(tool.scopes)}.`,
      );
    }
    const parsed = tool.input.safeParse(input ?? {});
    if (!parsed.success) {
      return failure(
        'invalid_input',
        `Invalid input for ${name}:\n${formatZodError(parsed.error)}`,
      );
    }
    const home = homes.get(turn) ?? opened;
    homes.set(turn, home);
    const abandoned = () => home !== opened || turn.ended?.aborted === true;
    if (abandoned()) return failure('invalid_state', `${name} was not run: ${TURN_OVER}`);

    // All writes of the call, so the result reports them together.
    let before: Deck | undefined;
    let after: Deck | undefined;
    let affected: Affected | undefined;
    const refitted: Record<string, unknown> = {};
    // The work the call leaves running after its result, in a turn that takes it (ADR-097).
    let going: Promise<ToolResult> | undefined;
    const ctx: ToolContext = {
      get deck() {
        return bus.deck;
      },
      turn,
      services,
      get abandoned() {
        return abandoned();
      },
      allowed(commands) {
        const refusal = checkWrite(turn.scope, commands, bus.deck);
        if (refusal) throw new DeckApiError('out_of_scope', refusal);
      },
      write(commands) {
        if (!tool.writes) throw new Error(`${name} is declared read-only but tried to write.`);
        // A call that waited on a service (a conversion, an image) comes back to a turn that
        // was stopped, or to another document: what it made is nobody's any more.
        if (abandoned()) {
          throw new DeckApiError('invalid_state', `Nothing was written: ${TURN_OVER}`);
        }
        const start = bus.deck;
        if (commands.length === 0) return summarizeWrite(start, start, NOTHING);
        const refusal = checkWrite(turn.scope, commands, start);
        if (refusal) throw new DeckApiError('out_of_scope', refusal);
        const step = {
          actor: turn.actor,
          txId: turn.txId,
          ...(turn.label ? { label: turn.label } : {}),
        };
        let done = bus.batch(commands, step);
        // What the app adds is the app's own doing, not the session's: the scope guard is not
        // asked. It is part of what the call changed all the same, and the result says so.
        //
        // A group bounds its children (ARR-01), and the agent moves and sizes them by numbers:
        // the groups around what it wrote are fitted again here. That moves the group and
        // rewrites the frame of every child, the ones the call did not name too, so the result
        // gives the frames it left: the caller read the old ones.
        const fit = refitAfter(bus.deck, start, done);
        if (fit.length > 0) {
          done = mergeAffected(done, bus.batch(fit, step));
          const known = allElementIds(start);
          for (const command of fit) {
            if (command.type === 'element.update' && known.has(command.elementId)) {
              refitted[command.elementId] = command.patch.frame;
            }
          }
        }
        const follow = options.follow?.({ deck: bus.deck, previous: start }) ?? [];
        if (follow.length > 0) done = mergeAffected(done, bus.batch(follow, step));
        before ??= start;
        after = bus.deck;
        affected = affected ? mergeAffected(affected, done) : done;
        return summarizeWrite(start, after, done);
      },
      async later(slideIds, work, meanwhile) {
        const { background } = turn;
        if (!background) return work();
        // Its result is made as the call's would be: what the call wrote by then, and the findings.
        const done = work().then(complete).catch(fail);
        going = done;
        background.add({ tool: name, input: parsed.data, slideIds, done });
        return meanwhile;
      },
    };

    /** The result of a call whose tool returned `output`. */
    const complete = async (output: ToolOutput): Promise<ToolResult> => {
      const data: Record<string, unknown> = { ...output.data };
      if (tool.writes) {
        const summary =
          before && after && affected
            ? summarizeWrite(before, after, affected)
            : summarizeWrite(bus.deck, bus.deck, NOTHING);
        Object.assign(data, summary);
        if (Object.keys(refitted).length > 0) data.refitted = refitted;
        // An import session brings in the user's own design (SPEC 13.3): what it writes is not
        // judged as it goes. slide_lint and deck_lint are there to ask.
        const judged = tool.lint !== false && turn.scope.kind !== 'import';
        if (services.lint && judged && summary.slides.length > 0 && !abandoned()) {
          const live = new Set(bus.deck.slides.map((s) => s.id));
          const slides = summary.slides.filter((id) => live.has(id));
          try {
            data.lint = await services.lint.lint(bus.deck, slides, 'agent');
          } catch (error) {
            data.lintError = toToolError(error).message;
          }
        }
      }
      return { ok: true, data, images: output.images ?? [] };
    };

    /** The result of a call whose tool threw `error`. */
    const fail = (error: unknown): ToolResult => {
      const result = toToolError(error);
      if (before && after && affected) {
        // A tool that failed after writing: what it wrote stays, as part of the turn.
        const summary = summarizeWrite(before, after, affected);
        result.message += `\nChanges made before the failure were kept: ${JSON.stringify(summary)}`;
      }
      return { ok: false, error: result };
    };

    try {
      // A picture shows the slides with the images that are still being made for them.
      if (tool.looksAt && turn.background) {
        await turn.background.settled(tool.looksAt(parsed.data));
      }
      const result = await complete(await tool.run(parsed.data, ctx));
      return result.ok && going ? { ...result, later: going } : result;
    } catch (error) {
      return fail(error);
    }
  }

  return { tools, list, call, ready };
}
