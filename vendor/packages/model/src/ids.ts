const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
// Crockford base32: no I, L, O, U.
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** What an id names. Short prefixes keep ids cheap for the agent to read and repeat. */
export type IdPrefix = 's' | 'e' | 'a' | 'l' | 'p' | 'tx';

function randomChars(alphabet: string, length: number, random: () => number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(random() * alphabet.length)];
  return out;
}

/**
 * A short random id such as `e_k3x9a2bq`. Pass `isTaken` to rule out a clash with ids that
 * already exist in the deck.
 */
export function newId(
  prefix: IdPrefix,
  isTaken?: (id: string) => boolean,
  random: () => number = Math.random,
): string {
  for (;;) {
    const id = `${prefix}_${randomChars(BASE36, 8, random)}`;
    if (!isTaken?.(id)) return id;
  }
}

/** A ULID: 48 bits of time, 80 random bits, sortable by creation time. Used for deck ids. */
export function ulid(now: number = Date.now(), random: () => number = Math.random): string {
  let time = '';
  let rest = now;
  for (let i = 0; i < 10; i++) {
    time = BASE32.charAt(rest % 32) + time;
    rest = Math.floor(rest / 32);
  }
  return time + randomChars(BASE32, 16, random);
}
