import { LoaderCircle } from 'lucide-react';
import { cx } from '../cx';
import { Icon, type IconSize } from './icon';

/** A small busy indicator for controls. Content that is loading shows a Skeleton instead. */
export function Spinner({ size = 'sm', className }: { size?: IconSize; className?: string }) {
  return <Icon icon={LoaderCircle} size={size} className={cx('animate-spin', className)} />;
}
