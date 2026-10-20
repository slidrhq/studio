// Design lint: model + render measurements -> findings (SPEC 9.2). Pure, no DOM.
export { lintSlide, type RuleSet } from './lint';
export { rules } from './rules';
export type { Item, LintFinding, Problem, Rule, Severity, SlideContext } from './rule';
export type {
  ElementMeasure,
  Rgb,
  SlideMeasurements,
  TextMeasure,
  TextSpanMeasure,
} from './measure';
