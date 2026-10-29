import { useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import { Dialog as RadixDialog, Popover as RadixPopover } from 'radix-ui';
import { X } from 'lucide-react';
import { cx } from '../cx';
import { keyboardInUse, rememberKeyboard } from '../keyboard';
import { IconButton } from './button';
import { usePortalContainer } from './provider';

/* ---------------------------------------------------------------- popover */

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

/**
 * A popover is a dialog to a screen reader, and a dialog without a name is announced as just
 * "dialog" (DSN-08). Unless its caller names it, a popover takes the name of the button that
 * opened it, which already says what it is for: "Background", "Font size".
 */
function nameAfterTrigger(content: HTMLElement | null): void {
  if (!content?.id) return;
  if (content.hasAttribute('aria-label') || content.hasAttribute('aria-labelledby')) return;
  // The trigger says which popover is its own; the popover does not say which trigger.
  const trigger = document.querySelector(`[aria-controls="${CSS.escape(content.id)}"]`);
  if (!trigger) return;
  if (!trigger.id) trigger.id = `${content.id}-trigger`;
  content.setAttribute('aria-labelledby', trigger.id);
}

/** A floating panel next to its trigger: forms and pickers. */
export function PopoverContent({
  className,
  sideOffset = 6,
  align = 'start',
  ref,
  ...props
}: ComponentPropsWithRef<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal container={usePortalContainer()}>
      <RadixPopover.Content
        ref={(node) => {
          nameAfterTrigger(node);
          if (typeof ref === 'function') return ref(node);
          if (ref) ref.current = node;
          return undefined;
        }}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cx(
          'z-50 w-popover rounded-panel border border-ui-line bg-ui-raised p-4 text-sm text-ui-fg shadow-overlay animate-overlay-in',
          className,
        )}
        {...props}
      />
    </RadixPopover.Portal>
  );
}

/* ---------------------------------------------------------------- dialog */

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export interface DialogContentProps extends Omit<
  ComponentPropsWithRef<typeof RadixDialog.Content>,
  'title'
> {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons at the end of the dialog, the main action last. */
  footer?: ReactNode;
  /** The accessible name of the close button; omit it to have no close button. */
  closeLabel?: string;
  /**
   * `wide` for a dialog that shows a slide or a picture beside its controls (decompose, the mask
   * painter): 720px, as narrow as the window when that is less.
   */
  size?: 'default' | 'wide';
}

/** A modal dialog centred over a scrim. */
export function DialogContent(props: DialogContentProps) {
  return (
    <RadixDialog.Portal container={usePortalContainer()}>
      <RadixDialog.Overlay className="fixed inset-0 z-50 animate-fade-in bg-ui-scrim" />
      <DialogSheet {...props} />
    </RadixDialog.Portal>
  );
}

/** The dialog itself. It is there only while the dialog is open, which is what it goes by. */
function DialogSheet({
  title,
  description,
  footer,
  closeLabel,
  size = 'default',
  className,
  children,
  onCloseAutoFocus,
  ...props
}: DialogContentProps) {
  /*
   * A dialog gives the keyboard back to what opened it (DSN-08). Radix knows that only for a
   * dialog with a trigger of its own; a dialog opened by a function, as most of the app's are
   * (a key, an item of a menu, a question the app asks), left the keyboard nowhere when it
   * closed. So who has the keyboard is remembered as the dialog opens, before it takes it, and
   * whether the keyboard is what opened it.
   */
  const [opened] = useState(() => ({ back: rememberKeyboard(), byKeys: keyboardInUse() }));
  return (
    <RadixDialog.Content
      // A description is optional; Radix warns unless told there is none.
      {...(description ? {} : { 'aria-describedby': undefined })}
      className={cx(
        'fixed inset-0 z-50 m-auto flex h-fit animate-overlay-in flex-col gap-4 rounded-panel border border-ui-line bg-ui-raised p-5 text-sm text-ui-fg shadow-overlay',
        size === 'wide' ? 'w-dialog-wide max-w-full' : 'w-dialog',
        className,
      )}
      onCloseAutoFocus={(event) => {
        // The caller decides first, and says so by preventing the default.
        onCloseAutoFocus?.(event);
        if (event.defaultPrevented) return;
        // Whoever closed the dialog may have put the keyboard somewhere already, as a tool does
        // whose result is on the slide. That stands for a dialog the pointer opened. One that the
        // keyboard opened goes back to where the keyboard was, so its next Tab goes on from there.
        const active = document.activeElement;
        const nowhere = !active || active === document.body || !active.isConnected;
        if ((opened.byKeys || nowhere) && opened.back()) event.preventDefault();
      }}
      {...props}
    >
      <div className="flex flex-col gap-1 pe-8">
        <RadixDialog.Title className="text-md font-semibold">{title}</RadixDialog.Title>
        {description && (
          <RadixDialog.Description className="text-ui-fg-muted">
            {description}
          </RadixDialog.Description>
        )}
      </div>
      {children}
      {footer && <div className="flex justify-end gap-2 pt-1">{footer}</div>}
      {closeLabel && (
        <RadixDialog.Close asChild>
          <IconButton
            icon={X}
            label={closeLabel}
            size="sm"
            noTooltip
            className="absolute end-3 top-3"
          />
        </RadixDialog.Close>
      )}
    </RadixDialog.Content>
  );
}
