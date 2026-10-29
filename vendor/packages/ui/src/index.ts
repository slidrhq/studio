// The Slidr design system (SPEC 4.0): the tokens live in `theme.css`; these are the components.
// Every app surface is built from them (PLAN 1.2). See docs/adr/ADR-008-design-system-and-shell.md.
export { cx } from './cx';
export { keyboardInUse, rememberKeyboard, useKeyboardInUse } from './keyboard';
export {
  UiProvider,
  usePortalContainer,
  type Dir,
  type UiProviderProps,
} from './components/provider';
export { Icon, iconSizes, type IconProps, type IconSize, type LucideIcon } from './components/icon';
export { Spinner } from './components/spinner';
export { Kbd, setShownKeys, type KbdProps, type ShownKeys } from './components/kbd';
export {
  Tooltip,
  usePhysicalSide,
  type TooltipProps,
  type TooltipSide,
} from './components/tooltip';
export {
  Button,
  IconButton,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  type IconButtonProps,
} from './components/button';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from './components/segmented';
export { Toggle, type ToggleProps } from './components/toggle';
export { Checkbox, type CheckboxProps } from './components/checkbox';
export { ChoiceList, type Choice, type ChoiceListProps } from './components/choice-list';
export { Switch, type SwitchProps } from './components/switch';
export {
  Tabs,
  TabsContent,
  TabsList,
  TabsSideItem,
  TabsSideList,
  TabsTile,
  TabsTileList,
  TabsTrigger,
} from './components/tabs';
export * from './components/menu';
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  type DialogContentProps,
} from './components/overlay';
export { Field, type FieldProps } from './components/field';
export { Input, TextField, type InputProps, type TextFieldProps } from './components/input';
export { Textarea, type TextareaProps } from './components/textarea';
export { NumberField, type NumberFieldProps } from './components/number-field';
export { Select, type SelectOption, type SelectProps } from './components/select';
export { Slider, type SliderProps } from './components/slider';
export {
  ColorPicker,
  ColorSwatch,
  type ColorChoice,
  type ColorChoiceGroup,
  type ColorPickerLabels,
  type ColorPickerProps,
} from './components/color-picker';
export {
  FontPicker,
  type FontGroup,
  type FontOption,
  type FontPickerLabels,
  type FontPickerProps,
  type FontSample,
  type FontWeights,
} from './components/font-picker';
export { parseHex, toHex, type Rgba } from './color';
export {
  EmptyState,
  ScrollArea,
  Separator,
  Skeleton,
  type EmptyStateProps,
  type ScrollAreaProps,
} from './components/feedback';
