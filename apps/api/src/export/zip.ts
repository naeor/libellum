import { deflateRawSync } from "node:zlib";

/**
 * A minimal, correct ZIP writer — enough for one XLSX, and no more.
 *
 * Why not a package: the project already writes its own UUID v7 (fifteen lines),
 * its own SVG charts and its own Markdown converter, because a dependency is
 * something you have to audit to know what it does. An XLSX is a ZIP holding a
 * handful of XML files, which makes "write the ZIP" about a hundred lines of
 * well-specified code — and those hundred lines are testable in a way that a
 * transitive tree of a spreadsheet library is not.
 *
 * What is implemented: stored and deflated entries, CRC-32, sizes, local file
 * headers, a central directory, and the end-of-central-directory record. What is
 * not: ZIP64, encryption, data descriptors, multi-disk. None of them can arise
 * for a file this size, and the last three are refusal-worthy anyway.
 *
 * The one thing worth being careful about: ZIP stores *local* header values
 * (offsets, sizes) in two places, and a reader trusts the central directory. If
 * the two disagree the file opens in one program and not another, which is a
 * miserable thing to debug — so `buildZip` writes both from a single pass over
 * the same data.
 */

// ---------------------------------------------------------------------------
// CRC-32, the checksum every ZIP entry carries
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Little-endian helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

export interface ZipEntry {
  readonly name: string;
  readonly data: string | Uint8Array;
}

/**
 * Build a ZIP archive.
 *
 * Timestamps are fixed rather than taken from the clock: the same input must
 * produce the same bytes, otherwise every export would look like a new file to
 * a diff, a cache or a checksum, and a test could not compare two archives.
 */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const raw = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;

    const deflated = deflateRawSync(Buffer.from(raw), { level: 9 });
    // Storing is only worth it when deflating made things bigger.
    const stored = deflated.length >= raw.length;
    const body = stored ? Buffer.from(raw) : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);

    const localHeader = Buffer.from([
      ...u32(0x04034b50), // local file header signature
      ...u16(20), // version needed to extract (2.0)
      ...u16(0), // flags
      ...u16(method), // compression method
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(body.length), // compressed size
      ...u32(raw.length), // uncompressed size
      ...u16(nameBytes.length),
      ...u16(0), // extra field length
      ...nameBytes,
    ]);

    localParts.push(localHeader, body);

    const centralHeader = Buffer.from([
      ...u32(0x02014b50), // central directory header signature
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(method),
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(body.length),
      ...u32(raw.length),
      ...u16(nameBytes.length),
      ...u16(0), // extra field length
      ...u16(0), // comment length
      ...u16(0), // disk number
      ...u16(0), // internal attributes
      ...u32(0), // external attributes
      ...u32(offset), // offset of the local header
      ...nameBytes,
    ]);

    centralParts.push(centralHeader);
    offset += localHeader.length + body.length;
  }

  const centralDirectory = Buffer.concat(centralParts);

  const end = Buffer.from([
    ...u32(0x06054b50), // end of central directory signature
    ...u16(0), // disk number
    ...u16(0), // disk with central directory
    ...u16(entries.length), // entries on this disk
    ...u16(entries.length), // entries in total
    ...u32(centralDirectory.length),
    ...u32(offset),
    ...u16(0), // comment length
  ]);

  return Buffer.concat([...localParts, centralDirectory, end]);
}
