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

/** The version, as displayed. Bump the last part when behaviour changes. */
export const APP_VERSION = "1.08.01";

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

  /**
   * ⚠️ **Rendered in local time, and the raw UTC value is shown beside it.**
   *
   * The owner read a build stamp of `2026-10-10T23:07:44.395Z` as "last night" and reported it
   * as stale — it was 07:07 that morning in his own timezone, and nine minutes old. **A value
   * that makes the reader draw the wrong conclusion is worse than no value**, so the screen
   * shows a local time a person recognises, and keeps the exact stamp for matching against a
   * build log.
   */
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const local =
    `${String(parsed.getFullYear())}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ` +
    `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;

  return `${local}（本机时间）`;
}
