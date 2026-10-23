import { describe, it, expect } from 'vitest';
import { DEFAULT_PLAYOUT_POLICY, VISUALIZER_PLAYOUT_POLICY } from './config/playoutPolicy';
import { lapOrder, programOrderFingerprint } from './lapOrder';

const SHORT_MAX_SEC = DEFAULT_PLAYOUT_POLICY.duration.short.maxExclusiveSec;
const LONG_MIN_SEC = DEFAULT_PLAYOUT_POLICY.duration.long.minExclusiveSec;

// Compact clip shape used to build scheduler test pools.
interface TestClip {
  id: string;
  tags: string[];
  durationSec: number;
}

const item = (id: string, tags: string[] = [], durationSec = 60): TestClip => ({
  id,
  tags,
  durationSec,
});

const mixedPool = (
  taggedClipCount: number,
  separatorClipCount: number,
  tag = 'cartoon',
): TestClip[] => [
  ...Array.from({ length: taggedClipCount }, (_, index) => item(`c${index}`, [tag])),
  ...Array.from({ length: separatorClipCount }, (_, index) => item(`x${index}`)),
];

function matchingPositions(
  items: TestClip[],
  order: number[],
  predicate: (item: TestClip) => boolean,
) {
  return order.flatMap((index, position) => (predicate(items[index]) ? [position] : []));
}

describe('lapOrder', () => {
  it('is a permutation - every clip exactly once per lap', () => {
    const pool = mixedPool(7, 5);
    for (const lap of [0, 1, 2]) {
      const order = lapOrder(pool, lap);
      expect([...order].sort((left, right) => left - right)).toEqual(pool.map((_, index) => index));
    }
  });

  it('is deterministic - same pool + lap, same order', () => {
    const pool = mixedPool(6, 6);
    expect(lapOrder(pool, 3)).toEqual(lapOrder(pool, 3));
    expect(lapOrder(mixedPool(6, 6), 3)).toEqual(lapOrder(pool, 3));
  });

  it('ignores metadata changes that do not affect spacing', () => {
    const original = [
      item('a', ['indie'], 60),
      item('b', ['black and white', 'movie'], SHORT_MAX_SEC - 1),
    ];
    const updated = [
      item('a', ['360'], 90),
      item('b', ['movie', 'BLACKWHITE'], SHORT_MAX_SEC - 10),
    ];

    expect(programOrderFingerprint(updated, VISUALIZER_PLAYOUT_POLICY)).toBe(
      programOrderFingerprint(original, VISUALIZER_PLAYOUT_POLICY),
    );
  });

  it('changes when a clip moves to another spacing category', () => {
    const original = [item('a'), item('b', ['black and white'], SHORT_MAX_SEC - 1)];
    const durationChanged = [item('a'), item('b', ['black and white'], SHORT_MAX_SEC)];
    const colorChanged = [item('a'), item('b', [], SHORT_MAX_SEC - 1)];

    expect(programOrderFingerprint(durationChanged, VISUALIZER_PLAYOUT_POLICY)).not.toBe(
      programOrderFingerprint(original, VISUALIZER_PLAYOUT_POLICY),
    );
    expect(programOrderFingerprint(colorChanged, VISUALIZER_PLAYOUT_POLICY)).not.toBe(
      programOrderFingerprint(original, VISUALIZER_PLAYOUT_POLICY),
    );
  });

  it('keeps the default and visualizer orders stable', () => {
    const pool = [
      item('bw-short', ['BLACKWHITE'], SHORT_MAX_SEC - 1),
      item('bw-normal', ['black and white']),
      item('bw-long', ['blackwhite'], LONG_MIN_SEC + 1),
      item('other-short', [], 1),
      item('other-zero', [], 0),
      item('other-normal', [], SHORT_MAX_SEC),
      item('other-long', [], LONG_MIN_SEC + 1),
      item('other-edge', [], LONG_MIN_SEC),
      item('other-2', [], 90),
    ];

    expect([lapOrder(pool, 0), lapOrder(pool, 1)]).toEqual([
      [0, 2, 4, 6, 3, 8, 1, 5, 7],
      [1, 2, 3, 6, 7, 0, 4, 5, 8],
    ]);
    expect([
      lapOrder(pool, 0, VISUALIZER_PLAYOUT_POLICY),
      lapOrder(pool, 1, VISUALIZER_PLAYOUT_POLICY),
    ]).toEqual([
      [6, 3, 2, 5, 0, 8, 1, 7, 4],
      [5, 2, 3, 6, 4, 0, 7, 8, 1],
    ]);
  });

  it('invalidates cached orders when nested policy settings change', () => {
    const pool = [
      ...Array.from({ length: 4 }, (_, index) => item(`short${index}`, [], SHORT_MAX_SEC - 1)),
      ...Array.from({ length: 10 }, (_, index) => item(`normal${index}`)),
    ];
    const oneClipBetweenShorts = {
      ...DEFAULT_PLAYOUT_POLICY,
      duration: {
        ...DEFAULT_PLAYOUT_POLICY.duration,
        short: {
          ...DEFAULT_PLAYOUT_POLICY.duration.short,
          clipsBetween: 1,
        },
      },
    };

    expect(lapOrder(pool, 7, oneClipBetweenShorts)).not.toEqual(lapOrder(pool, 7));
  });

  it('reshuffles between laps', () => {
    const pool = mixedPool(8, 8);
    expect(lapOrder(pool, 0)).not.toEqual(lapOrder(pool, 1));
  });

  it('never puts black-and-white clips back-to-back when separators are available', () => {
    for (let blackAndWhiteCount = 1; blackAndWhiteCount <= 8; blackAndWhiteCount++) {
      for (
        let colorCount = blackAndWhiteCount;
        colorCount <= blackAndWhiteCount + 4;
        colorCount++
      ) {
        const pool = [
          ...Array.from({ length: blackAndWhiteCount }, (_, i) =>
            item(
              `bw${i}`,
              ['black and white'],
              i % 3 === 0 ? SHORT_MAX_SEC - 1 : i % 5 === 0 ? LONG_MIN_SEC + 1 : 60,
            ),
          ),
          ...Array.from({ length: colorCount }, (_, i) =>
            item(
              `color${i}`,
              [],
              i % 4 === 0 ? SHORT_MAX_SEC - 1 : i % 7 === 0 ? LONG_MIN_SEC + 1 : 60,
            ),
          ),
        ];
        const played = Array.from({ length: 20 }, (_, lap) => lap).flatMap((lap) =>
          lapOrder(pool, lap, VISUALIZER_PLAYOUT_POLICY).map((index) => pool[index]),
        );
        for (let position = 1; position < played.length; position++) {
          const previousIsBlackAndWhite = played[position - 1].tags.includes('black and white');
          const currentIsBlackAndWhite = played[position].tags.includes('black and white');
          expect(previousIsBlackAndWhite && currentIsBlackAndWhite).toBe(false);
        }
      }
    }
  });

  it('treats both production black-and-white tag spellings as the same category', () => {
    const pool = [
      item('bw-spaced', ['black and white']),
      item('bw-joined', ['blackwhite']),
      item('color-1'),
      item('color-2'),
    ];
    const played = Array.from({ length: 20 }, (_, lap) => lap).flatMap((lap) =>
      lapOrder(pool, lap, VISUALIZER_PLAYOUT_POLICY).map((index) => pool[index]),
    );
    const isBlackAndWhite = (candidate: TestClip) =>
      candidate.tags.some((tag) => tag === 'black and white' || tag === 'blackwhite');

    for (let position = 1; position < played.length; position++) {
      expect(isBlackAndWhite(played[position - 1]) && isBlackAndWhite(played[position])).toBe(
        false,
      );
    }
  });

  it('applies duration and black-and-white spacing together across laps', () => {
    const pool = [
      ...Array.from({ length: 2 }, (_, index) =>
        item(`bw-short${index}`, ['blackwhite'], SHORT_MAX_SEC - 1),
      ),
      ...Array.from({ length: 2 }, (_, index) => item(`bw-normal${index}`, ['black and white'])),
      item('bw-long', ['blackwhite'], LONG_MIN_SEC + 1),
      item('other-short', [], SHORT_MAX_SEC - 1),
      ...Array.from({ length: 5 }, (_, index) => item(`other-normal${index}`)),
      item('other-long', [], LONG_MIN_SEC + 1),
    ];
    const played = Array.from({ length: 100 }, (_, lap) => lap).flatMap((lap) =>
      lapOrder(pool, lap, VISUALIZER_PLAYOUT_POLICY).map((index) => pool[index]),
    );
    let clipsSinceShort = Number.POSITIVE_INFINITY;
    let clipsSinceLong = Number.POSITIVE_INFINITY;

    for (let position = 0; position < played.length; position++) {
      const candidate = played[position];
      if (position > 0) {
        expect(candidate.tags.length > 0 && played[position - 1].tags.length > 0).toBe(false);
      }
      if (candidate.durationSec < SHORT_MAX_SEC) {
        expect(clipsSinceShort).toBeGreaterThanOrEqual(
          DEFAULT_PLAYOUT_POLICY.duration.short.clipsBetween,
        );
      }
      if (candidate.durationSec > LONG_MIN_SEC) {
        expect(clipsSinceLong).toBeGreaterThanOrEqual(
          DEFAULT_PLAYOUT_POLICY.duration.long.clipsBetween,
        );
      }
      clipsSinceShort = candidate.durationSec < SHORT_MAX_SEC ? 0 : clipsSinceShort + 1;
      clipsSinceLong = candidate.durationSec > LONG_MIN_SEC ? 0 : clipsSinceLong + 1;
    }
  });

  it('keeps every black-and-white clip when perfect spacing is impossible', () => {
    const pool = mixedPool(5, 1, 'black and white');
    const order = lapOrder(pool, 0, VISUALIZER_PLAYOUT_POLICY);
    expect([...order].sort((left, right) => left - right)).toEqual(pool.map((_, index) => index));
  });

  it('keeps a complete later lap when black-and-white filtering leaves only short clips', () => {
    const pool = [
      ...Array.from({ length: 3 }, (_, i) =>
        item(`bw-short${i}`, ['black and white'], SHORT_MAX_SEC - 1),
      ),
      item('color-normal-1'),
      item('color-normal-2'),
    ];
    const order = lapOrder(pool, 1, VISUALIZER_PLAYOUT_POLICY);

    expect([...order].sort((left, right) => left - right)).toEqual(pool.map((_, index) => index));
  });

  it('puts two non-short videos between short videos', () => {
    const pool = [
      ...Array.from({ length: 4 }, (_, i) => item(`short${i}`, [], SHORT_MAX_SEC - 1)),
      ...Array.from({ length: 10 }, (_, i) => item(`normal${i}`)),
    ];
    for (const lap of [0, 1, 2, 3]) {
      const shortPositions = matchingPositions(
        pool,
        lapOrder(pool, lap),
        (candidate) => candidate.durationSec < SHORT_MAX_SEC,
      );
      for (let i = 1; i < shortPositions.length; i++) {
        expect(shortPositions[i] - shortPositions[i - 1]).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('does not put long videos back-to-back', () => {
    const pool = [
      ...Array.from({ length: 5 }, (_, i) => item(`long${i}`, [], LONG_MIN_SEC + 1)),
      ...Array.from({ length: 6 }, (_, i) => item(`normal${i}`)),
    ];
    for (const lap of [0, 1, 2, 3]) {
      const longPositions = matchingPositions(
        pool,
        lapOrder(pool, lap),
        (candidate) => candidate.durationSec > LONG_MIN_SEC,
      );
      for (let i = 1; i < longPositions.length; i++) {
        expect(longPositions[i] - longPositions[i - 1]).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('keeps duration spacing across long runs of lap boundaries', () => {
    const pools = [
      [
        ...Array.from({ length: 8 }, (_, i) => item(`short${i}`, [], SHORT_MAX_SEC - 1)),
        ...Array.from({ length: 17 }, (_, i) => item(`normal${i}`)),
      ],
      [
        ...Array.from({ length: 14 }, (_, i) => item(`long${i}`, [], LONG_MIN_SEC + 1)),
        ...Array.from({ length: 15 }, (_, i) => item(`normal${i}`)),
      ],
      [
        ...Array.from({ length: 8 }, (_, i) => item(`short${i}`, [], SHORT_MAX_SEC - 1)),
        ...Array.from({ length: 8 }, (_, i) => item(`long${i}`, [], LONG_MIN_SEC + 1)),
        ...Array.from({ length: 16 }, (_, i) => item(`normal${i}`)),
      ],
    ];
    for (const pool of pools) {
      const played = Array.from({ length: 200 }, (_, lap) => lap).flatMap((lap) =>
        lapOrder(pool, lap).map((index) => pool[index]),
      );
      let clipsSinceShort = Number.POSITIVE_INFINITY;
      let clipsSinceLong = Number.POSITIVE_INFINITY;
      for (const candidate of played) {
        const duration = candidate.durationSec;
        if (duration < SHORT_MAX_SEC) expect(clipsSinceShort).toBeGreaterThanOrEqual(2);
        if (duration > LONG_MIN_SEC) expect(clipsSinceLong).toBeGreaterThanOrEqual(1);
        clipsSinceShort = duration < SHORT_MAX_SEC ? 0 : clipsSinceShort + 1;
        clipsSinceLong = duration > LONG_MIN_SEC ? 0 : clipsSinceLong + 1;
      }
    }
  });

  it('still plays every video when duration spacing is impossible', () => {
    const pool = [
      ...Array.from({ length: 5 }, (_, i) => item(`short${i}`, [], SHORT_MAX_SEC - 1)),
      item('normal'),
    ];
    const order = lapOrder(pool, 0);
    expect([...order].sort((left, right) => left - right)).toEqual(pool.map((_, index) => index));
  });

  it('orders a production-sized pool promptly', () => {
    const pool = Array.from({ length: 6_000 }, (_, index) =>
      item(
        'clip' + index,
        [
          ...(index % 2 === 0 ? ['indie'] : ['360']),
          ...(index % 5 === 0 ? ['black and white'] : []),
          ...(index % 7 === 0 ? ['movie'] : []),
        ],
        index % 20 === 0 ? SHORT_MAX_SEC - 1 : index % 31 === 0 ? LONG_MIN_SEC + 1 : 60,
      ),
    );

    const order = lapOrder(pool, 0, VISUALIZER_PLAYOUT_POLICY);

    expect(order).toHaveLength(pool.length);
    expect(new Set(order)).toHaveLength(pool.length);
  }, 2_000);
});
