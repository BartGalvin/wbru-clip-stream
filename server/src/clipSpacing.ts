import {
  createBlackAndWhiteSpacingRule,
  type BlackAndWhiteCategory,
  type BlackAndWhiteConstraint,
  type BlackAndWhiteCounts,
  type BlackAndWhiteSpacingItem,
} from './blackAndWhiteSpacing';
import type { PlayoutPolicy } from './config/playoutPolicy';
import {
  createDurationSpacingRule,
  type DurationCategory,
  type DurationCounts,
  type DurationSpacingItem,
} from './durationSpacing';

type ClipSpacingItem = BlackAndWhiteSpacingItem & DurationSpacingItem;

interface QueuedCandidate {
  itemIndex: number;
  shufflePosition: number;
}

interface CandidateQueue {
  candidates: QueuedCandidate[];
  nextPosition: number;
}

interface CandidateQueues {
  blackAndWhite: Record<DurationCategory, CandidateQueue>;
  other: Record<DurationCategory, CandidateQueue>;
}

const BLACK_AND_WHITE_CATEGORIES: readonly BlackAndWhiteCategory[] = ['blackAndWhite', 'other'];

function emptyQueue(): CandidateQueue {
  return { candidates: [], nextPosition: 0 };
}

function createQueues(): CandidateQueues {
  return {
    blackAndWhite: {
      short: emptyQueue(),
      normal: emptyQueue(),
      long: emptyQueue(),
    },
    other: {
      short: emptyQueue(),
      normal: emptyQueue(),
      long: emptyQueue(),
    },
  };
}

function remainingIn(queue: CandidateQueue): number {
  return queue.candidates.length - queue.nextPosition;
}

function blackAndWhiteCounts(queues: CandidateQueues): BlackAndWhiteCounts {
  return {
    blackAndWhite:
      remainingIn(queues.blackAndWhite.short) +
      remainingIn(queues.blackAndWhite.normal) +
      remainingIn(queues.blackAndWhite.long),
    other:
      remainingIn(queues.other.short) +
      remainingIn(queues.other.normal) +
      remainingIn(queues.other.long),
  };
}

function durationCounts(
  queues: CandidateQueues,
  blackAndWhiteConstraint: BlackAndWhiteConstraint,
): DurationCounts {
  const counts: DurationCounts = { short: 0, normal: 0, long: 0 };
  for (const category of BLACK_AND_WHITE_CATEGORIES) {
    if (blackAndWhiteConstraint !== 'either' && blackAndWhiteConstraint !== category) {
      continue;
    }
    counts.short += remainingIn(queues[category].short);
    counts.normal += remainingIn(queues[category].normal);
    counts.long += remainingIn(queues[category].long);
  }
  return counts;
}

function takeEligibleHead(
  queues: CandidateQueues,
  blackAndWhiteConstraint: BlackAndWhiteConstraint,
  durationCategory: DurationCategory,
): number | undefined {
  let selectedCandidate: QueuedCandidate | undefined;
  let selectedQueue: CandidateQueue | undefined;

  for (const blackAndWhiteCategory of BLACK_AND_WHITE_CATEGORIES) {
    if (blackAndWhiteConstraint !== 'either' && blackAndWhiteConstraint !== blackAndWhiteCategory) {
      continue;
    }
    const queue = queues[blackAndWhiteCategory][durationCategory];
    const candidate = queue.candidates[queue.nextPosition];
    if (
      candidate &&
      (!selectedCandidate || candidate.shufflePosition < selectedCandidate.shufflePosition)
    ) {
      selectedCandidate = candidate;
      selectedQueue = queue;
    }
  }

  if (!selectedCandidate || !selectedQueue) return undefined;
  selectedQueue.nextPosition++;
  return selectedCandidate.itemIndex;
}

// Partition the shuffled clips by rule category, then let each rule narrow the next queue.
export function createClipSpacing(
  items: ClipSpacingItem[],
  shuffledIndices: number[],
  priorLapOrder: number[],
  policy: PlayoutPolicy,
) {
  const blackAndWhiteRule = createBlackAndWhiteSpacingRule(
    items,
    priorLapOrder,
    policy.blackAndWhite,
  );
  const durationRule = createDurationSpacingRule(items, priorLapOrder, policy.duration);
  const queues = createQueues();

  // Each queue stays in shuffle order, and its cursor points at its first unplayed clip.
  for (let shufflePosition = 0; shufflePosition < shuffledIndices.length; shufflePosition++) {
    const itemIndex = shuffledIndices[shufflePosition];
    const blackAndWhiteCategory = blackAndWhiteRule.categoryFor(itemIndex);
    const durationCategory = durationRule.categoryFor(itemIndex);
    queues[blackAndWhiteCategory][durationCategory].candidates.push({
      itemIndex,
      shufflePosition,
    });
  }

  let positionInLap = 0;

  return {
    takeNext(): number {
      if (positionInLap >= shuffledIndices.length) {
        throw new Error('lap scheduler has no remaining clips');
      }

      // Black-and-white narrows first; duration chooses within that constraint.
      const blackAndWhiteConstraint = blackAndWhiteRule.chooseConstraint(
        blackAndWhiteCounts(queues),
        positionInLap,
      );
      const durationCategory = durationRule.chooseConstraint(
        durationCounts(queues, blackAndWhiteConstraint),
        positionInLap,
      );
      const selectedIndex = takeEligibleHead(queues, blackAndWhiteConstraint, durationCategory);
      if (selectedIndex === undefined) {
        throw new Error('lap scheduler found no eligible clip');
      }

      positionInLap++;
      blackAndWhiteRule.recordSelection(selectedIndex);
      durationRule.recordSelection(selectedIndex);
      return selectedIndex;
    },
  };
}
