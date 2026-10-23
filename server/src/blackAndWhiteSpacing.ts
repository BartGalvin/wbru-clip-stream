import type { PlayoutPolicy } from './config/playoutPolicy';

export interface BlackAndWhiteSpacingItem {
  tags: string[];
}

export type BlackAndWhiteCategory = 'blackAndWhite' | 'other';
export type BlackAndWhiteConstraint = BlackAndWhiteCategory | 'either';

export interface BlackAndWhiteCounts {
  blackAndWhite: number;
  other: number;
}

type BlackAndWhitePolicy = PlayoutPolicy['blackAndWhite'];

export function getBlackAndWhiteCategory(
  item: BlackAndWhiteSpacingItem,
  policy: BlackAndWhitePolicy,
): BlackAndWhiteCategory {
  if (!policy?.tags.length) return 'other';
  return item.tags.some((tag) => policy.tags.includes(tag.toLowerCase()))
    ? 'blackAndWhite'
    : 'other';
}

// Track the prior clip and insert a color separator whenever the pool permits one.
export function createBlackAndWhiteSpacingRule(
  items: BlackAndWhiteSpacingItem[],
  priorLapOrder: number[],
  policy: BlackAndWhitePolicy,
) {
  const categoryByIndex = items.map((item) => getBlackAndWhiteCategory(item, policy));
  const priorIndex = priorLapOrder.at(-1);
  let previousCategory = priorIndex === undefined ? undefined : categoryByIndex[priorIndex];

  return {
    categoryFor(itemIndex: number): BlackAndWhiteCategory {
      return categoryByIndex[itemIndex];
    },

    chooseConstraint(
      remaining: BlackAndWhiteCounts,
      positionInLap: number,
    ): BlackAndWhiteConstraint {
      if (!policy?.tags.length) return 'either';

      if (positionInLap === 0 && remaining.other >= remaining.blackAndWhite) {
        return 'other';
      }
      if (previousCategory === 'blackAndWhite' && remaining.other > 0) {
        return 'other';
      }
      if (remaining.blackAndWhite > remaining.other) {
        return 'blackAndWhite';
      }
      return 'either';
    },

    recordSelection(selectedIndex: number): void {
      previousCategory = categoryByIndex[selectedIndex];
    },
  };
}
