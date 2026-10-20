import { CommandError, type CommandErrorCode } from '@slidr/model';
import type { z } from 'zod';
import { DeckApiError, type ToolError, type ToolErrorCode } from './tool';

type Issue = z.core.$ZodIssue;

function pathText(path: readonly PropertyKey[]): string {
  let out = '';
  for (const key of path) {
    out += typeof key === 'number' ? `[${key}]` : `${out ? '.' : ''}${String(key)}`;
  }
  return out || '(input)';
}

/** A union branch that failed on its discriminator is not the one the caller meant. */
function failedOnTag(issues: readonly Issue[]): boolean {
  return issues.some((issue) => {
    const last = issue.path.at(-1);
    return issue.path.length === 1 && (last === 'type' || last === 'kind');
  });
}

function describeIssue(issue: Issue, path: readonly PropertyKey[]): string {
  // A discriminated union whose tag matched no option.
  const options = issue.code === 'invalid_union' && 'options' in issue ? issue.options : undefined;
  if (options?.length) {
    return `${pathText(path)}: must be one of ${options.map((o) => JSON.stringify(o)).join(', ')}`;
  }
  return `${pathText(path)}: ${issue.message}`;
}

/** Every branch rejected the tag (`type` or `kind`): one line with all the values allowed. */
function tagLine(branches: readonly (readonly Issue[])[], path: readonly PropertyKey[]): string {
  let key: PropertyKey = 'type';
  const allowed = new Set<unknown>();
  for (const issue of branches.flat()) {
    const tag = issue.path.length === 1 ? issue.path[0] : undefined;
    if (tag !== 'type' && tag !== 'kind') continue;
    key = tag;
    if (issue.code === 'invalid_value') issue.values.forEach((v) => allowed.add(v));
    if (issue.code === 'invalid_union' && 'options' in issue) {
      issue.options?.forEach((v) => allowed.add(v));
    }
  }
  const values = [...allowed].map((v) => JSON.stringify(v)).join(', ');
  return `${pathText([...path, key])}: must be one of ${values}`;
}

/** One line per problem, with the path of the field, looking into the union branch meant. */
function issueLines(issues: readonly Issue[], prefix: readonly PropertyKey[]): string[] {
  const lines: string[] = [];
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union' && issue.errors.length > 0) {
      const candidates = issue.errors.filter((branch) => !failedOnTag(branch));
      if (candidates.length === 0) {
        lines.push(tagLine(issue.errors, path));
        continue;
      }
      const best = candidates.reduce((a, b) => (b.length < a.length ? b : a));
      lines.push(...issueLines(best, path));
    } else {
      lines.push(describeIssue(issue, path));
    }
  }
  return lines;
}

const MAX_LINES = 8;

/** A Zod error as the agent should read it: which field, and what is wrong with it. */
export function formatZodError(error: z.ZodError, prefix: readonly PropertyKey[] = []): string {
  const lines = [...new Set(issueLines(error.issues, prefix))];
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) shown.push(`... and ${lines.length - MAX_LINES} more`);
  return shown.join('\n');
}

const COMMAND_CODES: Record<CommandErrorCode, ToolErrorCode> = {
  unknown_command: 'invalid_input',
  invalid_payload: 'invalid_input',
  not_found: 'not_found',
  conflict: 'conflict',
  invalid_state: 'invalid_state',
};

/** Any failure of a tool as an error result. */
export function toToolError(error: unknown): ToolError {
  if (error instanceof DeckApiError) return { code: error.code, message: error.message };
  if (error instanceof CommandError) {
    let message = error.message;
    // CMD-07: the agent works from ids it read earlier; the user may have deleted them since.
    if (error.code === 'not_found' && !/may have been deleted/.test(message)) {
      message += ' It may have been deleted; read the deck again before retrying.';
    }
    return { code: COMMAND_CODES[error.code], message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'failed', message: message || 'The tool failed.' };
}
