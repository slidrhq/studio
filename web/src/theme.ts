/**
 * The studio's colours, as the app chooses them: the system's, or light or dark always. The
 * choice is `data-theme` on the page, which the design tokens of @slidr/ui follow
 * (`theme.css`); none follows the system.
 */
import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'slidr.studio.theme';
const listeners = new Set<() => void>();

function read(): ThemeChoice {
  const stored = localStorage.getItem(KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

let choice = read();

function apply() {
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}
apply();

export function setTheme(next: ThemeChoice) {
  choice = next;
  if (next === 'system') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, next);
  apply();
  for (const listener of listeners) listener();
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => choice,
  );
}
