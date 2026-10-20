import { slideArchetype } from '@slidr/model';
import type { Rule } from '../rule';

/** This many slides of one kind in a row are too many (SPEC 9.1: no more than two). */
export const MAX_RUN = 3;

/**
 * L14: the slide is the third in a row, or later, of the same archetype. A rule about the
 * deck, reported on the slide where the run becomes too long: that is the one to change.
 * Hidden slides are not shown, so they neither break a run nor belong to one.
 */
export const L14: Rule = {
  id: 'L14',
  severity: 'info',
  agent: false,
  check({ deck, slide }) {
    const archetype = slideArchetype(deck, slide);
    if (!archetype || archetype === 'blank' || slide.hidden) return [];
    const shown = deck.slides.filter((s) => !s.hidden);
    const at = shown.findIndex((s) => s.id === slide.id);
    let run = 1;
    while (at - run >= 0 && slideArchetype(deck, shown[at - run]!) === archetype) run++;
    if (run < MAX_RUN) return [];
    return [
      {
        elementIds: [],
        message: `This is the ${run === 3 ? 'third' : `${run}th`} slide in a row of the "${archetype}" archetype. A deck holds attention when no more than two slides in a row look alike: give this one another composition.`,
      },
    ];
  },
};
