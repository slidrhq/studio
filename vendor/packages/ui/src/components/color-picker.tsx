import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Hash, Pipette } from 'lucide-react';
import {
  alphaTrack,
  areaBackground,
  hsvToRgb,
  HUE_TRACK,
  NONE_SWATCH,
  parseHex,
  rgbToHsv,
  sameRgba,
  swatchBackground,
  toHex,
  type Hsv,
} from '../color';
import { cx } from '../cx';
import { IconButton } from './button';
import { Input } from './input';
import { NumberField } from './number-field';
import { Slider } from './slider';
import { Tooltip } from './tooltip';

/** A named colour offered above the free picker, e.g. a colour of the deck's theme. */
export interface ColorChoice {
  id: string;
  label: string;
  /** Any CSS colour; it only paints the swatch. */
  color: string;
}

export interface ColorChoiceGroup {
  label: string;
  choices: readonly ColorChoice[];
}

/** The picker's strings; the design system has no language of its own. */
export interface ColorPickerLabels {
  /** The saturation and brightness square. */
  area: string;
  hue: string;
  alpha: string;
  hex: string;
  eyedropper: string;
  none: string;
  recent: string;
}

export interface ColorPickerProps {
  /** The colour as `#rrggbb` or `#rrggbbaa`; null for no colour. */
  value: string | null;
  /** The choice the colour follows, when it is one of `groups`. */
  choiceId?: string | null;
  /** Every change: each step of a drag, each valid hex typed. */
  onChange: (hex: string) => void;
  /** A drag or an edit ended: the place to close an undo step. */
  onGestureEnd?: () => void;
  onChoice?: (id: string) => void;
  groups?: readonly ColorChoiceGroup[];
  /** Colours used lately, as hex. */
  recent?: readonly string[];
  /** Offers the alpha slider. */
  alpha?: boolean;
  /** Offers "no colour". */
  onNone?: () => void;
  labels: ColorPickerLabels;
  className?: string;
}

interface Picked extends Hsv {
  a: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function pickedFrom(hex: string | null, hue = 0): Picked {
  const rgb = (hex ? parseHex(hex) : undefined) ?? { r: 0, g: 0, b: 0, a: 1 };
  return { ...rgbToHsv(rgb, hue), a: rgb.a };
}

interface EyeDropperLike {
  open: () => Promise<{ sRGBHex: string }>;
}

/** The browser's screen colour sampler; Chromium and WebView2 have it. */
function eyeDropper(): EyeDropperLike | undefined {
  const Ctor = (globalThis as { EyeDropper?: new () => EyeDropperLike }).EyeDropper;
  return Ctor ? new Ctor() : undefined;
}

/** A swatch of a colour, or of "no colour". For triggers; it is not a control itself. */
export function ColorSwatch({ color, className }: { color: string | null; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ background: color === null ? NONE_SWATCH : swatchBackground(color) }}
      className={cx('block shrink-0 rounded-small border border-ui-line-strong', className)}
    />
  );
}

function Chip({
  color,
  label,
  selected,
  onClick,
}: {
  color: string | null;
  label: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected}
        onClick={onClick}
        style={{ background: color === null ? NONE_SWATCH : swatchBackground(color) }}
        className={cx(
          'size-6 shrink-0 cursor-default rounded-inset border border-ui-line-strong transition-colors hover:border-ui-fg-subtle',
          selected && 'outline-2 outline-offset-1 outline-ui-accent',
        )}
      />
    </Tooltip>
  );
}

/**
 * The colour picker (TXT-04, SHP-02): named choices, recent colours, and any colour through the
 * square, the hue strip, hex and the eyedropper. It is the content of a popover or a panel, not a
 * popover itself. The square and the strips are physical, so they do not mirror with the UI.
 */
export function ColorPicker({
  value,
  choiceId,
  onChange,
  onGestureEnd,
  onChoice,
  groups = [],
  recent = [],
  alpha = false,
  onNone,
  labels,
  className,
}: ColorPickerProps) {
  const [picked, setPicked] = useState(() => pickedFrom(value));
  const [seen, setSeen] = useState(value);
  const [draft, setDraft] = useState<string | null>(null);
  const area = useRef<HTMLDivElement>(null);

  const rgb = hsvToRgb(picked, alpha ? picked.a : 1);
  if (value !== seen) {
    setSeen(value);
    // A value that is not this picker's own last output came from outside: follow it. The hue is
    // kept, so a grey does not send the square to red.
    const outside = value ? parseHex(value) : undefined;
    if (outside && !sameRgba(outside, rgb)) setPicked(pickedFrom(value, picked.h));
  }

  const update = (next: Picked) => {
    setPicked(next);
    onChange(toHex(hsvToRgb(next, alpha ? next.a : 1)));
  };

  const pickAt = (event: PointerEvent) => {
    const rect = area.current?.getBoundingClientRect();
    if (!rect) return;
    update({
      ...picked,
      s: clamp01((event.clientX - rect.left) / rect.width),
      v: 1 - clamp01((event.clientY - rect.top) / rect.height),
    });
  };

  const onAreaKey = (event: KeyboardEvent) => {
    const by = event.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, Partial<Picked>> = {
      ArrowLeft: { s: clamp01(picked.s - by) },
      ArrowRight: { s: clamp01(picked.s + by) },
      ArrowUp: { v: clamp01(picked.v + by) },
      ArrowDown: { v: clamp01(picked.v - by) },
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    update({ ...picked, ...move });
  };

  const sample = () => {
    void eyeDropper()
      ?.open()
      .then(({ sRGBHex }) => {
        update({ ...pickedFrom(sRGBHex, picked.h), a: picked.a });
        onGestureEnd?.();
      })
      // Esc while sampling rejects; nothing was picked.
      .catch(() => undefined);
  };

  const hex = toHex(rgb, false).slice(1).toUpperCase();
  const selectedChoice = value === null ? null : choiceId;

  return (
    <div className={cx('flex flex-col gap-3', className)}>
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ui-fg-muted">{group.label}</span>
          <div className="flex flex-wrap gap-1.5">
            {group.choices.map((choice) => (
              <Chip
                key={choice.id}
                color={choice.color}
                label={choice.label}
                selected={choice.id === selectedChoice}
                onClick={() => {
                  onChoice?.(choice.id);
                  onGestureEnd?.();
                }}
              />
            ))}
          </div>
        </div>
      ))}
      {(recent.length > 0 || onNone) && (
        <div className="flex flex-col gap-1.5">
          {recent.length > 0 && (
            <span className="text-xs font-medium text-ui-fg-muted">{labels.recent}</span>
          )}
          <div className="flex flex-wrap gap-1.5">
            {onNone && (
              <Chip color={null} label={labels.none} selected={value === null} onClick={onNone} />
            )}
            {recent.map((color) => (
              <Chip
                key={color}
                color={color}
                label={color.toUpperCase()}
                onClick={() => {
                  update(pickedFrom(color, picked.h));
                  onGestureEnd?.();
                }}
              />
            ))}
          </div>
        </div>
      )}
      <div
        ref={area}
        dir="ltr"
        tabIndex={0}
        role="group"
        aria-label={labels.area}
        data-testid="color-area"
        style={{ background: areaBackground(picked.h) }}
        className="relative h-36 cursor-crosshair touch-none rounded-control border border-ui-line focus-visible:outline-offset-1"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pickAt(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) pickAt(event);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          onGestureEnd?.();
        }}
        onKeyDown={onAreaKey}
        onKeyUp={(event) => event.key.startsWith('Arrow') && onGestureEnd?.()}
      >
        <span
          style={{
            insetInlineStart: `${picked.s * 100}%`,
            top: `${(1 - picked.v) * 100}%`,
            background: toHex(rgb, false),
          }}
          className="pointer-events-none absolute size-3.5 -translate-1/2 rounded-full border-2 border-ui-on-accent shadow-raised"
        />
      </div>
      <Slider
        aria-label={labels.hue}
        dir="ltr"
        min={0}
        max={360}
        value={picked.h}
        onValueChange={(h) => update({ ...picked, h })}
        onValueCommit={() => onGestureEnd?.()}
        trackStyle={{ background: HUE_TRACK }}
      />
      {alpha && (
        <Slider
          aria-label={labels.alpha}
          dir="ltr"
          min={0}
          max={1}
          step={0.01}
          value={picked.a}
          onValueChange={(a) => update({ ...picked, a })}
          onValueCommit={() => onGestureEnd?.()}
          trackStyle={{ background: alphaTrack(rgb) }}
        />
      )}
      <div className="flex items-center gap-2">
        {eyeDropper() && (
          <IconButton
            icon={Pipette}
            label={labels.eyedropper}
            variant="secondary"
            onClick={sample}
          />
        )}
        <Input
          icon={Hash}
          dir="ltr"
          aria-label={labels.hex}
          spellCheck={false}
          maxLength={9}
          className="min-w-0 flex-1"
          value={draft ?? hex}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            const typed = parseHex(text);
            // Three digits are a colour too, but also the start of six: wait for the whole thing.
            if (typed && text.replace(/^#/, '').length >= 6) {
              update({ ...pickedFrom(text, picked.h), a: alpha ? typed.a : picked.a });
            }
          }}
          onBlur={() => {
            if (draft === null) return;
            const typed = parseHex(draft);
            if (typed) update({ ...pickedFrom(draft, picked.h), a: alpha ? typed.a : picked.a });
            setDraft(null);
            onGestureEnd?.();
          }}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        />
        {alpha && (
          <NumberField
            aria-label={labels.alpha}
            className="w-16 shrink-0"
            unit="%"
            min={0}
            max={100}
            value={Math.round(picked.a * 100)}
            onValueChange={(percent) => {
              update({ ...picked, a: percent / 100 });
              onGestureEnd?.();
            }}
          />
        )}
      </div>
    </div>
  );
}
