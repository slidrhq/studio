import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Direction, Popover as RadixPopover } from 'radix-ui';
import { Check, ChevronRight, Search } from 'lucide-react';
import { cx } from '../cx';
import { ScrollArea } from './feedback';
import { Icon } from './icon';
import { Input } from './input';
import { usePortalContainer } from './provider';

export interface FontOption {
  /** The family name, as CSS and the deck use it. */
  family: string;
  /** The face has the letters of the list's sample (`FontPickerProps.sample`). */
  sample?: boolean;
  /** A symbol font: it draws pictures in place of letters, so its name is set in the UI font. */
  symbol?: boolean;
}

/** A part of the list under a heading of its own: a library, the fonts of this computer. */
export interface FontGroup {
  label: string;
  fonts: readonly FontOption[];
}

/** The weights a family has, for its submenu: "Light", "Regular", "Bold". */
export interface FontWeights {
  options: readonly { value: number; label: string }[];
  /** The weight the text is drawn in, when the text is in this family. */
  current: number | null;
}

/** The picker's strings; the design system has no language of its own. */
export interface FontPickerLabels {
  search: string;
  recent: string;
  /** The accessible name of the whole list. */
  all: string;
  /** Shown when the search matches nothing. */
  empty: string;
  /** The accessible name of a font's weights: "Weights of Heebo". */
  weights?: (family: string) => string;
}

/**
 * A phrase in the language of the text the fonts are for, drawn beside the name of each face
 * that has its letters: a localized "Font style" sample for a Hebrew or Arabic deck.
 */
export interface FontSample {
  text: string;
  /** Its language tag. */
  lang: string;
  /** Its accessible name, e.g. "Supports Hebrew". */
  label: string;
}

export interface FontPickerProps {
  /** The fonts, group after group. A heading is shown once the list has more than one part. */
  groups: readonly FontGroup[];
  /** The phrase drawn in the faces marked `sample`; none, and no face shows one. */
  sample?: FontSample;
  /** Families used lately, most recent first. */
  recent?: readonly string[];
  value: string | null;
  onValueChange: (family: string) => void;
  /**
   * The weights of a family. A family of more than one has an arrow, on the font the pointer or
   * the arrow keys are on and on the chosen one, that opens a submenu of them.
   */
  weightsOf?: (family: string) => FontWeights | null;
  /** A weight chosen in a family's submenu: the family and the weight together. */
  onWeightChange?: (family: string, weight: number) => void;
  /** Puts the caret in the search field when the picker appears. On by default. */
  autoFocus?: boolean;
  labels: FontPickerLabels;
  className?: string;
}

/** A line of the list: a heading, or a font and its place among the fonts. */
type Line = { heading: string } | { font: FontOption; key: string; row: number };

const NO_RECENT: readonly string[] = [];

/**
 * Lines drawn above and below the ones in view, so a scroll shows text and not a gap. Kept
 * small: a line that is drawn loads its font, in view or not.
 */
const OVERSCAN = 4;
/** The lines in view until the list is measured. */
const IN_VIEW = 9;

/** Rows leave room to compare the letterforms, including tall display faces. */
function fontRowHeight(): number {
  const token = getComputedStyle(document.documentElement).getPropertyValue('--spacing-font-row');
  return parseFloat(token) || 44;
}

/** The submenu of a font's weights: whose, and which of them the arrow keys are on. */
interface Sub {
  family: string;
  row: number;
  weights: FontWeights;
  active: number;
  /** The line it opens beside. */
  anchor: HTMLElement;
}

/** A family name as a CSS string. */
const quoted = (family: string) => `"${family.replace(/["\\]/g, '\\$&')}"`;

/**
 * The font list (TXT-02): search, the fonts used lately, every name drawn in its own face, and a
 * sample of the text's language in the faces that have its letters. It is the content of a
 * popover or a panel. The search field keeps the focus; Up, Down and Enter work the list from it,
 * and the search looks in every group.
 *
 * Only the lines in view are drawn. A name in its own face costs the loading of that font, and a
 * computer has hundreds of them: drawn all at once, the list took two seconds to appear. Every
 * line, a heading too, has the same height, so the place of a line is its index.
 */
export function FontPicker({
  groups,
  sample,
  recent = NO_RECENT,
  value,
  onValueChange,
  weightsOf,
  onWeightChange,
  autoFocus = true,
  labels,
  className,
}: FontPickerProps) {
  const listId = useId();
  const viewport = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [lineHeight] = useState(fontRowHeight);
  /** The first line in view, and how many lines the list shows. */
  const [view, setView] = useState({ first: 0, count: IN_VIEW });
  const [sub, setSub] = useState<Sub | null>(null);
  const rtl = Direction.useDirection() === 'rtl';
  const portal = usePortalContainer();

  /** A family's weights, when it has more than one to choose from. */
  const choices = (family: string): FontWeights | null => {
    if (!weightsOf || !onWeightChange) return null;
    const weights = weightsOf(family);
    return weights && weights.options.length > 1 ? weights : null;
  };
  /** Opens the weights of the font on a line, beside it. */
  const openSub = (family: string, row: number, anchor: HTMLElement | null) => {
    const weights = choices(family);
    if (!weights || !anchor || (sub?.family === family && sub.row === row)) return;
    // The keys start on the text's weight, or on the one nearest to regular.
    const target = weights.current ?? 400;
    const distance = (i: number) => Math.abs((weights.options[i]?.value ?? 0) - target);
    const active = weights.options.reduce(
      (best, _, i) => (distance(i) < distance(best) ? i : best),
      0,
    );
    setSub({ family, row, weights, anchor, active });
  };
  const chooseWeight = (family: string, weight: number) => {
    setSub(null);
    onWeightChange?.(family, weight);
  };

  const { lines, rows } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byFamily = new Map<string, FontOption>();
    for (const group of groups) {
      for (const font of group.fonts) {
        if (!byFamily.has(font.family)) byFamily.set(font.family, font);
      }
    }
    const used = needle
      ? []
      : recent.map((family) => byFamily.get(family)).filter((f): f is FontOption => Boolean(f));
    const parts = [
      { key: 'recent', label: labels.recent, fonts: used },
      ...groups.map((group, i) => ({
        key: `group${i}`,
        label: group.label,
        fonts: needle
          ? group.fonts.filter((f) => f.family.toLowerCase().includes(needle))
          : group.fonts,
      })),
    ].filter((part) => part.fonts.length > 0);

    const lines: Line[] = [];
    /** The line of each font, in the order the arrows walk them. */
    const rows: number[] = [];
    for (const part of parts) {
      if (parts.length > 1) lines.push({ heading: part.label });
      for (const font of part.fonts) {
        lines.push({ font, key: `${part.key}:${font.family}`, row: rows.length });
        rows.push(lines.length - 1);
      }
    }
    return { lines, rows };
  }, [groups, recent, query, labels.recent]);

  const activeRow = Math.min(active, rows.length - 1);
  const activeAt = rows[activeRow];
  const activeLine = activeAt === undefined ? undefined : lines[activeAt];
  const from = Math.max(0, Math.min(view.first, lines.length - view.count) - OVERSCAN);
  const to = Math.min(lines.length, from + view.count + 2 * OVERSCAN);

  /** Where the list has scrolled to, in lines: the state changes when a line comes or goes. */
  const look = useCallback(
    (element: HTMLDivElement) => {
      const first = Math.floor(element.scrollTop / lineHeight);
      const count = Math.ceil(element.clientHeight / lineHeight) + 1;
      setView((was) => (was.first === first && was.count === count ? was : { first, count }));
    },
    [lineHeight],
  );
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      viewport.current = element;
      if (element) look(element);
    },
    [look],
  );

  /** Scrolls the list just enough for a font to be in view; the first font brings its heading. */
  const reveal = (row: number) => {
    const element = viewport.current;
    const at = rows[row];
    if (!element || at === undefined) return;
    const top = (row === 0 ? 0 : at) * lineHeight;
    const bottom = (at + 1) * lineHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
    look(element);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const inward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const outward = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (sub) {
      // The submenu has the arrows and Enter while it is open; Esc closes it (its own layer).
      const { options } = sub.weights;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setSub({ ...sub, active: Math.max(0, Math.min(options.length - 1, sub.active + step)) });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const option = options[sub.active];
        if (option) chooseWeight(sub.family, option.value);
      } else if (event.key === outward) {
        event.preventDefault();
        setSub(null);
      }
      return;
    }
    // The arrow toward the end of the line opens the weights once the caret is at the end of the
    // search; before that, it moves the caret.
    const { selectionStart, selectionEnd, value: typed } = event.currentTarget;
    const atEnd = selectionStart === typed.length && selectionEnd === typed.length;
    if (event.key === inward && atEnd && activeLine && 'font' in activeLine) {
      const anchor = document.getElementById(`${listId}-${activeLine.row}`);
      if (anchor && choices(activeLine.font.family)) {
        event.preventDefault();
        openSub(activeLine.font.family, activeLine.row, anchor);
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.max(
        0,
        Math.min(rows.length - 1, activeRow + (event.key === 'ArrowDown' ? 1 : -1)),
      );
      setActive(next);
      reveal(next);
    } else if (event.key === 'Enter' && activeLine && 'font' in activeLine) {
      event.preventDefault();
      onValueChange(activeLine.font.family);
    }
  };

  const draw = (line: Line, at: number) => {
    if ('heading' in line) {
      return (
        <li
          key={`heading:${at}`}
          role="presentation"
          className="flex h-font-row items-end px-3 pb-2 text-xs font-medium text-ui-fg-muted"
        >
          {line.heading}
        </li>
      );
    }
    const { family, symbol } = line.font;
    const selected = family === value;
    const opened = sub?.family === family && sub.row === line.row;
    // Only the lines that show the arrow ask for their weights: a list has hundreds of fonts.
    const weights = selected || line.row === activeRow || opened ? choices(family) : null;
    return (
      <li
        key={line.key}
        id={`${listId}-${line.row}`}
        role="option"
        aria-selected={selected}
        // What is drawn is a part of the list: this is the font's place in all of it.
        aria-setsize={rows.length}
        aria-posinset={line.row + 1}
        data-active={line.row === activeRow || undefined}
        // An option takes no aria-expanded: that the weights are open is told by the search, whose
        // active descendant moves into them.
        aria-haspopup={weights ? 'listbox' : undefined}
        onPointerMove={() => {
          setActive(line.row);
          // Another font: the weights of the last one go.
          if (sub && !opened) setSub(null);
        }}
        onClick={() => onValueChange(family)}
        className={cx(
          'relative flex h-font-row cursor-default items-center gap-2 rounded-inset ps-8 select-none',
          weights ? 'pe-1' : 'pe-3',
          selected
            ? 'bg-ui-accent-soft data-active:bg-ui-accent-soft-hover'
            : 'data-active:bg-ui-hover',
        )}
      >
        {selected && (
          <span className="absolute start-2 inline-flex size-4 items-center justify-center text-ui-accent-fg">
            <Icon icon={Check} />
          </span>
        )}
        <span
          dir="auto"
          style={symbol ? undefined : { fontFamily: quoted(family) }}
          className="min-w-0 truncate text-lg ltr:text-left rtl:text-right"
        >
          {family}
        </span>
        {sample && line.font.sample && !symbol && (
          <span
            role="img"
            aria-label={sample.label}
            lang={sample.lang}
            dir="auto"
            style={{ fontFamily: quoted(family) }}
            className="shrink-0 text-lg whitespace-nowrap text-ui-fg-muted"
          >
            {sample.text}
          </span>
        )}
        {weights && (
          // The arrow is the pointer's way to the weights; the keyboard's is the arrow key from
          // the search. It is no button: a control inside an option is not allowed, and is read
          // as a second stop in the line (axe-core's nested-interactive).
          <span
            aria-hidden="true"
            data-font-weights={family}
            // The search keeps the focus.
            onMouseDown={(event) => event.preventDefault()}
            onPointerEnter={(event) => openSub(family, line.row, event.currentTarget.parentElement)}
            onClick={(event) => {
              event.stopPropagation();
              if (opened) setSub(null);
              else openSub(family, line.row, event.currentTarget.parentElement);
            }}
            className={cx(
              'ms-auto inline-flex size-7 shrink-0 cursor-default items-center justify-center rounded-small text-ui-fg-muted transition-colors hover:bg-ui-hover hover:text-ui-fg',
              opened && 'bg-ui-hover text-ui-fg',
            )}
          >
            <Icon icon={ChevronRight} mirror />
          </span>
        )}
      </li>
    );
  };

  const subId = `${listId}-weights`;

  return (
    <div className={cx('flex min-h-0 flex-col gap-2', className)}>
      <Input
        icon={Search}
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded
        aria-controls={listId}
        // Only a font that is drawn can be pointed at: a scroll may leave the active one behind.
        aria-activedescendant={
          sub
            ? `${subId}-${sub.active}`
            : activeAt !== undefined && activeAt >= from && activeAt < to
              ? `${listId}-${activeRow}`
              : undefined
        }
        aria-label={labels.search}
        placeholder={labels.search}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setSub(null);
          // Another list: it starts at its top.
          if (viewport.current) viewport.current.scrollTop = 0;
          setView((was) => (was.first === 0 ? was : { ...was, first: 0 }));
        }}
        onKeyDown={onKeyDown}
      />
      <ScrollArea
        type="always"
        className="-mx-1 h-font-list max-h-font-list-room"
        viewportRef={attach}
        onScroll={(event) => {
          look(event.currentTarget);
          // Its line moves away from it.
          if (sub) setSub(null);
        }}
      >
        <ul
          id={listId}
          role="listbox"
          aria-label={labels.all}
          // The lines that are not drawn keep their room, so the list scrolls at its full length.
          style={{
            paddingBlockStart: from * lineHeight,
            paddingBlockEnd: (lines.length - to) * lineHeight,
          }}
          className="flex flex-col px-1"
        >
          {lines.slice(from, to).map((line, i) => draw(line, from + i))}
          {rows.length === 0 && (
            <li role="presentation" className="px-2 py-6 text-center text-ui-fg-muted">
              {labels.empty}
            </li>
          )}
        </ul>
      </ScrollArea>
      {sub && (
        <RadixPopover.Root open onOpenChange={(open) => !open && setSub(null)}>
          <RadixPopover.Anchor virtualRef={{ current: sub.anchor }} />
          <RadixPopover.Portal container={portal}>
            <RadixPopover.Content
              side={rtl ? 'left' : 'right'}
              align="start"
              sideOffset={6}
              collisionPadding={8}
              // The search keeps the focus, and its keys work the submenu.
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
              // A press on its own line is the arrow's, which opens and closes it.
              onInteractOutside={(event) => {
                if (sub.anchor.contains(event.target as Node)) event.preventDefault();
              }}
              className="z-50 min-w-menu rounded-panel border border-ui-line bg-ui-raised p-1 text-sm text-ui-fg shadow-overlay animate-overlay-in"
            >
              <ul id={subId} role="listbox" aria-label={labels.weights?.(sub.family) ?? sub.family}>
                {sub.weights.options.map((option, i) => {
                  const checked = option.value === sub.weights.current;
                  return (
                    <li
                      key={option.value}
                      id={`${subId}-${i}`}
                      role="option"
                      aria-selected={checked}
                      data-active={i === sub.active || undefined}
                      onPointerMove={() => i !== sub.active && setSub({ ...sub, active: i })}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => chooseWeight(sub.family, option.value)}
                      className="relative flex h-control cursor-default items-center rounded-control ps-8 pe-3 select-none data-active:bg-ui-hover"
                    >
                      {checked && (
                        <span className="absolute start-2 inline-flex size-4 items-center justify-center text-ui-accent-fg">
                          <Icon icon={Check} />
                        </span>
                      )}
                      {/* Each weight drawn in itself, as each font is drawn in its face. */}
                      <span
                        style={{ fontFamily: quoted(sub.family), fontWeight: option.value }}
                        className="truncate"
                      >
                        {option.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </RadixPopover.Content>
          </RadixPopover.Portal>
        </RadixPopover.Root>
      )}
    </div>
  );
}
