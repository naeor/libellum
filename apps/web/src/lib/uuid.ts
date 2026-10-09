/**
 * UUID v7, generated in the browser.
 *
 * The first 48 bits are a millisecond timestamp, so ids sort by creation time
 * — which matters twice over: PostgreSQL indexes them in insertion order
 * instead of scattering writes across the whole B-tree, and an offline device
 * can create an entry immediately without waiting for the server to assign an
 * identity.
 *
 * Hand-written rather than pulled from a package: it is fifteen lines, and a
 * dependency for fifteen lines is a dependency to audit forever.
 */
export function uuidV7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // Version 7 in the high nibble, RFC 4122 variant in the top two bits.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
