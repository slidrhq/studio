import { z } from 'zod';
import { Deck, SCHEMA_VERSION } from './schema';

/** Turns a stored deck of one schema version into the next version. Works on raw JSON. */
export type Migration = (deck: Record<string, unknown>) => Record<string, unknown>;

/**
 * Keyed by the version a migration starts from: `migrations[1]` turns a version 1 deck into
 * version 2. Every bump of `SCHEMA_VERSION` adds one entry here.
 */
export const migrations: Record<number, Migration> = {};

export type DeckLoadErrorCode =
  /** Not a deck at all: no usable `schemaVersion`. */
  | 'not_a_deck'
  /** Written by a newer version of the app. */
  | 'newer_version'
  /** A migration step is missing. */
  | 'no_migration'
  /** Does not match the schema, even after migration. */
  | 'invalid';

export class DeckLoadError extends Error {
  readonly code: DeckLoadErrorCode;

  constructor(code: DeckLoadErrorCode, message: string) {
    super(message);
    this.name = 'DeckLoadError';
    this.code = code;
  }
}

export interface LoadedDeck {
  deck: Deck;
  /** The version the stored deck had, when it was older than the current one (DOC-04). */
  migratedFrom?: number;
}

/**
 * Validates a parsed `deck.json`, migrating it first when it was written by an older version.
 * Throws `DeckLoadError`.
 */
export function loadDeck(raw: unknown, table: Record<number, Migration> = migrations): LoadedDeck {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DeckLoadError('not_a_deck', 'The file does not contain a deck.');
  }
  let data = raw as Record<string, unknown>;
  const stored = data.schemaVersion;
  if (typeof stored !== 'number' || !Number.isInteger(stored) || stored < 0) {
    throw new DeckLoadError('not_a_deck', 'The file does not contain a deck.');
  }
  if (stored > SCHEMA_VERSION) {
    throw new DeckLoadError(
      'newer_version',
      `The deck was saved by a newer version of Slidr (schema ${stored}, this version reads up to ${SCHEMA_VERSION}).`,
    );
  }

  for (let version = stored; version < SCHEMA_VERSION; version++) {
    const migrate = table[version];
    if (!migrate) {
      throw new DeckLoadError('no_migration', `No migration from schema version ${version}.`);
    }
    data = { ...migrate(data), schemaVersion: version + 1 };
  }

  const parsed = Deck.safeParse(data);
  if (!parsed.success) {
    throw new DeckLoadError('invalid', `The deck is not valid:\n${z.prettifyError(parsed.error)}`);
  }
  return stored < SCHEMA_VERSION
    ? { deck: parsed.data, migratedFrom: stored }
    : { deck: parsed.data };
}
