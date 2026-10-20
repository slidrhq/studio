/** A deep copy of plain JSON data: templates are shared, and commands carry their own objects. */
export function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Whether two plain JSON values hold the same data. The order of keys does not matter. */
export function equalJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  if (keys.length !== Object.keys(right).filter((key) => right[key] !== undefined).length) {
    return false;
  }
  return keys.every((key) => equalJson(left[key], right[key]));
}
