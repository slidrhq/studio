import type { LucideIcon } from 'lucide-react';
import { cx } from '../cx';

export type { LucideIcon };

/** Compact controls, standard icons, and prominent creation/navigation tools. */
export const iconSizes = { sm: 16, md: 18, lg: 24 } as const;
export type IconSize = keyof typeof iconSizes;

export interface IconProps {
  icon: LucideIcon;
  size?: IconSize;
  /** Flips the icon in right-to-left layouts: arrows, chevrons, undo and redo. */
  mirror?: boolean;
  className?: string;
}

/** A Lucide icon at a design-system size and stroke (DSN-04). Decorative: label the control. */
export function Icon({ icon: Glyph, size = 'sm', mirror, className }: IconProps) {
  return (
    <Glyph
      aria-hidden
      size={iconSizes[size]}
      strokeWidth={1.75}
      className={cx('shrink-0', mirror && 'rtl:-scale-x-100', className)}
    />
  );
}
