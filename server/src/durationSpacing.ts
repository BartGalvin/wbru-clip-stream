import type { PlayoutPolicy } from './config/playoutPolicy';

export interface DurationSpacingItem {
  durationSec: number;
}

export type DurationCategory = 'short' | 'normal' | 'long';
export interface DurationCounts {
  short: number;
  normal: number;
  long: number;
}

type DurationPolicy = PlayoutPolicy['duration'];

export function getDurationCategory(
  item: DurationSpacingItem,
  policy: DurationPolicy,
): DurationCategory {
  const duration = item.durationSec;
  if (duration > 0 && duration < policy.short.maxExclusiveSec) return 'short';
  if (duration > policy.long.minExclusiveSec) return 'long';
  return 'normal';
}

// Track short and long selections, then prefer the category with the least separator room.
export function createDurationSpacingRule(
  items: DurationSpacingItem[],
  priorLapOrder: number[],
  policy: DurationPolicy,
) {
  const categoryByIndex = items.map((item) => getDurationCategory(item, policy));
  let clipsSinceShort = Number.POSITIVE_INFINITY;
  let clipsSinceLong = Number.POSITIVE_INFINITY;

  function recordSelection(selectedIndex: number): void {
    const category = categoryByIndex[selectedIndex];
    clipsSinceShort = category === 'short' ? 0 : clipsSinceShort + 1;
    clipsSinceLong = category === 'long' ? 0 : clipsSinceLong + 1;
  }

  for (const index of priorLapOrder) recordSelection(index);

  // Prefer non-short clips at the start of later laps when the pool can protect the boundary.
  const reserveLaterLapStartForShortSpacing =
    priorLapOrder.length > 0 &&
    categoryByIndex.includes('normal') &&
    categoryByIndex.filter((category) => category !== 'short').length >= policy.short.clipsBetween;

  return {
    categoryFor(itemIndex: number): DurationCategory {
      return categoryByIndex[itemIndex];
    },

    chooseConstraint(remaining: DurationCounts, positionInLap: number): DurationCategory {
      if (reserveLaterLapStartForShortSpacing && positionInLap === 0 && remaining.normal > 0) {
        return 'normal';
      }

      // Separator capacity is the surplus left after spacing all clips in a category.
      const pressure: {
        category: 'short' | 'long';
        separatorCapacity: number;
        remainingCount: number;
      }[] = [];

      if (
        remaining.short > 0 &&
        clipsSinceShort >= policy.short.clipsBetween &&
        (!reserveLaterLapStartForShortSpacing || positionInLap >= policy.short.clipsBetween)
      ) {
        pressure.push({
          category: 'short',
          separatorCapacity:
            remaining.long + remaining.normal - policy.short.clipsBetween * (remaining.short - 1),
          remainingCount: remaining.short,
        });
      }
      if (remaining.long > 0 && clipsSinceLong >= policy.long.clipsBetween) {
        pressure.push({
          category: 'long',
          separatorCapacity:
            remaining.short + remaining.normal - policy.long.clipsBetween * (remaining.long - 1),
          remainingCount: remaining.long,
        });
      }

      if (pressure.length) {
        // Place the eligible category with the fewest spare separators first.
        pressure.sort(
          (left, right) =>
            left.separatorCapacity - right.separatorCapacity ||
            right.remainingCount - left.remainingCount ||
            (left.category === 'long' ? -1 : 1),
        );
        return pressure[0].category;
      }
      if (remaining.normal > 0) return 'normal';

      return remaining.short >= remaining.long ? 'short' : 'long';
    },

    recordSelection,
  };
}
