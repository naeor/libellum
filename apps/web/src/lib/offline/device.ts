import { readValue, writeValue } from "./storage.js";

/**
 * Which device this is.
 *
 * ⚠️ **Needed because the conflict record has to say who said what** — the owner asked for it by name:
 * "最好还能记录冲突是哪两台设备传上来的，他们传出来的结果分别是什么."
 *
 * ⚠️ **A device, not a user.** One account is expected to be on several devices, and the whole conflict design
 * treats them as **"本质上都是同一个用户"** — the point of recording which device sent what is to be able to read
 * the history afterwards, **not to identify a person.**
 *
 * ⚠️ **Deliberately not a fingerprint and not stable across clears.** It is a random id written once into this
 * device's own storage; wiping the app's data gives the device a new one. **That is the honest behaviour** — a
 * "device" here means "this browser profile's copy of the ledger", and a wiped copy is a new one.
 */
const DEVICE_KEY = "device-id";

let cached: string | null = null;

/** This device's id, creating one on first use. */
export async function deviceId(): Promise<string> {
  if (cached !== null) return cached;

  const stored = await readValue<string>(DEVICE_KEY);

  if (typeof stored === "string" && stored.length > 0) {
    cached = stored;

    return cached;
  }

  /**
   * ⚠️ **`crypto.randomUUID` when it exists, and a plain random string when it does not.** This runs on the
   * device that has caused every problem in this project, and **a missing API must not mean a missing device id** —
   * an empty id would put every device under the same name in a conflict record.
   */
  const created =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  await writeValue(DEVICE_KEY, created);
  cached = created;

  return created;
}
