import { Select as RadixSelect } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import { cx } from '../cx';
import { Icon, type LucideIcon } from './icon';
import { usePortalContainer } from './provider';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  options: readonly SelectOption<T>[];
  /** The chosen value, or null when there is none to show (a mixed selection). */
  value: T | null;
  onValueChange: (value: T) => void;
  /** Names the control for screen readers. */
  'aria-label': string;
  /** Shown when `value` is null. */
  placeholder?: string;
  /** `field` has the frame of an input; `ghost` sits in a toolbar. */
  variant?: 'field' | 'ghost';
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Where the focus goes when the list closes, e.g. back to the text being edited. */
  onCloseAutoFocus?: (event: Event) => void;
  /** Classes for the trigger, e.g. its width. */
  className?: string;
}

/** One choice out of a list that is too long for a segmented control. */
export function Select<T extends string>({
  options,
  value,
  onValueChange,
  placeholder,
  variant = 'field',
  size = 'md',
  disabled = false,
  onCloseAutoFocus,
  className,
  ...aria
}: SelectProps<T>) {
  const container = usePortalContainer();
  return (
    <RadixSelect.Root
      // Radix keeps the last value when it gets `undefined`; an empty string clears it.
      value={value ?? ''}
      onValueChange={(next) => next && onValueChange(next as T)}
      disabled={disabled}
    >
      <RadixSelect.Trigger
        aria-label={aria['aria-label']}
        className={cx(
          'inline-flex cursor-default items-center justify-between gap-1.5 rounded-control text-sm text-ui-fg transition-colors select-none disabled:text-ui-fg-subtle data-placeholder:text-ui-fg-muted',
          variant === 'field'
            ? 'border border-ui-line-strong bg-ui-field px-2.5 hover:border-ui-fg-subtle disabled:border-ui-line'
            : 'px-2 font-medium hover:bg-ui-hover active:bg-ui-pressed data-[state=open]:bg-ui-hover',
          size === 'md' ? 'h-control' : 'h-control-sm',
          className,
        )}
      >
        <span className="min-w-0 truncate">
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon asChild>
          <Icon icon={ChevronDown} className="-me-0.5 opacity-70" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal container={container}>
        <RadixSelect.Content
          position="popper"
          sideOffset={6}
          collisionPadding={8}
          onCloseAutoFocus={onCloseAutoFocus}
          className="z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) animate-overlay-in overflow-y-auto rounded-panel border border-ui-line bg-ui-raised text-sm text-ui-fg shadow-overlay"
        >
          {/* A long list scrolls in the list itself, not in Radix's viewport inside it: the list
              is the combobox's, and its options are walked by the arrows, while a viewport that
              scrolls is a region the keyboard cannot be on (axe-core's
              scrollable-region-focusable), and made focusable it is no longer a part of the list
              (aria-required-children). */}
          <RadixSelect.Viewport className="p-1 overflow-visible!">
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="group relative flex h-control cursor-default items-center gap-2 rounded-control ps-8 pe-3 outline-none select-none data-disabled:text-ui-fg-subtle data-highlighted:bg-ui-hover"
              >
                <span className="absolute start-2 inline-flex size-4 items-center justify-center text-ui-accent-fg">
                  <RadixSelect.ItemIndicator>
                    <Icon icon={Check} />
                  </RadixSelect.ItemIndicator>
                </span>
                {option.icon && (
                  <Icon
                    icon={option.icon}
                    className="text-ui-fg-muted group-data-disabled:text-ui-fg-subtle"
                  />
                )}
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
