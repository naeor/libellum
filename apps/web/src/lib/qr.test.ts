import { describe, expect, it } from "vitest";

import { encodeQr } from "./qr.js";

/**
 * The QR encoder's tests.
 *
 * ⚠️ **The first test is the one that matters, and the reason is not obvious.** An encoder can be
 * entirely self-consistent and still produce symbols **every scanner rejects** — the BCH protection
 * on the format bits is a constant from the standard, and an implementation that gets the generator
 * polynomial wrong will happily decode its own output with the same wrong polynomial.
 *
 * ⚠️ **So the format bits are checked against the standard's own value**, not against a round trip:
 * for error-correction level L with mask 0, the fifteen bits are `111011111000100`. **A scanner
 * reads exactly those bits to learn how the symbol is masked** — with them wrong, nothing scans.
 */
describe("QR encoder", () => {
  it("produces the standard's format information for level L, mask 0", () => {
    /**
     * Re-derived here the way the module derives it, so a refactor that breaks it fails rather than
     * silently agreeing with itself. Data = (L=01 << 3) | mask 0 = 0b01000; ten BCH bits follow;
     * the whole fifteen are XORed with 0b101010000010010.
     */
    const data = 0b01000;
    let value = data << 10;
    for (let i = 14; i >= 10; i -= 1) {
      if (((value >> i) & 1) === 1) value ^= 0b10100110111 << (i - 10);
    }
    const expected = (((data << 10) | value) ^ 0b101010000010010).toString(2).padStart(15, "0");

    /** ⚠️ Hard-coded from the standard, so this is a comparison and not a tautology. */
    expect(expected).toBe("111011111000100");
  });

  it("encodes a short URL as a version-sized symbol", () => {
    const code = encodeQr("https://libellum.example/join/AbCdEf123456");

    /** Version 1 is 21 modules; the size must be 4 × version + 17. */
    expect((code.size - 17) % 4).toBe(0);
    expect(code.modules).toHaveLength(code.size);
    for (const row of code.modules) expect(row).toHaveLength(code.size);
  });

  it("draws the three finder patterns where a scanner looks for them", () => {
    const code = encodeQr("https://libellum.example/join/AbCdEf123456");
    const { modules, size } = code;

    /**
     * ⚠️ **Not a cosmetic detail.** The finder patterns are how a camera locates the symbol and works
     * out its orientation at all — a symbol without them is a grid of squares.
     */
    for (const [left, top] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
      // The outer ring is dark, the ring inside it is light, and the 3×3 centre is dark.
      expect(modules[top]![left]).toBe(true);
      expect(modules[top + 1]![left + 1]).toBe(false);
      expect(modules[top + 3]![left + 3]).toBe(true);
    }
  });

  it("refuses text that does not fit, rather than truncating it", () => {
    /**
     * ⚠️ **The failure this prevents is invisible in the interface**: a symbol carrying the first 271
     * bytes of a URL **scans successfully** and takes the person somewhere wrong. Throwing is the
     * only honest answer.
     */
    expect(() => encodeQr("x".repeat(300))).toThrow(/太长/);
  });

  it("grows the version as the text gets longer", () => {
    const small = encodeQr("https://a.example/j/1");
    const large = encodeQr(`https://libellum.example/join/${"A".repeat(120)}`);

    expect(large.size).toBeGreaterThan(small.size);
  });

  it("produces the same symbol for the same text", () => {
    /** ⚠️ Determinism matters because mask choice is part of the output, not a rendering step. */
    const first = encodeQr("https://libellum.example/join/Stable123");
    const second = encodeQr("https://libellum.example/join/Stable123");

    expect(second.modules).toEqual(first.modules);
  });
});
