import { getBlackAndWhiteCategory } from './blackAndWhiteSpacing';
import { createClipSpacing } from './clipSpacing';
import { DEFAULT_PLAYOUT_POLICY, type PlayoutPolicy } from './config/playoutPolicy';
import { orderFingerprint, shuffledIndices } from './deterministicOrder';
import { getDurationCategory } from './durationSpacing';

// A lap plays every clip once while spacing constrained clips when possible.
// Orders are deterministic so paging can remain stateless.

interface LapItem {
  id: string;
  tags: string[];
  durationSec: number;
}

function buildLap(
  items: LapItem[],
  shuffled: number[],
  priorLapOrder: number[],
  policy: PlayoutPolicy,
): number[] {
  const spacing = createClipSpacing(items, shuffled, priorLapOrder, policy);
  const orderedIndices: number[] = [];

  while (orderedIndices.length < shuffled.length) {
    orderedIndices.push(spacing.takeNext());
  }

  return orderedIndices;
}

// Paging re-derives deterministic orders, so retain only a bounded FIFO cache.
const lapOrderCache = new Map<string, number[]>();
const MAX_CACHED_ORDERS = 64;

function memoizedOrder(cacheKey: string, buildOrder: () => number[]): number[] {
  const cachedOrder = lapOrderCache.get(cacheKey);
  if (cachedOrder) return cachedOrder;
  const order = buildOrder();
  if (lapOrderCache.size >= MAX_CACHED_ORDERS) {
    lapOrderCache.delete(lapOrderCache.keys().next().value as string);
  }
  lapOrderCache.set(cacheKey, order);
  return order;
}

// Hash the policy and the clip traits that can affect spacing.
export function programOrderFingerprint(
  items: LapItem[],
  policy: PlayoutPolicy = DEFAULT_PLAYOUT_POLICY,
): number {
  const traits = items.map((item) => [
    item.id,
    getDurationCategory(item, policy.duration),
    getBlackAndWhiteCategory(item, policy.blackAndWhite),
  ]);
  return orderFingerprint(JSON.stringify([policy, traits]));
}

// A base order depends only on this lap, so later boundary checks never recurse.
function baseLapOrder(
  items: LapItem[],
  poolHash: number,
  lapNumber: number,
  policy: PlayoutPolicy,
): number[] {
  return memoizedOrder(`${poolHash}:${items.length}:${lapNumber}:b`, () => {
    const shuffled = shuffledIndices(items.length, poolHash, lapNumber);
    return buildLap(items, shuffled, [], policy);
  });
}

// The previous base order provides stable boundary context between consecutive laps.
export function lapOrder(
  items: LapItem[],
  lapNumber: number,
  policy: PlayoutPolicy = DEFAULT_PLAYOUT_POLICY,
  poolHash = programOrderFingerprint(items, policy),
): number[] {
  if (lapNumber <= 0) {
    return baseLapOrder(items, poolHash, Math.max(0, lapNumber), policy);
  }
  return memoizedOrder(`${poolHash}:${items.length}:${lapNumber}:f`, () => {
    const previousLapBaseOrder = baseLapOrder(items, poolHash, lapNumber - 1, policy);
    const shuffled = shuffledIndices(items.length, poolHash, lapNumber);
    return buildLap(items, shuffled, previousLapBaseOrder, policy);
  });
}
