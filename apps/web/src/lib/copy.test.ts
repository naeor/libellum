import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The wording the owner asked for, pinned.
 *
 * These are not tests of behaviour; they are tests of **register**. The owner
 * asked for the interface to read as objective description — the tone of a
 * system settings screen — rather than as a person talking. A rule like that
 * is invisible in a diff and erodes with the next edit, so the specific
 * sentences are asserted here and the reason is written next to each one.
 */
function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("analysis screen copy", () => {
  it("describes itself as a computed result", () => {
    // Was "把账目变成看得懂的图。" — warm, but it describes a feeling rather
    // than saying what the screen is.
    expect(source("../pages/StatsPage.tsx")).toContain("以下结果由已记录的账目计算得出。");
  });

  it("does not explain exchange rates where none are applied", () => {
    // The owner asked for this sentence to go: stating that no conversion
    // happens is noise on a screen that does not convert anything.
    expect(source("../pages/StatsPage.tsx")).not.toContain("不进行汇率换算");
    expect(source("../pages/AddEntryPage.tsx")).not.toContain("不进行汇率换算");
  });
});

describe("collaborators copy", () => {
  it("invites rather than describes togetherness", () => {
    expect(source("../pages/PlaceholderPages.tsx")).toContain("邀请他人一同管理账目。");
    expect(source("../pages/PlaceholderPages.tsx")).not.toContain("和他人一起维护同一本账");
  });
});

describe("account copy", () => {
  it("separates what may be shared from what must not be", () => {
    const me = source("../pages/MePage.tsx");

    // One sentence used to run the two together with a semicolon, which reads
    // as a single thought. They are opposite instructions and are now two.
    expect(me).toContain("可安全地分享给他人");
    expect(me).toContain("请勿向任何人透露恢复码");
    expect(me).not.toContain("恢复码必须保密");
  });
});

describe("archive copy", () => {
  it("says what archiving does, to the thing being archived", () => {
    const manage = source("../pages/ManagePages.tsx");

    expect(manage).toContain("归档后不再出现在记账选项中");
    expect(manage).not.toContain("归档后不再出现在记账选项里");
  });
});

describe("register", () => {
  it("keeps colloquial phrasing out of the screens checked above", () => {
    // The owner's note on an earlier message: "金额都是 0" reads like a person
    // talking. The same words should not creep back in elsewhere.
    const screened = [
      "../pages/StatsPage.tsx",
      "../pages/ManagePages.tsx",
      "../pages/MePage.tsx",
      "../pages/SettingsPage.tsx",
      "../pages/PlaceholderPages.tsx",
      "../pages/BooksPage.tsx",
    ];

    for (const file of screened) {
      const text = source(file);

      for (const colloquial of ["都是 0", "还没有", "没什么", "搞定", "挺好的"]) {
        expect(text, `${file} contains 「${colloquial}」`).not.toContain(colloquial);
      }
    }
  });
});
