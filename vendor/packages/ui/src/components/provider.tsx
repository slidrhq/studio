import { createContext, useContext, type ReactNode } from 'react';
import { Direction, Tooltip } from 'radix-ui';

export type Dir = 'ltr' | 'rtl';

const PortalContainer = createContext<HTMLElement | null>(null);

/** Where menus, popovers, tooltips and dialogs are rendered. Null means `document.body`. */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainer) ?? undefined;
}

export interface UiProviderProps {
  /** Mirrors keyboard navigation, submenus and scrollbars of the Radix primitives. */
  dir: Dir;
  /**
   * Renders floating layers inside this element instead of `document.body`, so they pick up the
   * theme and direction of a subtree (the component gallery shows four at once).
   */
  portalContainer?: HTMLElement | null;
  children: ReactNode;
}

/** The context every @slidr/ui component needs. Wrap the app (or a gallery cell) in it once. */
export function UiProvider({ dir, portalContainer = null, children }: UiProviderProps) {
  return (
    <Direction.Provider dir={dir}>
      <PortalContainer value={portalContainer}>
        <Tooltip.Provider delayDuration={500} skipDelayDuration={300}>
          {children}
        </Tooltip.Provider>
      </PortalContainer>
    </Direction.Provider>
  );
}
