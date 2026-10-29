import { useState, type ReactElement, type ReactNode } from 'react';
import { Direction, Tooltip as RadixTooltip } from 'radix-ui';
import { Kbd } from './kbd';
import { usePortalContainer } from './provider';

/** Logical sides: `start` and `end` follow the direction of the UI. */
export type TooltipSide = 'top' | 'bottom' | 'start' | 'end';

export interface TooltipProps {
  content: ReactNode;
  /** Shown as keycaps after the text. */
  shortcut?: string;
  side?: TooltipSide;
  /** Controlled open state; for the gallery, and with `onOpenChange` for a host that decides. */
  open?: boolean;
  /** What the tooltip asks for: open on hover or focus, closed on leave, Esc or a click. */
  onOpenChange?: (open: boolean) => void;
  /** The trigger: one element that takes a ref, such as a Button. */
  children: ReactElement;
}

export function usePhysicalSide(side: TooltipSide): 'top' | 'bottom' | 'left' | 'right' {
  const dir = Direction.useDirection();
  if (side === 'start') return dir === 'rtl' ? 'right' : 'left';
  if (side === 'end') return dir === 'rtl' ? 'left' : 'right';
  return side;
}

/** The app's tooltip. Never use the `title` attribute: that is the OS tooltip. */
export function Tooltip({
  content,
  shortcut,
  side = 'bottom',
  open,
  onOpenChange,
  children,
}: TooltipProps) {
  const physical = usePhysicalSide(side);
  const container = usePortalContainer();
  /*
   * A tooltip that its host holds open, without hearing what the tooltip asks for, was closed by
   * nothing: Esc asked it to close, it stayed, and being the topmost layer it took every Esc
   * after that as well. A popover whose focused control had such a tooltip could not be left
   * from the keyboard at all. So a request to close is always granted: the tooltip stays closed
   * until its host has said "closed" and then "open" again.
   */
  const held = open === true && !onOpenChange;
  const [dismissed, setDismissed] = useState(false);
  if (dismissed && !held) setDismissed(false);
  return (
    <RadixTooltip.Root
      {...(open === undefined ? {} : { open: open && !(held && dismissed) })}
      onOpenChange={(next) => {
        if (held && !next) setDismissed(true);
        onOpenChange?.(next);
      }}
    >
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal container={container}>
        <RadixTooltip.Content
          side={physical}
          sideOffset={6}
          collisionPadding={8}
          className="z-50 flex max-w-64 animate-fade-in items-center gap-2 rounded-control bg-ui-tooltip px-2 py-1 text-xs font-medium text-ui-on-tooltip shadow-overlay"
        >
          <span>{content}</span>
          {shortcut && <Kbd keys={shortcut} tone="inverted" />}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
