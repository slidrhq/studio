import type { ComponentPropsWithRef } from 'react';
import { Tabs as RadixTabs } from 'radix-ui';
import { cx } from '../cx';
import { Icon, type LucideIcon } from './icon';

export const Tabs = RadixTabs.Root;

export function TabsList({ className, ...props }: ComponentPropsWithRef<typeof RadixTabs.List>) {
  return (
    <RadixTabs.List
      className={cx('flex items-stretch gap-4 border-b border-ui-line', className)}
      {...props}
    />
  );
}

/** A tab: muted text, the active one in full colour over an accent underline. */
export function TabsTrigger({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={cx(
        'relative -mx-1 -mb-px inline-flex h-9 cursor-default items-center gap-1.5 rounded-t-small border-b-2 border-transparent px-1 text-sm font-medium text-ui-fg-muted transition-colors select-none',
        'hover:text-ui-fg focus-visible:-outline-offset-2 disabled:text-ui-fg-subtle',
        'data-[state=active]:border-ui-accent data-[state=active]:text-ui-fg',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Tabs drawn as tiles, the way the Activity Bar draws its panels: an icon over a short label, the
 * active tile in the accent's soft tint. For a handful of topics in a narrow column, where a row
 * of words would not fit. The tiles share the row's width.
 */
export function TabsTileList({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixTabs.List>) {
  return <RadixTabs.List className={cx('flex items-stretch gap-0.5', className)} {...props} />;
}

export function TabsTile({
  icon,
  label,
  className,
  ...props
}: Omit<ComponentPropsWithRef<typeof RadixTabs.Trigger>, 'children'> & {
  icon: LucideIcon;
  /** The tile's words, and its accessible name. */
  label: string;
}) {
  return (
    <RadixTabs.Trigger
      className={cx(
        'inline-flex min-w-0 flex-1 cursor-default flex-col items-center justify-center gap-1 rounded-control px-0.5 py-2 text-ui-fg-muted transition-colors select-none',
        'hover:bg-ui-hover hover:text-ui-fg active:bg-ui-pressed focus-visible:outline-offset-0 disabled:text-ui-fg-subtle',
        'data-[state=active]:bg-ui-accent-soft data-[state=active]:text-ui-accent-fg',
        className,
      )}
      {...props}
    >
      <Icon icon={icon} size="md" />
      <span className="w-full truncate text-center text-xs font-medium">{label}</span>
    </RadixTabs.Trigger>
  );
}

/**
 * Tabs listed down the side of a dialog, as a window of properties lists its pages: each an
 * icon beside its name, the active one in the accent's soft tint. For more topics than a row of
 * tiles holds, or names too long for a tile.
 */
export function TabsSideList({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixTabs.List>) {
  return <RadixTabs.List className={cx('flex flex-col gap-0.5', className)} {...props} />;
}

export function TabsSideItem({
  icon,
  label,
  iconClassName,
  className,
  ...props
}: Omit<ComponentPropsWithRef<typeof RadixTabs.Trigger>, 'children'> & {
  icon: LucideIcon;
  /** The item's words, and its accessible name. */
  label: string;
  /** The colours of the icon's mark, e.g. a tool's tint. Without it the icon stands alone. */
  iconClassName?: string;
}) {
  return (
    <RadixTabs.Trigger
      className={cx(
        'flex h-control w-full min-w-0 cursor-default items-center gap-2.5 rounded-control px-1.5 text-start text-sm text-ui-fg-muted transition-colors select-none',
        'hover:bg-ui-hover hover:text-ui-fg active:bg-ui-pressed focus-visible:outline-offset-0 disabled:text-ui-fg-subtle',
        'data-[state=active]:bg-ui-accent-soft data-[state=active]:font-medium data-[state=active]:text-ui-fg',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cx(
          'flex size-6 shrink-0 items-center justify-center rounded-inset',
          iconClassName,
        )}
      >
        <Icon icon={icon} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </RadixTabs.Trigger>
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixTabs.Content>) {
  // The panel of a tab is a stop of Tab, so it shows when it has the keyboard, inside its edge.
  return (
    <RadixTabs.Content
      className={cx(
        'focus-visible:-outline-offset-2 data-[state=active]:animate-panel-in',
        className,
      )}
      {...props}
    />
  );
}
