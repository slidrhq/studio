import type { ComponentPropsWithRef, ReactNode, Ref, UIEventHandler } from 'react';
import { ScrollArea as RadixScrollArea, Separator as RadixSeparator } from 'radix-ui';
import { cx } from '../cx';
import { Icon, type LucideIcon } from './icon';

/* ---------------------------------------------------------------- separator */

/** A hairline. Prefer space between groups; use a line only between regions. */
export function Separator({
  className,
  orientation = 'horizontal',
  ...props
}: ComponentPropsWithRef<typeof RadixSeparator.Root>) {
  return (
    <RadixSeparator.Root
      orientation={orientation}
      className={cx(
        'shrink-0 bg-ui-line',
        orientation === 'horizontal' ? 'h-px w-full' : 'w-px self-stretch',
        className,
      )}
      {...props}
    />
  );
}

/* ---------------------------------------------------------------- skeleton */

/** A placeholder in the shape of content that is on its way. Used instead of spinners. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('skeleton rounded-small', className)} />;
}

/* ---------------------------------------------------------------- empty state */

export interface EmptyStateProps {
  icon: LucideIcon;
  title: ReactNode;
  /** What to do next (DSN-05). */
  description?: ReactNode;
  /** A button that does it. */
  action?: ReactNode;
  tone?: 'default' | 'error';
  className?: string;
}

/** What a region shows when it has nothing to show, or failed to load. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = 'default',
  className,
}: EmptyStateProps) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={cx(
        'flex flex-col items-center justify-center gap-3 px-6 py-10 text-center',
        className,
      )}
    >
      <span
        className={cx(
          'inline-flex size-10 items-center justify-center rounded-panel',
          tone === 'error' ? 'bg-ui-danger-soft text-ui-danger-fg' : 'bg-ui-field text-ui-fg-muted',
        )}
      >
        <Icon icon={icon} size="md" />
      </span>
      <div className="flex max-w-64 flex-col gap-1">
        <p className="text-md font-medium text-ui-fg">{title}</p>
        {description && <p className="text-sm text-ui-fg-muted">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- scroll area */

export interface ScrollAreaProps {
  children: ReactNode;
  orientation?: 'vertical' | 'horizontal' | 'both';
  /** When the scrollbars show: on hover (the default) or always. */
  type?: 'hover' | 'always';
  className?: string;
  /** Classes for the scrolling element, e.g. padding. */
  viewportClassName?: string;
  /** The scrolling element and its scroll, for a list that draws only the part in view. */
  viewportRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  /**
   * The name of the region, for content with nothing in it that takes the focus (pictures): the
   * scrolling element then takes it, so the keyboard scrolls it too.
   */
  label?: string;
}

function Scrollbar({ orientation }: { orientation: 'vertical' | 'horizontal' }) {
  return (
    <RadixScrollArea.Scrollbar
      orientation={orientation}
      className={cx(
        'z-10 flex touch-none p-0.5 select-none',
        orientation === 'vertical' ? 'w-2.5' : 'h-2.5 flex-col',
      )}
    >
      <RadixScrollArea.Thumb className="relative flex-1 rounded-full bg-ui-line-strong transition-colors hover:bg-ui-fg-subtle" />
    </RadixScrollArea.Scrollbar>
  );
}

/** A scrolling region with the app's thin overlay scrollbar instead of the OS one. */
export function ScrollArea({
  children,
  orientation = 'vertical',
  type = 'hover',
  className,
  viewportClassName,
  viewportRef,
  onScroll,
  label,
}: ScrollAreaProps) {
  return (
    <RadixScrollArea.Root type={type} className={cx('relative overflow-hidden', className)}>
      <RadixScrollArea.Viewport
        ref={viewportRef}
        onScroll={onScroll}
        role={label ? 'region' : undefined}
        aria-label={label}
        tabIndex={label ? 0 : undefined}
        // Radix lays the content out as a table, which defeats `truncate` in vertical lists. The
        // ring of a focused region is drawn inside it, which clips what is outside.
        className={cx(
          'size-full',
          orientation === 'vertical' && '*:block!',
          label && '-outline-offset-2',
          viewportClassName,
        )}
      >
        {children}
      </RadixScrollArea.Viewport>
      {orientation !== 'horizontal' && <Scrollbar orientation="vertical" />}
      {orientation !== 'vertical' && <Scrollbar orientation="horizontal" />}
      <RadixScrollArea.Corner />
    </RadixScrollArea.Root>
  );
}
