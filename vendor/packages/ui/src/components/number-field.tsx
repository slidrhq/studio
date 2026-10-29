import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Direction } from 'radix-ui';
import { cx } from '../cx';
import { Icon, type LucideIcon } from './icon';

export interface NumberFieldProps {
  /** The number, or null when there is none to show (a mixed selection). */
  value: number | null;
  /** A committed value: Enter, leaving the field, or an arrow key. Already clamped and rounded. */
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  /** What an arrow key adds; Shift multiplies it by ten. */
  step?: number;
  /** Decimal places kept. */
  precision?: number;
  /**
   * Shown after the number: `px`, `%`, `°`. A unit in a right-to-left script (a Hebrew
   * abbreviation) comes after the number in its own direction, that is, on its left.
   */
  unit?: string;
  icon?: LucideIcon;
  /** Shown when `value` is null. */
  placeholder?: string;
  /** Names the field for screen readers. */
  'aria-label': string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Something at the end of the field, e.g. a menu of presets. */
  end?: ReactNode;
  /** Classes for the frame, e.g. its width. */
  className?: string;
  /** For tests: put on the input, which is what a test types into and reads. */
  'data-testid'?: string;
}

function format(value: number | null, precision: number): string {
  if (value === null) return '';
  return String(Number(value.toFixed(precision)));
}

/** A letter of a script that is written right to left. */
const RTL_LETTER = /[\p{Script=Hebrew}\p{Script=Arabic}]/u;

/**
 * A field for one number. Typing is free; the value is committed on Enter or when the field is
 * left, and text that is not a number puts the old value back. Up and Down step it. The number
 * reads left to right in every UI language; its unit sits on the side its own script puts it.
 */
export function NumberField({
  value,
  onValueChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  precision = 0,
  unit,
  icon,
  placeholder,
  size = 'md',
  disabled = false,
  end,
  className,
  'data-testid': testId,
  ...aria
}: NumberFieldProps) {
  const rtl = Direction.useDirection() === 'rtl';
  const shown = format(value, precision);
  // What is being typed; null while the field shows the value.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (next: number) => {
    const clamped = Math.min(max, Math.max(min, next));
    const rounded = Number(clamped.toFixed(precision));
    setDraft(null);
    if (rounded !== value) onValueChange(rounded);
  };

  const commitDraft = () => {
    if (draft === null) return;
    const parsed = Number(draft.replace(',', '.'));
    if (draft.trim() === '' || !Number.isFinite(parsed)) setDraft(null);
    else commit(parsed);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      commitDraft();
      event.currentTarget.select();
    } else if (event.key === 'Escape') {
      if (draft === null) return;
      // The first Esc drops the typing; the next one is the surrounding popover's.
      event.stopPropagation();
      setDraft(null);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const typed = draft === null ? NaN : Number(draft.replace(',', '.'));
      const from = Number.isFinite(typed) ? typed : (value ?? 0);
      const by = step * (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
      commit(from + by);
    }
  };

  return (
    <div
      className={cx(
        'flex items-center gap-1.5 rounded-control border border-ui-line-strong bg-ui-field px-2 text-sm text-ui-fg transition-colors hover:border-ui-fg-subtle',
        'focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ui-focus',
        // Faded when the field itself is disabled, and not when a control beside it in the frame is.
        'has-[>span>input:disabled]:border-ui-line has-[>span>input:disabled]:text-ui-fg-subtle',
        size === 'md' ? 'h-control' : 'h-control-sm',
        className,
      )}
    >
      {icon && <Icon icon={icon} className="text-ui-fg-muted" />}
      {/* The number and a Latin unit read as in Latin text, "12 px", and in an RTL UI they sit at
          the start. A Hebrew unit reads as in Hebrew text: the number, then the unit on its left. */}
      <span
        dir={unit && RTL_LETTER.test(unit) ? 'rtl' : 'ltr'}
        className="flex h-full min-w-0 flex-1 items-center gap-1"
      >
        <input
          type="text"
          inputMode="decimal"
          dir="ltr"
          aria-label={aria['aria-label']}
          data-testid={testId}
          value={draft ?? shown}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={commitDraft}
          onKeyDown={onKeyDown}
          className={cx(
            'h-full w-full min-w-0 flex-1 bg-transparent tabular-nums outline-none placeholder:text-ui-fg-muted focus-visible:outline-none',
            rtl ? 'text-end' : 'text-start',
          )}
        />
        {unit && <span className="text-xs text-ui-fg-muted">{unit}</span>}
      </span>
      {end}
    </div>
  );
}
