/**
 * Date and time helpers.
 *
 * Everything here works in the **user's own calendar**. The server stores the
 * local date and the IANA zone alongside the instant, so no other part of the
 * system has to guess what "today" meant to the person who recorded an entry.
 */

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** The browser's IANA zone, e.g. `Asia/Shanghai`. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** `YYYY-MM-DD` on the user's calendar. */
export function toLocalDate(date: Date): string {
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Full ISO 8601 including the local UTC offset. */
export function toLocalIso(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);

  return (
    `${toLocalDate(date)}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.000` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

/** `YYYY-MM` of the user's current month. */
export function currentMonth(now: Date = new Date()): string {
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}`;
}

export function shiftMonth(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;

  return currentMonth(new Date(year, index + delta, 1));
}

export function formatMonthLabel(month: string): string {
  return `${String(Number(month.slice(0, 4)))} 年 ${String(Number(month.slice(5, 7)))} 月`;
}

/** `今天` / `昨天` / `10月8日 周三` — the heading a day's entries sit under. */
export function formatDayLabel(localDate: string, today: Date = new Date()): string {
  if (localDate === toLocalDate(today)) return "今天";

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (localDate === toLocalDate(yesterday)) return "昨天";

  const [year, month, day] = localDate.split("-").map(Number);
  const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()] ?? "";

  const prefix = date.getFullYear() === today.getFullYear() ? "" : `${String(date.getFullYear())} 年 `;

  return `${prefix}${String(month ?? 0)} 月 ${String(day ?? 0)} 日 ${weekday}`;
}

/** `YYYY-MM-DDTHH:mm:ss` for an `<input type="datetime-local">`, in local time. */
export function toDateTimeLocalValue(date: Date): string {
  return (
    `${toLocalDate(date)}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Read back what the browser put in a `datetime-local` field.
 *
 * `new Date("2026-10-09T14:30:00")` without an offset is parsed as **local**
 * time, which is exactly what the field holds. Returns null for input the
 * browser could not parse, so the caller can keep the previous value rather
 * than silently recording the wrong moment.
 */
export function fromDateTimeLocalValue(value: string): Date | null {
  if (value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A time zone as an offset, in the form a person recognises: `UTC+8`, `UTC-7`.
 *
 * ⚠️ **The owner asked for this because the alternative is a lie of omission**:
 * "把那个时区从 asia shanghai 之类的改成具体的时区（UTC+8 这样的）标准名称."
 *
 * A ledger that says `19:34` without saying *where* that clock is loses the one piece of information a
 * traveller needs. **He is in California (UTC-7) and his entries are recorded in UTC+8** — so the times on
 * screen are correct and the *order* looked wrong, because two entries hours apart look identical without
 * their zones. Nothing was broken; something was missing.
 *
 * ⚠️ **An offset rather than a name, because a name is ambiguous and an offset is not.** `Asia/Shanghai`
 * tells the reader nothing they can check; `UTC+8` can be compared against the device's own clock at a
 * glance. It also survives the zone database changing its mind about a region's abbreviation.
 *
 * Returns an empty string when the zone is unusable, so a caller can simply show nothing rather than
 * `Invalid/Zone`.
 */
export function zoneOffsetLabel(iso: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    }).formatToParts(new Date(iso));

    const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "";

    /**
     * `longOffset` gives `GMT+08:00`. Trimmed to `UTC+8`: the minutes are dropped when they are zero
     * because most zones are whole hours and the trailing `:00` is noise — **and when they are not zero,
     * they matter and are kept.**
     */
    const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);

    if (match === null) return name === "GMT" ? "UTC" : "";

    const [, sign, hours, minutes] = match;

    /**
     * ⚠️ **The hours are parsed, not passed through.** `longOffset` renders `GMT+08:00`, and `UTC+08`
     * reads like a padded identifier rather than a clock offset — **the form people write is `UTC+8`.**
     */
    const wholeHours = String(Number(hours));

    /**
     * ⚠️ **Zero is `UTC`, not `UTC+0`.** Someone in London reading their own entries should not see a
     * signed offset — **it implies they are somewhere else.** The bare name is what a zero offset is called.
     */
    if (wholeHours === "0" && (minutes === undefined || minutes === "00")) return "UTC";

    return `UTC${sign}${wholeHours}${minutes === undefined || minutes === "00" ? "" : `:${minutes}`}`;
  } catch {
    return "";
  }
}

/** `HH:mm` in the zone the entry was recorded in. */
export function formatTimeInZone(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    }).format(new Date(iso));
  } catch {
    return "";
  }
}

/**
 * `HH:mm UTC+8`, with the zone shown only when it differs from the reader's.
 *
 * ⚠️ **Shown only when it differs, because otherwise it is noise on every row** — and noise on every row
 * is how a label stops being read. **When it does differ it is the most important thing on the line**,
 * because an entry recorded in another time zone is exactly when a bare clock reading misleads.
 */
export function formatTimeWithZone(iso: string, timeZone: string): string {
  const time = formatTimeInZone(iso, timeZone);
  if (time === "") return "";

  const own = localTimeZone();

  if (own === timeZone) return time;

  const label = zoneOffsetLabel(iso, timeZone);

  return label === "" ? time : `${time} ${label}`;
}

export function formatDateTimeInZone(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
