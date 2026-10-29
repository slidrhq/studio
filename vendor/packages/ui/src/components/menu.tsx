import type { ComponentPropsWithRef, ReactNode } from 'react';
import { ContextMenu as RadixContextMenu, DropdownMenu as RadixDropdownMenu } from 'radix-ui';
import { Check, ChevronRight, Dot } from 'lucide-react';
import { cx } from '../cx';
import { Icon, type LucideIcon } from './icon';
import { Kbd } from './kbd';
import { usePortalContainer } from './provider';

/*
 * Menus: a dropdown (from a button) and a context menu (right click) with the same items. The
 * surface is a 12px panel with 4px padding, so the 8px items nest in its corners. A menu is
 * never taller than the room the window has for it: a longer one scrolls, so its last item can
 * be reached with the wheel and with the keyboard.
 */

const surface =
  'z-50 min-w-menu overflow-x-hidden overflow-y-auto rounded-panel border border-ui-line bg-ui-raised p-1 text-sm text-ui-fg shadow-overlay animate-overlay-in';

/** The room the window has for a menu, which Radix measures where the menu opens. */
const dropdownRoom = 'max-h-(--radix-dropdown-menu-content-available-height)';
const contextRoom = 'max-h-(--radix-context-menu-content-available-height)';

const item =
  'group relative flex h-control cursor-default items-center gap-2 rounded-control px-2 outline-none select-none data-highlighted:bg-ui-hover data-disabled:text-ui-fg-subtle';

/** Icons and chevrons in an item: muted, and as faint as the text when it is disabled. */
const itemIcon = 'text-ui-fg-muted group-data-disabled:text-ui-fg-subtle';

/** Room at the start of a checkbox or radio item for its indicator. */
const indented = 'ps-8';

const label = 'px-2 pt-2 pb-1 text-xs font-medium text-ui-fg-muted';
const separator = '-mx-1 my-1 h-px bg-ui-line';

export interface MenuItemProps {
  icon?: LucideIcon;
  shortcut?: string;
  /** Muted text after the label, such as a file path. */
  hint?: ReactNode;
  tone?: 'default' | 'danger';
  children: ReactNode;
}

function ItemBody({ icon, shortcut, hint, children }: Omit<MenuItemProps, 'tone'>) {
  return (
    <>
      {icon && <Icon icon={icon} className={itemIcon} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="max-w-48 truncate text-xs text-ui-fg-muted">{hint}</span>}
      {shortcut && <Kbd keys={shortcut} className="ms-4" />}
    </>
  );
}

function Indicator({ children }: { children: ReactNode }) {
  return (
    <span className="absolute start-2 inline-flex size-4 items-center justify-center text-ui-accent-fg">
      {children}
    </span>
  );
}

function toneClass(tone: MenuItemProps['tone']) {
  return tone === 'danger' ? 'text-ui-danger-fg data-highlighted:bg-ui-danger-soft' : undefined;
}

/* ---------------------------------------------------------------- dropdown menu */

export const DropdownMenu = RadixDropdownMenu.Root;
export const DropdownMenuTrigger = RadixDropdownMenu.Trigger;
export const DropdownMenuGroup = RadixDropdownMenu.Group;
export const DropdownMenuRadioGroup = RadixDropdownMenu.RadioGroup;
export const DropdownMenuSub = RadixDropdownMenu.Sub;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'start',
  ...props
}: ComponentPropsWithRef<typeof RadixDropdownMenu.Content>) {
  return (
    <RadixDropdownMenu.Portal container={usePortalContainer()}>
      <RadixDropdownMenu.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cx(surface, dropdownRoom, className)}
        {...props}
      />
    </RadixDropdownMenu.Portal>
  );
}

export function DropdownMenuItem({
  icon,
  shortcut,
  hint,
  tone,
  children,
  className,
  ...props
}: MenuItemProps & Omit<ComponentPropsWithRef<typeof RadixDropdownMenu.Item>, 'children'>) {
  return (
    <RadixDropdownMenu.Item className={cx(item, toneClass(tone), className)} {...props}>
      <ItemBody icon={icon} shortcut={shortcut} hint={hint}>
        {children}
      </ItemBody>
    </RadixDropdownMenu.Item>
  );
}

export function DropdownMenuCheckboxItem({
  shortcut,
  children,
  className,
  ...props
}: Omit<MenuItemProps, 'icon' | 'tone' | 'hint'> &
  Omit<ComponentPropsWithRef<typeof RadixDropdownMenu.CheckboxItem>, 'children'>) {
  return (
    <RadixDropdownMenu.CheckboxItem className={cx(item, indented, className)} {...props}>
      <Indicator>
        <RadixDropdownMenu.ItemIndicator>
          <Icon icon={Check} />
        </RadixDropdownMenu.ItemIndicator>
      </Indicator>
      <ItemBody shortcut={shortcut}>{children}</ItemBody>
    </RadixDropdownMenu.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  shortcut,
  children,
  className,
  ...props
}: Omit<MenuItemProps, 'icon' | 'tone' | 'hint'> &
  Omit<ComponentPropsWithRef<typeof RadixDropdownMenu.RadioItem>, 'children'>) {
  return (
    <RadixDropdownMenu.RadioItem className={cx(item, indented, className)} {...props}>
      <Indicator>
        <RadixDropdownMenu.ItemIndicator>
          <Icon icon={Dot} className="scale-200" />
        </RadixDropdownMenu.ItemIndicator>
      </Indicator>
      <ItemBody shortcut={shortcut}>{children}</ItemBody>
    </RadixDropdownMenu.RadioItem>
  );
}

/** A compact radio choice whose icon is its visible label. */
export function DropdownMenuRadioIconItem({
  icon,
  label,
  className,
  ...props
}: { icon: LucideIcon; label: string } & Omit<
  ComponentPropsWithRef<typeof RadixDropdownMenu.RadioItem>,
  'children' | 'aria-label'
>) {
  return (
    <RadixDropdownMenu.RadioItem
      aria-label={label}
      className={cx(
        'flex size-control-sm cursor-default items-center justify-center rounded-control text-ui-fg-muted outline-none select-none',
        'data-highlighted:bg-ui-hover data-highlighted:text-ui-fg data-[state=checked]:bg-ui-accent-soft data-[state=checked]:text-ui-accent-fg',
        className,
      )}
      {...props}
    >
      <Icon icon={icon} />
    </RadixDropdownMenu.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixDropdownMenu.Label>) {
  return <RadixDropdownMenu.Label className={cx(label, className)} {...props} />;
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixDropdownMenu.Separator>) {
  return <RadixDropdownMenu.Separator className={cx(separator, className)} {...props} />;
}

export function DropdownMenuSubTrigger({
  icon,
  children,
  className,
  ...props
}: Pick<MenuItemProps, 'icon' | 'children'> &
  Omit<ComponentPropsWithRef<typeof RadixDropdownMenu.SubTrigger>, 'children'>) {
  return (
    <RadixDropdownMenu.SubTrigger
      className={cx(item, 'data-[state=open]:bg-ui-hover', className)}
      {...props}
    >
      <ItemBody icon={icon}>{children}</ItemBody>
      <Icon icon={ChevronRight} mirror className={itemIcon} />
    </RadixDropdownMenu.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixDropdownMenu.SubContent>) {
  return (
    <RadixDropdownMenu.Portal container={usePortalContainer()}>
      <RadixDropdownMenu.SubContent
        sideOffset={8}
        alignOffset={-5}
        collisionPadding={8}
        className={cx(surface, dropdownRoom, className)}
        {...props}
      />
    </RadixDropdownMenu.Portal>
  );
}

/* ---------------------------------------------------------------- context menu */

export const ContextMenu = RadixContextMenu.Root;
export const ContextMenuTrigger = RadixContextMenu.Trigger;
export const ContextMenuGroup = RadixContextMenu.Group;
export const ContextMenuSub = RadixContextMenu.Sub;

export function ContextMenuContent({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixContextMenu.Content>) {
  return (
    <RadixContextMenu.Portal container={usePortalContainer()}>
      <RadixContextMenu.Content
        collisionPadding={8}
        className={cx(surface, contextRoom, className)}
        {...props}
      />
    </RadixContextMenu.Portal>
  );
}

export function ContextMenuItem({
  icon,
  shortcut,
  hint,
  tone,
  children,
  className,
  ...props
}: MenuItemProps & Omit<ComponentPropsWithRef<typeof RadixContextMenu.Item>, 'children'>) {
  return (
    <RadixContextMenu.Item className={cx(item, toneClass(tone), className)} {...props}>
      <ItemBody icon={icon} shortcut={shortcut} hint={hint}>
        {children}
      </ItemBody>
    </RadixContextMenu.Item>
  );
}

export function ContextMenuCheckboxItem({
  shortcut,
  children,
  className,
  ...props
}: Omit<MenuItemProps, 'icon' | 'tone' | 'hint'> &
  Omit<ComponentPropsWithRef<typeof RadixContextMenu.CheckboxItem>, 'children'>) {
  return (
    <RadixContextMenu.CheckboxItem className={cx(item, indented, className)} {...props}>
      <Indicator>
        <RadixContextMenu.ItemIndicator>
          <Icon icon={Check} />
        </RadixContextMenu.ItemIndicator>
      </Indicator>
      <ItemBody shortcut={shortcut}>{children}</ItemBody>
    </RadixContextMenu.CheckboxItem>
  );
}

export function ContextMenuLabel({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixContextMenu.Label>) {
  return <RadixContextMenu.Label className={cx(label, className)} {...props} />;
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixContextMenu.Separator>) {
  return <RadixContextMenu.Separator className={cx(separator, className)} {...props} />;
}

export function ContextMenuSubTrigger({
  icon,
  children,
  className,
  ...props
}: Pick<MenuItemProps, 'icon' | 'children'> &
  Omit<ComponentPropsWithRef<typeof RadixContextMenu.SubTrigger>, 'children'>) {
  return (
    <RadixContextMenu.SubTrigger
      className={cx(item, 'data-[state=open]:bg-ui-hover', className)}
      {...props}
    >
      <ItemBody icon={icon}>{children}</ItemBody>
      <Icon icon={ChevronRight} mirror className={itemIcon} />
    </RadixContextMenu.SubTrigger>
  );
}

export function ContextMenuSubContent({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixContextMenu.SubContent>) {
  return (
    <RadixContextMenu.Portal container={usePortalContainer()}>
      <RadixContextMenu.SubContent
        sideOffset={8}
        alignOffset={-5}
        collisionPadding={8}
        className={cx(surface, contextRoom, className)}
        {...props}
      />
    </RadixContextMenu.Portal>
  );
}
