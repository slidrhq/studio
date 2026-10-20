import { agentActor, newId, type Actor, type Command, type Deck } from '@slidr/model';
import type { z } from 'zod';
import type { Background } from './background';
import type { ScopeKind, SessionScope } from './scope';
import type { PngImage, ServiceName, Services } from './services';

/**
 * One turn of one agent session (SPEC 11.4, D8). Every write of the turn is dispatched with
 * its `actor` and `txId`, so the turn is one undo step and `bus.undoTransaction(txId)` undoes
 * it (CMD-06).
 */
export interface Turn {
  readonly sessionId: string;
  readonly scope: SessionScope;
  /** `agent:<sessionId>:<turnId>` (CMD-04). */
  readonly actor: Actor;
  readonly txId: string;
  /** Shown in the history list. */
  readonly label?: string;
  /**
   * Goes off when the turn is over: it ended, the user stopped it, or its session went. From
   * then on its calls write nothing, also one that was already running (the app is never told
   * that a harness gave a call up). Absent for a turn that nobody ends.
   */
  readonly ended?: EndSignal;
  /**
   * Where the turn's calls leave the work that goes on after their results (ADR-097): an image
   * is made while the agent goes on. Absent for a turn whose calls wait for all their work.
   */
  readonly background?: Background;
}

/** Goes off once and stays off. (An `AbortSignal` is one.) */
export interface EndSignal {
  readonly aborted: boolean;
}

/** Starts a turn: a fresh transaction id, and the turn id (default: the same) in the actor. */
export function startTurn(
  sessionId: string,
  scope: SessionScope,
  options: { turnId?: string; label?: string; ended?: EndSignal; background?: Background } = {},
): Turn {
  const txId = newId('tx');
  return {
    sessionId,
    scope,
    actor: agentActor(sessionId, options.turnId ?? txId),
    txId,
    ...(options.label ? { label: options.label } : {}),
    ...(options.ended ? { ended: options.ended } : {}),
    ...(options.background ? { background: options.background } : {}),
  };
}

/** What a write changed, by id. Every write tool returns it (SPEC 11.4). */
export interface WriteSummary {
  /** Slides and elements the call added. */
  created: string[];
  /** Existing slides (their own fields or timeline) and elements the call changed. */
  changed: string[];
  /** Slides and elements the call removed. */
  removed: string[];
  /** Slides the call touched that still exist: the ones the lint findings are about. */
  slides: string[];
  /** Deck-wide parts that changed, when any did. */
  deck?: ('meta' | 'theme' | 'layouts' | 'slideOrder' | 'assets')[];
}

export interface ToolContext {
  /** The deck as it is now; it changes after each `write`. */
  readonly deck: Deck;
  readonly turn: Turn;
  readonly services: Services;
  /**
   * The call was given up: its turn is over, or the document it was started on is no longer the
   * open one. `write` refuses from then on, and `deck` may by then be another document's. A tool
   * that works in pieces looks before each piece.
   */
  readonly abandoned: boolean;
  /**
   * Applies commands as one atomic change, inside the turn's transaction. The scope guard
   * checks every command first; nothing is applied if one is refused, or if the call was
   * abandoned.
   */
  write(commands: readonly Command[]): WriteSummary;
  /**
   * Asks the scope guard about commands the tool means to write later, and throws its refusal
   * as `write` would. For a tool that pays for something first (an image takes a minute, and
   * money at some providers): a write the session may not make is refused before it is paid for.
   */
  allowed(commands: readonly Command[]): void;
  /**
   * Work that may go on after the call's result, in a turn that takes such work (ADR-097): the
   * call returns `meanwhile` at once, and what `work` returns is its final result, which its chip
   * shows and the agent is told of in a later result. In any other turn the call waits for `work`
   * and returns what it returns. `slideIds` are the slides it changes: a picture of one of them
   * waits for it.
   */
  later(
    slideIds: readonly string[],
    work: () => Promise<ToolOutput>,
    meanwhile: ToolOutput,
  ): Promise<ToolOutput>;
}

/** What a tool returns. The registry adds the write summary and lint findings to `data`. */
export interface ToolOutput {
  data?: Record<string, unknown>;
  images?: PngImage[];
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  /** snake_case, as in the catalogue of SPEC 11.4. */
  readonly name: string;
  /** For the agent: what the tool does and what its result contains. */
  readonly description: string;
  /** A Zod object; its JSON Schema is the tool's input schema. */
  readonly input: S;
  /** Scopes that may call the tool (SPEC 11.4: D, S, O). `deck` includes import sessions. */
  readonly scopes: readonly ScopeKind[];
  /** Whether the tool changes the deck. Write tools get the write summary and lint findings. */
  readonly writes: boolean;
  /**
   * False for a write tool whose slides the design check does not judge: an import brings in
   * the user's own design (SPEC 13.3), and its result carries no lint findings.
   */
  readonly lint?: false;
  /** The tool is registered only when this service is provided. */
  readonly requires?: ServiceName;
  /**
   * How long a call may take, in milliseconds, for a tool that needs more than the 60 seconds a
   * transport gives a call by default (SPEC 11.4): generating an image takes about a minute.
   */
  readonly timeoutMs?: number;
  /**
   * The slides a call shows the agent a picture of, all of them when it returns undefined: the
   * call waits for the turn's work on them that is still going on (ADR-097).
   */
  looksAt?(input: z.output<S>): readonly string[] | undefined;
  run(input: z.output<S>, ctx: ToolContext): ToolOutput | Promise<ToolOutput>;
}

/** Keeps the input type of each tool while the registry holds them as one list. */
export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef {
  return def;
}

export type ToolErrorCode =
  /** No tool by that name. */
  | 'unknown_tool'
  /** The tool exists, but the service it needs is not running in this app. */
  | 'unavailable'
  /** The session's scope does not allow the tool or the change (SPEC 11.4 scope guard). */
  | 'out_of_scope'
  /** The input does not match the tool's schema, or the result would not be a valid deck. */
  | 'invalid_input'
  /** A slide, element, layout or asset does not exist (any more). */
  | 'not_found'
  /** An id the call introduces is already taken. */
  | 'conflict'
  /** The call is well formed but cannot apply to the deck as it is. */
  | 'invalid_state'
  /** A service failed. */
  | 'failed';

export interface ToolError {
  code: ToolErrorCode;
  /** Written for the agent: what is wrong and what to do instead. */
  message: string;
}

export type ToolResult =
  | {
      ok: true;
      /**
       * JSON for the agent. For a write tool it includes the `WriteSummary` fields and, when
       * the lint service runs, `lint`: the findings for `slides` (`LintFinding[]`). When the
       * write made the app fit a group to its children again, also `refitted`: the frame each
       * element that was there before now has, by id (the group's, and its children's, which
       * are relative to it).
       */
      data: Record<string, unknown>;
      images: PngImage[];
      /**
       * The call's work goes on after this result (`ToolContext.later`): its final result, once
       * the work has ended. Never rejects. The agent is not sent it.
       */
      later?: Promise<ToolResult>;
    }
  | { ok: false; error: ToolError };

/** A failure a tool reports to the agent, with a code the agent can act on. */
export class DeckApiError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.name = 'DeckApiError';
    this.code = code;
  }
}
