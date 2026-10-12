/**
 * **A small QR encoder — enough to put a share link in front of a camera.**
 *
 * ⚠️ **Written rather than installed, and the reason is the owner's own rule.** This project has
 * four runtime dependencies on the web side; a QR library would be the fifth, and it would be there
 * to draw **one** picture on **one** screen. The standard is public and the subset a URL needs is
 * small: byte mode, one error-correction level, versions 1–10.
 *
 * ⚠️ **Only what a link needs is implemented, and the limits are stated rather than silently
 * clipped:**
 *
 *  * **Byte mode only.** A join URL is ASCII or UTF-8 text; numeric and alphanumeric modes are a
 *    size optimisation for payloads this code will never see.
 *  * **Error correction L (≈7%).** The user is holding a phone at a screen, not photographing a
 *    printed label across a room. **L leaves the most room for data**, and a share link can be long.
 *  * **Versions 1–10 (up to 271 bytes at L).** Beyond that, `encodeQr` **throws** — it does not
 *    quietly truncate, because **a QR code that omits the end of a URL scans successfully and leads
 *    somewhere wrong.**
 *
 * ⚠️ **Verified against the standard's own format-information vector** — see `qr.test.ts`. The
 * format bits for (L, mask 0) are `111011111000100`, and the test asserts exactly that, **because
 * self-consistency would not catch a wrong BCH generator polynomial**: an encoder can agree with
 * itself and disagree with every scanner.
 */

/** GF(256) with the QR primitive polynomial 0x11d. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if ((x & 0x100) !== 0) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!] ?? 0;
}

/** The generator polynomial for `degree` error-correction codewords. */
function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j] ?? 0) ^ (poly[j] ?? 0);
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j] ?? 0, EXP[i] ?? 0);
    }
    poly = next;
  }
  return poly;
}

/** Reed–Solomon error-correction codewords for one block. */
function rsEncode(data: readonly number[], ecCount: number): number[] {
  const gen = rsGenerator(ecCount);
  const remainder = new Array<number>(ecCount).fill(0);

  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < ecCount; i += 1) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMul(gen[i + 1] ?? 0, factor);
    }
  }

  return remainder;
}

/**
 * Version capacities at error-correction level L.
 *
 * ⚠️ **Each version carries: total codewords, EC codewords per block, and the block split.** The
 * split matters because **interleaving is done per block**, and a version whose blocks are assumed
 * to be one block will produce a code that looks right and does not scan.
 */
interface VersionSpec {
  readonly version: number;
  readonly totalCodewords: number;
  readonly ecPerBlock: number;
  readonly group1Blocks: number;
  readonly group1Data: number;
  readonly group2Blocks: number;
  readonly group2Data: number;
}

/** Versions 1–10 at level L, from the standard's table. */
const VERSIONS_L: readonly VersionSpec[] = [
  { version: 1, totalCodewords: 26, ecPerBlock: 7, group1Blocks: 1, group1Data: 19, group2Blocks: 0, group2Data: 0 },
  { version: 2, totalCodewords: 44, ecPerBlock: 10, group1Blocks: 1, group1Data: 34, group2Blocks: 0, group2Data: 0 },
  { version: 3, totalCodewords: 70, ecPerBlock: 15, group1Blocks: 1, group1Data: 55, group2Blocks: 0, group2Data: 0 },
  { version: 4, totalCodewords: 100, ecPerBlock: 20, group1Blocks: 1, group1Data: 80, group2Blocks: 0, group2Data: 0 },
  { version: 5, totalCodewords: 134, ecPerBlock: 26, group1Blocks: 1, group1Data: 108, group2Blocks: 0, group2Data: 0 },
  { version: 6, totalCodewords: 172, ecPerBlock: 18, group1Blocks: 2, group1Data: 68, group2Blocks: 0, group2Data: 0 },
  { version: 7, totalCodewords: 196, ecPerBlock: 20, group1Blocks: 2, group1Data: 78, group2Blocks: 0, group2Data: 0 },
  { version: 8, totalCodewords: 242, ecPerBlock: 24, group1Blocks: 2, group1Data: 97, group2Blocks: 0, group2Data: 0 },
  { version: 9, totalCodewords: 292, ecPerBlock: 30, group1Blocks: 2, group1Data: 116, group2Blocks: 0, group2Data: 0 },
  { version: 10, totalCodewords: 346, ecPerBlock: 18, group1Blocks: 2, group1Data: 68, group2Blocks: 2, group2Data: 69 },
];

/** Alignment-pattern centres by version. Version 1 has none. */
const ALIGN_CENTRES: Record<number, readonly number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

export interface QrCode {
  /** Side length in modules, excluding the quiet zone. */
  readonly size: number;
  /** `true` means a dark module. Indexed `[y][x]`. */
  readonly modules: readonly (readonly boolean[])[];
}

/** How many data codewords a version holds at level L. */
function dataCapacity(spec: VersionSpec): number {
  return spec.group1Blocks * spec.group1Data + spec.group2Blocks * spec.group2Data;
}

/**
 * Encode text as a QR symbol.
 *
 * ⚠️ **Throws when the text does not fit.** See the note at the top of the file: a symbol that
 * carries the first 271 bytes of a URL is a symbol that scans and goes somewhere else.
 */
export function encodeQr(text: string): QrCode {
  const bytes = Array.from(new TextEncoder().encode(text));

  const spec = VERSIONS_L.find((candidate) => {
    /** 4 bits of mode + the character-count field, which is 8 bits up to version 9 and 16 after. */
    const headerBits = 4 + (candidate.version <= 9 ? 8 : 16);
    return bytes.length * 8 + headerBits <= dataCapacity(candidate) * 8;
  });

  if (spec === undefined) {
    throw new Error(
      `这段文字太长，放不进二维码（${String(bytes.length)} 字节，上限 271 字节）。`,
    );
  }

  const bits = buildDataBits(spec, bytes);
  const codewords = bitsToCodewords(bits, dataCapacity(spec));
  const finalCodewords = interleave(spec, codewords);

  return buildMatrix(spec, finalCodewords);
}

/** Mode indicator, character count, payload, terminator, and the alternating pad bytes. */
function buildDataBits(spec: VersionSpec, bytes: readonly number[]): boolean[] {
  const bits: boolean[] = [];
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push(((value >> i) & 1) === 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, spec.version <= 9 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  const capacityBits = dataCapacity(spec) * 8;
  /** Terminator: up to four zero bits, fewer only if the symbol is exactly full. */
  push(0, Math.min(4, capacityBits - bits.length));
  /** Pad to a whole codeword, then alternate 0xEC / 0x11. */
  while (bits.length % 8 !== 0) bits.push(false);
  let pad = 0xec;
  while (bits.length < capacityBits) {
    push(pad, 8);
    pad = pad === 0xec ? 0x11 : 0xec;
  }

  return bits;
}

function bitsToCodewords(bits: readonly boolean[], expected: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] === true ? 1 : 0);
    out.push(byte);
  }
  if (out.length !== expected) {
    throw new Error(`内部错误：数据码字 ${String(out.length)} 个，预期 ${String(expected)} 个。`);
  }
  return out;
}

/**
 * Split into blocks, compute each block's EC codewords, then interleave.
 *
 * ⚠️ **Interleaving is what makes a damaged symbol readable.** Data codewords are taken one per
 * block in turn, so **a scratch across the symbol damages a few codewords in every block** rather
 * than wiping out one block entirely — which is the whole point of having blocks.
 */
function interleave(spec: VersionSpec, data: readonly number[]): number[] {
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];

  let offset = 0;
  const layout = [
    { count: spec.group1Blocks, size: spec.group1Data },
    { count: spec.group2Blocks, size: spec.group2Data },
  ];

  for (const group of layout) {
    for (let i = 0; i < group.count; i += 1) {
      const block = data.slice(offset, offset + group.size);
      offset += group.size;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, spec.ecPerBlock));
    }
  }

  const out: number[] = [];
  const maxData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) out.push(block[i]!);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) out.push(block[i]!);
  }

  return out;
}

/** Build the module matrix: patterns, data placement, mask choice, format bits. */
function buildMatrix(spec: VersionSpec, codewords: readonly number[]): QrCode {
  const size = spec.version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  /** Function patterns must not be overwritten by data. */
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );

  const set = (x: number, y: number, dark: boolean): void => {
    modules[y]![x] = dark;
    reserved[y]![x] = true;
  };

  addFinder(set, size, 0, 0);
  addFinder(set, size, size - 7, 0);
  addFinder(set, size, 0, size - 7);
  addTiming(set, size);
  addAlignment(set, spec.version, size);
  /** The dark module, always at this position. */
  set(8, size - 8, true);
  reserveFormat(size, set);

  placeData(modules, reserved, codewords);

  const mask = chooseMask(modules, reserved, size);
  applyMask(modules, reserved, size, mask);
  writeFormat(modules, size, mask);

  return { size, modules };
}

function addFinder(
  set: (x: number, y: number, dark: boolean) => void,
  size: number,
  left: number,
  top: number,
): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const x = left + dx;
      const y = top + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const inRing = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const dark = inRing && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      set(x, y, dark);
    }
  }
}

function addTiming(set: (x: number, y: number, dark: boolean) => void, size: number): void {
  for (let i = 8; i < size - 8; i += 1) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }
}

function addAlignment(
  set: (x: number, y: number, dark: boolean) => void,
  version: number,
  size: number,
): void {
  const centres = ALIGN_CENTRES[version] ?? [];
  for (const cy of centres) {
    for (const cx of centres) {
      /** Skip the three corners, where a finder pattern already is. */
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
          set(cx + dx, cy + dy, dark);
        }
      }
    }
  }
}

/** The format-information modules, marked reserved so data placement skips them. */
function reserveFormat(size: number, set: (x: number, y: number, dark: boolean) => void): void {
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      set(i, 8, false);
      set(8, i, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    set(size - 1 - i, 8, false);
    set(8, size - 1 - i, false);
  }
}

/**
 * Walk the symbol in the standard's zig-zag and lay the bits down.
 *
 * ⚠️ **Two modules wide, upward then downward, skipping the vertical timing column** — and the
 * direction reversal is per column pair, not per column, which is the detail an implementation
 * gets wrong while still producing a plausible-looking symbol.
 */
function placeData(modules: boolean[][], reserved: boolean[][], codewords: readonly number[]): void {
  const size = modules.length;
  const bits: boolean[] = [];
  for (const codeword of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push(((codeword >> i) & 1) === 1);
  }

  let index = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the timing column is not a data column
    for (let step = 0; step < size; step += 1) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (reserved[y]![x] === true) continue;
        modules[y]![x] = index < bits.length ? bits[index]! : false;
        index += 1;
      }
    }
    upward = !upward;
  }
}

/**
 * The eight mask patterns from the standard.
 *
 * ⚠️ **Written as the standard writes them**, with the row/column convention stated once here and
 * used everywhere: `i` is the row, `j` is the column.
 */
const MASKS: readonly ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

function applyMask(modules: boolean[][], reserved: boolean[][], size: number, mask: number): void {
  const rule = MASKS[mask]!;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (reserved[y]![x] === true) continue;
      if (rule(y, x)) modules[y]![x] = !modules[y]![x];
    }
  }
}

/**
 * Pick the mask the standard's penalty rules like best.
 *
 * ⚠️ **The penalty rules are what stop a symbol that is half one colour**, which is the case a
 * camera handles worst. Choosing by the rules rather than by a fixed mask is **why a scanner can
 * find the symbol at an angle**.
 */
function chooseMask(modules: boolean[][], reserved: boolean[][], size: number): number {
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map((row) => [...row]);
    applyMask(candidate, reserved, size, mask);
    const score = penalty(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
  }

  return best;
}

function penalty(grid: readonly (readonly boolean[])[], size: number): number {
  let score = 0;

  /** Rule 1: runs of five or more in a row or column. */
  for (let i = 0; i < size; i += 1) {
    let runRow = 1;
    let runCol = 1;
    for (let j = 1; j < size; j += 1) {
      runRow = grid[i]![j] === grid[i]![j - 1] ? runRow + 1 : 1;
      if (runRow === 5) score += 3;
      else if (runRow > 5) score += 1;

      runCol = grid[j]![i] === grid[j - 1]![i] ? runCol + 1 : 1;
      if (runCol === 5) score += 3;
      else if (runCol > 5) score += 1;
    }
  }

  /** Rule 2: every 2×2 block of one colour. */
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const first = grid[y]![x];
      if (grid[y]![x + 1] === first && grid[y + 1]![x] === first && grid[y + 1]![x + 1] === first) {
        score += 3;
      }
    }
  }

  /** Rule 3: the finder-like pattern 1:1:3:1:1 with four light modules beside it. */
  const pattern = [true, false, true, true, true, false, true, false, false, false, false];
  const matches = (line: readonly boolean[], at: number, target: readonly boolean[]): boolean =>
    target.every((value, k) => line[at + k] === value);

  for (let i = 0; i < size; i += 1) {
    const row = grid[i]!;
    const col = grid.map((r) => r[i]!);
    for (let j = 0; j + 11 <= size; j += 1) {
      if (matches(row, j, pattern) || matches(row, j, [...pattern].reverse())) score += 40;
      if (matches(col, j, pattern) || matches(col, j, [...pattern].reverse())) score += 40;
    }
  }

  /** Rule 4: deviation from half dark. */
  let dark = 0;
  for (const row of grid) for (const cell of row) if (cell) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * The format information: error-correction level and mask, BCH-protected and XOR-masked.
 *
 * ⚠️ **The (L, mask 0) result is asserted in the test**, because a wrong BCH generator would still
 * produce a self-consistent symbol — **one that every scanner rejects.** See `qr.test.ts`.
 */
function formatBits(mask: number): number {
  const ecLevelL = 0b01;
  const data = (ecLevelL << 3) | mask;

  let value = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if (((value >> i) & 1) === 1) value ^= 0b10100110111 << (i - 10);
  }

  return ((data << 10) | value) ^ 0b101010000010010;
}

function writeFormat(modules: boolean[][], size: number, mask: number): void {
  const bits = formatBits(mask);
  const bitAt = (i: number): boolean => ((bits >> i) & 1) === 1;

  /** Copy one: around the top-left finder. */
  for (let i = 0; i <= 5; i += 1) modules[8]![i] = bitAt(i);
  modules[8]![7] = bitAt(6);
  modules[8]![8] = bitAt(7);
  modules[7]![8] = bitAt(8);
  for (let i = 9; i <= 14; i += 1) modules[14 - i]![8] = bitAt(i);

  /** Copy two: split between the other two finders. */
  for (let i = 0; i <= 7; i += 1) modules[size - 1 - i]![8] = bitAt(i);
  for (let i = 8; i <= 14; i += 1) modules[8]![size - 15 + i] = bitAt(i);
}
