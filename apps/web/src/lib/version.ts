/**
 * What version of the program this is.
 *
 * ⚠️ **The owner asked for a scheme and supplied it**: "我们现在假设当前版本 1.08.01（1表示这是
 * 整个计账项目的第一次开发，08表示正在开发S8，01表示是开发S8中的第一个版本）."
 *
 * Three parts, each with a meaning that can be read off the number without a lookup — which is
 * the whole point, and which most version schemes do not achieve:
 *
 * | 段 | 含义 |
 * |---|---|
 * | **1** | 第几次整体开发。**只有在"从头再做一遍"时才变** |
 * | **08** | 正在开发哪个阶段（S8）。**与 `ROADMAP.md` 的阶段号一致** |
 * | **01** | 该阶段里的第几版。**改到用户看得见的行为就 +1** |
 *
 * ⚠️ **Every update bumps the last part, and the owner made that a rule**: "以后你每次更新
 * 一次，就把版本号加1." A version that does not move cannot be used to tell two builds apart, which
 * is the only thing it is for — and this project lost three rounds to exactly that.
 *
 * ⚠️ **The middle part matching the roadmap's stage number is the useful half.** It means the
 * answer to "which stage is this build from" is written on the screen, and the answer to "what
 * is in it" is one section of one document away — where a version like `1.4.2` would require a
 * lookup that nobody performs.
 *
 * ⚠️ **`BUILD_STAMP` is separate and stays separate.** The version says which *release* this is
 * and changes when somebody decides it does; the stamp says when *this particular bundle* was
 * built and changes on every build. **A diagnostic needs both**: the version to know what was
 * intended, the stamp to know whether the intended thing actually arrived — which is the
 * question that cost three rounds.
 */

/**
 * The version, as displayed. Bump the last part when behaviour changes.
 *
 * ⚠️ **The middle part moved from 08 to 09** on 2026-10-12: S8 (offline) is
 * finished and this build is the first of **S9 (collaboration and multiple
 * ledgers)**. That is the whole point of the middle segment — "which stage is
 * this build from" is readable on screen, and the answer needs no lookup.
 */
export const APP_VERSION = "1.09.68";

/**
 * When this bundle was built.
 *
 * Injected by `vite.config.ts`. Falls back rather than throwing, because a version string is
 * never worth breaking the program over.
 */
export function buildStamp(): string {
  try {
    return __BUILD_STAMP__;
  } catch {
    return "(未知)";
  }
}

/** The build time in the reader's own timezone, for a screen a person looks at. */
export function buildStampLocal(): string {
  const stamp = buildStamp();
  const parsed = new Date(stamp);

  if (Number.isNaN(parsed.getTime())) return stamp;

  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const local =
    `${String(parsed.getFullYear())}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ` +
    `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;

  /**
   * ⚠️ **The zone offset is printed, and the first version not printing it caused a false alarm.**
   *
   * The owner read a local rendering of `2026-10-10 16:18:01` beside a UTC value of
   * `2026-10-10T23:18:01Z` and reasonably asked why they disagreed — the device he was holding is
   * **not** on the +08:00 the rest of this project assumes, and nothing on the screen said so.
   *
   * **A time without its zone cannot be checked against anything.** With the offset printed, both
   * numbers can be reconciled by hand in one step, and "which build is this" stops depending on
   * knowing which device you are holding.
   */
  const offsetMinutes = -parsed.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const hours = Math.floor(Math.abs(offsetMinutes) / 60);
  const minutes = Math.abs(offsetMinutes) % 60;
  const zone = `UTC${sign}${String(hours)}${minutes === 0 ? "" : `:${pad(minutes)}`}`;

  return `${local}（本机时间 ${zone}）`;
}
