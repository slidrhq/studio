import type { ToolError, ToolResult } from './tool';

/**
 * A call whose work went on after its result, and has ended since: what the agent is told under
 * `meanwhile` in the result of its next call (ADR-097).
 */
export type Finished = { tool: string; input: unknown } & (
  { ok: true; data: Record<string, unknown> } | { ok: false; error: ToolError }
);

interface Job {
  tool: string;
  input: unknown;
  slideIds: readonly string[];
  done: Promise<ToolResult>;
}

/**
 * The work a turn's calls leave running after their results (ADR-097). An image takes about a
 * minute, and a harness gives the model nothing until every call it made at once is back: so a
 * call that puts an image into an element returns as soon as the image is asked for, and the
 * image goes into the element when it is ready, in the same turn and the same undo step.
 *
 * Whoever runs the turn keeps it open until the work is done, since a write after the turn's end
 * is refused; a picture of a slide waits for the work on that slide, so that it shows it.
 */
export class Background {
  readonly #jobs = new Set<Job>();
  #finished: Finished[] = [];

  /** Work of a call that goes on after its result. `done` never rejects. */
  add(job: Job): void {
    this.#jobs.add(job);
    void job.done.then((result) => {
      this.#jobs.delete(job);
      const { tool, input } = job;
      this.#finished.push(
        result.ok
          ? { tool, input, ok: true, data: result.data }
          : { tool, input, ok: false, error: result.error },
      );
    });
  }

  /** The calls whose work is still going on, oldest first. */
  get running(): { tool: string; input: unknown; slideIds: readonly string[] }[] {
    return [...this.#jobs].map(({ tool, input, slideIds }) => ({ tool, input, slideIds }));
  }

  /**
   * Resolves once no work on any of `slideIds` is going on, or no work at all when they are
   * absent: work that starts meanwhile is waited for too.
   */
  async settled(slideIds?: readonly string[]): Promise<void> {
    for (;;) {
      const waiting = [...this.#jobs].filter(
        (job) => !slideIds || job.slideIds.some((id) => slideIds.includes(id)),
      );
      if (waiting.length === 0) return;
      // Each job leaves the set before anyone who waits for it hears that it is done.
      await Promise.all(waiting.map((job) => job.done));
    }
  }

  /** What ended since this was last asked, oldest first. Each is told once. */
  takeFinished(): Finished[] {
    const finished = this.#finished;
    this.#finished = [];
    return finished;
  }
}
