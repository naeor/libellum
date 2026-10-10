import { describe, expect, it } from "vitest";

import {
  RIPPLE_INTERVAL_MIN_MS,
  RIPPLE_INTERVAL_MS,
  RIPPLE_MAX_REACH,
  RIPPLE_MIN_REACH,
  advanceRipples,
  intervalForLevel,
  lifeForInterval,
  reachForLevel,
  rippleProgress,
  secondsLeft,
} from "./voiceRipples.js";

/**
 * The ripples' timing and mapping.
 *
 * This module exists because the first version of this display could only be
 * judged by looking at it, and looking at it produced "那五根线条扭动的很诡异".
 * The numbers behind the replacement are testable, so they are tested.
 *
 * The owner then changed two of them after seeing it: a slower base pulse, and
 * **louder means faster as well as further**. Both are his figures, and both are
 * asserted here rather than left as constants somebody might tidy.
 */
type State = {
  ripples: readonly { ageMs: number; reach: number; lifeMs: number }[];
  sinceLastMs: number;
};

/** Quiet room. */
const QUIET = 0;
/** A shout — the top of the owner's range, "大约 100 分贝". */
const SHOUT = 1;

describe("intervalForLevel", () => {
  it("pulses at the base interval in a quiet room", () => {
    expect(intervalForLevel(QUIET)).toBeCloseTo(RIPPLE_INTERVAL_MS);
  });

  it("gets as fast as the floor when somebody shouts", () => {
    // His rule: 最多缩短至 0.2 秒, which he places at about 100 dB.
    expect(intervalForLevel(SHOUT)).toBeCloseTo(RIPPLE_INTERVAL_MIN_MS);
  });

  it("speeds up as it gets louder", () => {
    expect(intervalForLevel(0.8)).toBeLessThan(intervalForLevel(0.2));
  });

  it("never goes below the floor", () => {
    // Without a floor a clipped signal would fire rings so fast they would be a
    // solid blur rather than a pulse.
    expect(intervalForLevel(5)).toBeGreaterThanOrEqual(RIPPLE_INTERVAL_MIN_MS);
    expect(intervalForLevel(-1)).toBe(RIPPLE_INTERVAL_MS);
  });

  it("scales the life with the interval, so the count stays about the same", () => {
    // What stops a shout from filling the display with rings: three times the
    // pace means three times the rings unless each one also dies sooner.
    expect(lifeForInterval(RIPPLE_INTERVAL_MS) / RIPPLE_INTERVAL_MS).toBeCloseTo(2.5);
    expect(lifeForInterval(RIPPLE_INTERVAL_MIN_MS) / RIPPLE_INTERVAL_MIN_MS).toBeCloseTo(2.5);
  });
});

describe("reachForLevel", () => {
  it("sends a quiet ripple the minimum distance", () => {
    expect(reachForLevel(0)).toBeCloseTo(RIPPLE_MIN_REACH);
  });

  it("sends the loudest ripple the maximum distance", () => {
    expect(reachForLevel(1)).toBeCloseTo(RIPPLE_MAX_REACH);
  });

  it("sends a louder ripple further", () => {
    // The owner's first rule: 声音越大，音波传的就越远.
    expect(reachForLevel(0.8)).toBeGreaterThan(reachForLevel(0.3));
  });

  it("lifts the quiet end, so ordinary speech is visible", () => {
    // Loudness is not linear in perception. A quarter of the range is already
    // "somebody talking", and a linear map would give it a quarter of the
    // distance — which makes ordinary speech look like a whisper.
    const linear = RIPPLE_MIN_REACH + (RIPPLE_MAX_REACH - RIPPLE_MIN_REACH) * 0.25;

    expect(reachForLevel(0.25)).toBeGreaterThan(linear);
  });

  it("stays inside its bounds for a level outside 0-1", () => {
    // The analyser can report slightly over 1 on a clipped signal.
    expect(reachForLevel(3)).toBeCloseTo(RIPPLE_MAX_REACH);
    expect(reachForLevel(-1)).toBeCloseTo(RIPPLE_MIN_REACH);
  });
});

describe("advanceRipples", () => {
  it("adds one ripple per interval", () => {
    const afterOne = advanceRipples([], RIPPLE_INTERVAL_MS, 0, QUIET);
    expect(afterOne.ripples).toHaveLength(1);

    const afterTwo = advanceRipples(afterOne.ripples, RIPPLE_INTERVAL_MS, afterOne.sinceLastMs, QUIET);
    expect(afterTwo.ripples).toHaveLength(2);
  });

  it("does not add one before the interval is up", () => {
    const result = advanceRipples([], RIPPLE_INTERVAL_MS - 1, 0, QUIET);

    expect(result.ripples).toHaveLength(0);
    expect(result.sinceLastMs).toBe(RIPPLE_INTERVAL_MS - 1);
  });

  it("throws more ripples in the same time when it is loud", () => {
    // The owner's second rule, measured over the same span of real time.
    const countOver = (level: number): number => {
      let state: State = { ripples: [], sinceLastMs: 0 };
      let total = 0;

      for (let frame = 0; frame < 300; frame += 1) {
        const next = advanceRipples(state.ripples, 16, state.sinceLastMs, level);
        total += Math.max(0, next.ripples.length - state.ripples.length);
        state = next;
      }

      return total;
    };

    expect(countOver(SHOUT)).toBeGreaterThan(countOver(QUIET));
  });

  it("catches up after a dropped frame rather than losing a beat", () => {
    // A backgrounded tab, a slow frame, a phone under load: the code must not
    // quietly end up out of step with the sound.
    const result = advanceRipples([], RIPPLE_INTERVAL_MS * 3 + 10, 0, QUIET);

    expect(result.ripples).toHaveLength(3);
  });

  it("removes a ripple once its own life is over", () => {
    const born = advanceRipples([], RIPPLE_INTERVAL_MS, 0, QUIET).ripples;
    expect(born).toHaveLength(1);

    const aged = advanceRipples(born, born[0]!.lifeMs, 0, QUIET);

    expect(aged.ripples.every((ripple) => ripple.ageMs < ripple.lifeMs)).toBe(true);
  });

  it("gives a ripple born mid-frame its real age, not zero", () => {
    // ⚠️ The bug a test caught. A frame that spans several intervals used to
    // stamp every new ripple as born *now*, so they piled up on top of each
    // other instead of forming a series travelling outwards.
    const result = advanceRipples([], RIPPLE_INTERVAL_MS * 2, 0, QUIET);

    const ages = result.ripples.map((ripple) => ripple.ageMs).sort((a, b) => a - b);
    expect(ages).toEqual([0, RIPPLE_INTERVAL_MS]);
  });

  it("keeps a travelling series alive across many small frames", () => {
    // Two hundred frames of sixteen milliseconds. The window matters: sixty
    // frames is less than one lifetime, so it cannot show whether a steady state
    // exists — and the first version of this test failed for that reason rather
    // than because the code was wrong.
    let state: State = { ripples: [], sinceLastMs: 0 };

    for (let frame = 0; frame < 200; frame += 1) {
      state = advanceRipples(state.ripples, 16, state.sinceLastMs, 0.4);
    }

    expect(state.ripples.length).toBeGreaterThanOrEqual(2);
    expect(state.ripples.length).toBeLessThanOrEqual(4);
  });

  it("gives each ripple the reach of the level when it was born", () => {
    // The point of the whole mapping: a ripple remembers how loud it was.
    const quiet = advanceRipples([], RIPPLE_INTERVAL_MS, 0, QUIET).ripples[0]!;
    const loud = advanceRipples([], RIPPLE_INTERVAL_MIN_MS, 0, SHOUT).ripples[0]!;

    expect(loud.reach).toBeGreaterThan(quiet.reach);
  });

  it("never mutates the list it was given", () => {
    const before = [{ ageMs: 0, reach: 40, lifeMs: 1_500 }];
    advanceRipples(before, RIPPLE_INTERVAL_MS, 0, QUIET);

    expect(before[0]?.ageMs).toBe(0);
  });
});

describe("rippleProgress", () => {
  const ripple = (ageMs: number) => ({ ageMs, reach: 50, lifeMs: 1_500 });

  it("starts at the centre and fully opaque", () => {
    const { spread, opacity } = rippleProgress(ripple(0));

    expect(spread).toBe(0);
    expect(opacity).toBe(1);
  });

  it("ends at full spread and invisible", () => {
    const { spread, opacity } = rippleProgress(ripple(1_500));

    expect(spread).toBeCloseTo(1);
    expect(opacity).toBeCloseTo(0);
  });

  it("spreads faster at the start than at the end", () => {
    // A ripple at a constant rate looks mechanical; one that leaves quickly and
    // slows down looks like something spreading.
    const early = rippleProgress(ripple(375)).spread;
    const late = rippleProgress(ripple(1_125)).spread;

    expect(early).toBeGreaterThan(0.25);
    expect(1 - late).toBeLessThan(0.5);
  });

  it("stays fully opaque for the first half of its life", () => {
    // So the ring is visible for as long as possible rather than being a grey
    // smudge for most of its travel.
    expect(rippleProgress(ripple(600)).opacity).toBe(1);
  });

  it("never reports an opacity outside 0-1", () => {
    for (const age of [0, 100, 400, 750, 1_200, 1_500, 2_000]) {
      const { opacity } = rippleProgress(ripple(age));
      expect(opacity).toBeGreaterThanOrEqual(0);
      expect(opacity).toBeLessThanOrEqual(1);
    }
  });
});

describe("secondsLeft", () => {
  it("counts down the thirty seconds", () => {
    expect(secondsLeft(0, 30)).toBe(30);
    expect(secondsLeft(1_000, 30)).toBe(29);
    expect(secondsLeft(29_900, 30)).toBe(1);
  });

  it("never goes below zero", () => {
    // A negative number on screen would look like a different kind of bug.
    expect(secondsLeft(45_000, 30)).toBe(0);
  });
});
