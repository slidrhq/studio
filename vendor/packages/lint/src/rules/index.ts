import type { Rule } from '../rule';
import { L09 } from './alignment';
import { L08 } from './balance';
import { L02, L03 } from './bounds';
import { L03_CHART, L04_CHART, L05_CHART } from './chart';
import { L05 } from './contrast';
import { L07 } from './coverage';
import { L15 } from './direction';
import { L17 } from './emptyBand';
import { L04 } from './fontSize';
import { L18 } from './hollowCard';
import { L12 } from './imageScale';
import { L16 } from './noVisual';
import { L11 } from './offTheme';
import { L06 } from './overlap';
import { L01 } from './overflow';
import { L10 } from './spacing';
import { L13 } from './textLoad';
import { L14 } from './variety';

/**
 * Every rule, in the order findings are reported. A new rule is one more entry here; `agent`
 * on the rule decides whether it is also in the set returned after every write.
 *
 * The agent's set is L01 to L07, L13, L16 and L18. L08 to L12, L14, L15 and L17, and what L03
 * to L05 see inside a chart, are for the user's design check alone (WG7-T07): each finding
 * that goes back to the agent costs tokens and rounds of the quality gate, and whether any of
 * these is worth that is the user's decision. L18 goes back because stretching cards was how
 * the agent met L07 (ADR-099).
 */
export const rules: readonly Rule[] = [
  L01,
  L02,
  L03,
  L03_CHART,
  L04,
  L04_CHART,
  L05,
  L05_CHART,
  L06,
  L07,
  L08,
  L09,
  L10,
  L11,
  L12,
  L13,
  L14,
  L15,
  L16,
  L17,
  L18,
];
