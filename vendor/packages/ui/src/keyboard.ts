import { useSyncExternalStore } from 'react';

/*
 * The keyboard as the user's way of working (DSN-08), for two things a browser does not do for
 * the app:
 *
 *   - The ring of a surface that draws its own focus. The Stage and the Filmstrip take the focus
 *     by script when they are pressed, and a browser's own rule for showing a ring
 *     (`:focus-visible`) has nothing to go by then. Each asks here when the focus comes to it,
 *     and shows its ring when the keyboard is what brought it: the keyboard is in use from the
 *     first key pressed until the next press of the pointer. After a press on the surface what
 *     is selected there says where the keyboard is, and the keys that follow add no ring: around
 *     a whole surface it read as the surface being selected.
 *   - Who gets the keyboard back when a layer closes. A dialog knows the button it was opened
 *     from only when that button is its own trigger; most dialogs of the app are opened by a
 *     function, from a key or from an item of a menu.
 */

/** Keys that are held with a press of the pointer, and so say nothing about the keyboard. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Fn']);

let inUse = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (inUse === next) return;
  inUse = next;
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  // In the capture phase, so the answer is ready before any handler of the key or the press.
  window.addEventListener('keydown', (event) => !MODIFIERS.has(event.key) && set(true), true);
  window.addEventListener('pointerdown', () => set(false), true);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True from a key press until the next press of the pointer. */
export function keyboardInUse(): boolean {
  return inUse;
}

/** `keyboardInUse`, for a component that draws by it. */
export function useKeyboardInUse(): boolean {
  return useSyncExternalStore(subscribe, keyboardInUse, () => false);
}

/** Whether an element can be given the keyboard now. */
function takesKeyboard(node: HTMLElement): boolean {
  if (!node.isConnected || node === document.body) return false;
  if (node.closest('[inert]') || node.matches(':disabled')) return false;
  return node.getClientRects().length > 0;
}

/**
 * Remembers who has the keyboard now, for a layer that is about to take it. Returns the function
 * that gives the keyboard back, which says whether it found someone to give it to.
 *
 * It is what has the focus now. An item of a menu or a control of a popover is gone by the time
 * the layer closes, since choosing it closed the menu; the keyboard then goes to the button that
 * opened that menu or popover, which is where it would be had the choice opened nothing.
 */
export function rememberKeyboard(): () => boolean {
  const owners: HTMLElement[] = [];
  let node = document.activeElement;
  for (let level = 0; node instanceof HTMLElement && node !== document.body && level < 6; level++) {
    owners.push(node);
    // A menu names the button that opened it; the button of a popover names the popover.
    const menu = node.closest('[role="menu"]');
    const floating = node.closest('[data-radix-popper-content-wrapper]')?.firstElementChild;
    const named = menu?.getAttribute('aria-labelledby');
    if (named) node = document.getElementById(named);
    else if (floating?.id && !menu)
      node = document.querySelector(`[aria-controls="${CSS.escape(floating.id)}"]`);
    else node = null;
  }
  return () => {
    const owner = owners.find(takesKeyboard);
    owner?.focus({ preventScroll: true });
    return owner !== undefined;
  };
}
