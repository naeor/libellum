import { describe, expect, it } from "vitest";

import {
  RIPPLE_INTERVAL_MS,
  RIPPLE_LIFE_MS,
  RIPPLE_MAX_REACH,
  RIPPLE_MIN_REACH,
  advanceRipples,
  reachForLevel,
  rippleProgress,
  secondsLeft,
} from "./voiceRipples.js";

/**
 * The ripples' timing and mapping.
 *
 * This module exists because the first version of this display could only be
 * judged by looking at it, and looking at it produced "那五根线条扭动的很诡异".
 * The numbers behind the replacement — how often a ripple appears, how far it
 * goes, how it fades — are testable, so they are tested.
 */
describe("reachForLevel", () => {
  it("sends a quiet ripple the minimum distance", () => {
    expect(reachForLevel(0)).toBeCloseTo(RIPPLE_MIN_REACH);
  });

  it("sends the loudest ripple the maximum distance", () => {
    expect(reachForLevel(1)).toBeCloseTo(RIPPLE_MAX_REACH);
  });

  it("sends a louder ripple further", () => {
    // The owner's rule in one line: 声音越大，音波传的就越远.
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
    const afterOne = advanceRipples([], RIPPLE_INTERVAL_MS, 0, 0.5);
    expect(afterOne.ripples).toHaveLength(1);

    const afterTwo = advanceRipples(afterOne.ripples, RIPPLE_INTERVAL_MS, afterOne.sinceLastMs, 0.5);
    expect(afterTwo.ripples).toHaveLength(2);
  });

  it("does not add one before the interval is up", () => {
    const result = advanceRipples([], RIPPLE_INTERVAL_MS - 1, 0, 0.5);

    expect(result.ripples).toHaveLength(0);
    expect(result.sinceLastMs).toBe(RIPPLE_INTERVAL_MS - 1);
  });

  it("catches up after a dropped frame rather than losing a beat", () => {
    // A backgrounded tab, a slow frame, a phone under load: the loop must not
    // quietly end up out of step with the sound.
    const result = advanceRipples([], RIPPLE_INTERVAL_MS * 3 + 10, 0, 0.5);

    expect(result.ripples).toHaveLength(3);
  });

  it("removes a ripple once its life is over", () => {
    // Born, then aged past its life: gone. Nothing new appears during the
    // advance because the interval is longer than a frame.
    const born = advanceRipples([], RIPPLE_INTERVAL_MS, 0, 0.5).ripples;
    expect(born).toHaveLength(1);

    const aged = advanceRipples(born, RIPPLE_LIFE_MS, 0, 0.5);

    expect(aged.ripples.every((ripple) => ripple.ageMs < RIPPLE_LIFE_MS)).toBe(true);
    expect(aged.ripples.some((ripple) => ripple.ageMs === 0)).toBe(true);
  });

  it("gives a ripple born mid-frame its real age, not zero", () => {
    // ⚠️ The bug the steady test below caught. A frame that spans several
    // intervals used to stamp every new ripple as born *now*, so they piled up
    // on top of each other instead of forming a series travelling outwards.
    const result = advanceRipples([], RIPPLE_INTERVAL_MS * 2, 0, 0.5);

    const ages = result.ripples.map((ripple) => ripple.ageMs).sort((a, b) => a - b);
    expect(ages).toEqual([0, RIPPLE_INTERVAL_MS]);
  });

  it("keeps a travelling series alive across many small frames", () => {
    // Two hundred frames of sixteen milliseconds — a little over three seconds,
    // which is longer than one ripple's life. The window matters: sixty frames
    // is less than a single lifetime, so it cannot show whether a steady state
    // exists at all, and the first version of this test failed for that reason
    // rather than because the code was wrong.
    let state: { ripples: readonly { ageMs: number; reach: number }[]; sinceLastMs: number } = {
      ripples: [],
      sinceLastMs: 0,
    };

    for (let frame = 0; frame < 200; frame += 1) {
      state = advanceRipples(state.ripples, 16, state.sinceLastMs, 0.5);
    }

    // Three intervals fit inside one life, so about three ripples are in flight.
    expect(state.ripples.length).toBeGreaterThanOrEqual(2);
    expect(state.ripples.length).toBeLessThanOrEqual(4);
  });

  it("gives each ripple the reach of the level when it was born", () => {
    // The point of the whole mapping: a ripple remembers how loud it was.
    const quiet = advanceRipples([], RIPPLE_INTERVAL_MS, 0, 0).ripples[0]!;
    const loud = advanceRipples([], RIPPLE_INTERVAL_MS, 0, 1).ripples[0]!;

    expect(loud.reach).toBeGreaterThan(quiet.reach);
  });

  it("never mutates the list it was given", () => {
    const before = [{ ageMs: 0, reach: 40 }];
    advanceRipples(before, RIPPLE_INTERVAL_MS, 0, 0.5);

    expect(before[0]?.ageMs).toBe(0);
  });
});

describe("rippleProgress", () => {
  it("starts at the centre and fully opaque", () => {
    const { spread, opacity } = rippleProgress({ ageMs: 0, reach: 50 });

    expect(spread).toBe(0);
    expect(opacity).toBe(1);
  });

  it("ends at full spread and invisible", () => {
    const { spread, opacity } = rippleProgress({ ageMs: RIPPLE_LIFE_MS, reach: 50 });

    expect(spread).toBeCloseTo(1);
    expect(opacity).toBeCloseTo(0);
  });

  it("spreads faster at the start than at the end", () => {
    // A ripple at a constant rate looks mechanical; one that leaves quickly and
    // slows down looks like something spreading.
    const early = rippleProgress({ ageMs: RIPPLE_LIFE_MS * 0.25, reach: 50 }).spread;
    const late = rippleProgress({ ageMs: RIPPLE_LIFE_MS * 0.75, reach: 50 }).spread;

    expect(early).toBeGreaterThan(0.25);
    expect(1 - late).toBeLessThan(0.5);
  });

  it("stays fully opaque for the first half of its life", () => {
    // So the ring is visible for as long as possible rather than being a grey
    // smudge for most of its travel.
    expect(rippleProgress({ ageMs: RIPPLE_LIFE_MS * 0.4, reach: 50 }).opacity).toBe(1);
  });

  it("never reports an opacity outside 0-1", () => {
    for (const age of [0, 100, 400, 750, 1_200, RIPPLE_LIFE_MS, RIPPLE_LIFE_MS + 500]) {
      const { opacity } = rippleProgress({ ageMs: age, reach: 50 });
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
