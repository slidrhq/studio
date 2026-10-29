import { useSyncExternalStore } from 'react';
import { cx } from '../cx';

export interface KbdProps {
  /** Keys joined by `+`, as in SPEC Appendix A: `Ctrl+Shift+S`. */
  keys: string;
  /** `inverted` sits on a tooltip. */
  tone?: 'default' | 'inverted';
  /**
   * The keys are drawn as they are given. Without it they go through what the host set with
   * `setShownKeys`: a hint written as the key a shortcut came with shows the user's own key.
   */
  exact?: boolean;
  className?: string;
}

/** What is drawn for a combination; an empty answer draws nothing. */
export type ShownKeys = (keys: string) => string;

const asGiven: ShownKeys = (keys) => keys;
let shown = asGiven;
let version = 0;
const watchers = new Set<() => void>();

const subscribe = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};
const current = () => version;

/**
 * Sets what every `Kbd` draws for the combination it was given, and draws them all again. A host
 * whose user can change shortcuts answers with the user's key (UI-06), so a tooltip or a menu
 * that names a key as text does not have to know. Called again with the same function when its
 * answers changed; `null` draws the keys as they are given.
 */
export function setShownKeys(next: ShownKeys | null): void {
  shown = next ?? asGiven;
  version += 1;
  for (const watcher of watchers) watcher();
}

/** A keyboard shortcut, one keycap per key. Always left-to-right, also in a Hebrew UI. */
export function Kbd({ keys, tone = 'default', exact = false, className }: KbdProps) {
  useSyncExternalStore(subscribe, current, current);
  const drawn = exact ? keys : shown(keys);
  if (!drawn) return null;
  return (
    <span dir="ltr" className={cx('inline-flex shrink-0 items-center gap-0.5', className)}>
      {drawn.split('+').map((key, i) => (
        <kbd
          key={i}
          className={cx(
            'inline-flex items-center justify-center rounded-small px-1 font-ui text-xs font-medium',
            tone === 'default'
              ? 'h-5 min-w-5 border border-ui-line bg-ui-field text-ui-fg-muted'
              : 'h-4.5 min-w-4.5 bg-ui-on-tooltip/15 text-ui-on-tooltip',
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}
