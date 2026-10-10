import { describe, expect, it } from "vitest";

import { LINE_COUNT, bandLevels, lineAmplitudes, secondsLeft } from "./voiceBars.js";

/**
 * The numbers behind the moving lines.
 *
 * The drawing needs a canvas and the levels need a microphone; this half needs
 * neither, which is the point of the split. What is worth asserting is the shape
 * of the response — that quiet is distinguishable from loud, that the middle
 * moves more than the edges, and that the mapping does not spend its whole range
 * on shouting.
 */
describe("lineAmplitudes", () => {
  it("returns one amplitude per line", () => {
    expect(lineAmplitudes([1, 1, 1, 1, 1])).toHaveLength(LINE_COUNT);
  });

  it("draws nothing at silence", () => {
    expect(lineAmplitudes([0, 0, 0, 0, 0])).toEqual([0, 0, 0, 0, 0]);
  });

  it("draws taller for a louder level", () => {
    const quiet = lineAmplitudes([0.2, 0.2, 0.2, 0.2, 0.2]);
    const loud = lineAmplitudes([0.9, 0.9, 0.9, 0.9, 0.9]);

    for (let index = 0; index < LINE_COUNT; index += 1) {
      expect(loud[index]!).toBeGreaterThan(quiet[index]!);
    }
  });

  it("lifts the quiet end, so ordinary speech is visible", () => {
    // A linear map spends most of its range on the loudest part of speech, and
    // ordinary talking then leaves the lines nearly still — which reads as a
    // broken microphone, the exact failure this display exists to prevent.
    const [middle] = lineAmplitudes([0.25, 0.25, 0.25, 0.25, 0.25]);

    expect(middle!).toBeGreaterThan(0.25);
  });

  it("moves the middle more than the edges", () => {
    // What makes the row read as one responsive object rather than five
    // independent meters — and what the owner called "中间出现弯折".
    const amplitudes = lineAmplitudes([0.7, 0.7, 0.7, 0.7, 0.7]);
    const middle = amplitudes[Math.floor(LINE_COUNT / 2)]!;

    expect(middle).toBeGreaterThan(amplitudes[0]!);
    expect(middle).toBeGreaterThan(amplitudes[LINE_COUNT - 1]!);
  });

  it("never exceeds the height it is drawn into", () => {
    // Anything above 1 would be clipped by the canvas and read as a flat top,
    // which looks like a bug rather than a loud noise.
    for (const level of lineAmplitudes([1, 1, 1, 1, 1], 2)) {
      expect(level).toBeLessThanOrEqual(1);
    }
  });

  it("is symmetric, so the shape is not lopsided", () => {
    const amplitudes = lineAmplitudes([0.5, 0.5, 0.5, 0.5, 0.5]);

    expect(amplitudes[0]).toBeCloseTo(amplitudes[4]!);
    expect(amplitudes[1]).toBeCloseTo(amplitudes[3]!);
  });

  it("tolerates fewer levels than lines", () => {
    // A short analyser buffer is a configuration mistake, not a reason to throw
    // inside a draw loop.
    expect(lineAmplitudes([0.5])).toHaveLength(LINE_COUNT);
  });
});

describe("bandLevels", () => {
  it("returns one level per line", () => {
    const spectrum = new Uint8Array(128).fill(120);

    expect(bandLevels(spectrum)).toHaveLength(LINE_COUNT);
  });

  it("reads a 0-255 byte as a 0-1 level", () => {
    const spectrum = new Uint8Array(128).fill(255);

    for (const level of bandLevels(spectrum)) expect(level).toBeCloseTo(1, 5);
  });

  it("ignores the top of the spectrum", () => {
    // Speech lives in the lower bands. A line driven by the top of the spectrum
    // would sit still while somebody talks and twitch at a door closing.
    const spectrum = new Uint8Array(128);
    spectrum.fill(0, 0, 84); // silence in the speech bands
    spectrum.fill(255, 84); // noise above them

    for (const level of bandLevels(spectrum)) expect(level).toBe(0);
  });

  it("produces independent bands", () => {
    const spectrum = new Uint8Array(128);
    spectrum.fill(255, 0, 16); // only the lowest band is loud

    const levels = bandLevels(spectrum);

    expect(levels[0]).toBeGreaterThan(0);
    expect(levels[LINE_COUNT - 1]).toBe(0);
  });

  it("copes with an empty spectrum", () => {
    expect(bandLevels(new Uint8Array(0))).toEqual([]);
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
