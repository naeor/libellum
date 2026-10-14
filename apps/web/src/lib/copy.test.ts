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

/**
 * **Only the text a user can read.**
 *
 * ⚠️ **Comments are removed, and that is not a technicality.** The code in these files *quotes the
 * owner's own instructions* — including the words of the flow that was removed — so that a reader can
 * see why the code looks the way it does. A rule checked against raw source would forbid the code
 * from explaining its own history, and **the honest fix would then be to delete the explanation**,
 * which is the opposite of what the documentation rules ask for.
 *
 * So this strips comments and returns what is left: the strings, the JSX text, the attributes. **The
 * register rules were always about the interface** — see the file header — and this is what makes the
 * check mean that.
 */
function visibleText(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "") // /* … */ and /** … */ blocks
    .replace(/^\s*\/\/.*$/gm, ""); // whole-line // comments
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

describe("invitation copy", () => {
  /**
   * ⚠️ **`CollaboratorsPage.tsx` no longer exists (1.10.05), and this test is what would have
   * noticed it silently.** The account-level collaborator screen was removed on the owner's
   * instruction; its subject matter — inviting somebody into a ledger — moved to
   * `LedgerInvitePage.tsx`. **What matters is the wording, not which file holds it**, and that is
   * exactly what the old assertion said about the move before this one.
   */
  it("invites rather than describes togetherness", () => {
    const invite = source("../pages/LedgerInvitePage.tsx");

    // The screen says what pressing the button does, and to whom.
    expect(invite).toContain("发送邀请");
    expect(invite).toContain("接受之后才真正加入");
  });

  /**
   * ⚠️ **⚠️ The old flow's instructions must not survive anywhere.** The owner's requirement is
   * explicit: *"请检查所有因业务逻辑改变而过时的按钮、标题、提示和说明，不允许留下「必须先成为
   * 协作者」之类已经不符合新规则的文案."*
   *
   * This is the assertion that keeps that true. The invite screen used to say *"在「协作者」页面按对方
   * 账号编号找到他"* and its button pointed at `/collaborators` — a screen that no longer exists, so
   * the sentence would have been a dead end.
   *
   * ⚠️ **Checked against `visibleText`, not raw source**, so these files may still explain the flow
   * they replaced — see the note on that helper.
   */
  it("leaves no instruction to become a collaborator first", () => {
    const screens = [
      "../pages/LedgerPage.tsx",
      "../pages/LedgerInvitePage.tsx",
      "../pages/LedgerSubPages.tsx",
      "../pages/MessageBoardPage.tsx",
    ];

    for (const file of screens) {
      const text = visibleText(file);

      for (const retired of ["协作者", "去邀请", "/collaborators"]) {
        expect(text, `${file} shows 「${retired}」 to the user`).not.toContain(retired);
      }
    }
  });
});

describe("account copy", () => {
  it("separates what may be shared from what must not be", () => {
    // Moved to the profile screen when the account screen was rebuilt, which
    // this test caught. What matters is the wording, not which file holds it.
    const profile = source("../pages/ProfilePage.tsx");

    // One sentence used to run the two together with a semicolon, which reads
    // as a single thought. They are opposite instructions and are now two.
    expect(profile).toContain("可安全地分享给他人");
    expect(profile).toContain("请勿向任何人透露恢复码");
    expect(profile).not.toContain("恢复码必须保密");
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
      "../pages/ProfilePage.tsx",
      "../pages/SettingsPage.tsx",
      "../pages/LedgerSpacePage.tsx",
      /**
       * ⚠️ **`LedgerInvitePage` replaces the removed `CollaboratorsPage` in this list (1.10.05)** —
       * it is now the screen the invite wording lives on, so it inherits the same register rule.
       */
      "../pages/LedgerInvitePage.tsx",
    ];

    for (const file of screened) {
      /**
        * ⚠️ **`visibleText`, for the same reason the invitation check uses it** — see the note on that
        * helper. These files legitimately *quote* the phrasing they are avoiding, so that the next
        * reader can see what was rejected and why. Checking raw source would fail on the explanation
        * and the fix would be to delete it, **which is the opposite of what the documentation rules
        * ask for.** What the rule is actually about is what the user reads.
        */
      const text = visibleText(file);

      for (const colloquial of ["都是 0", "还没有", "没什么", "搞定", "挺好的"]) {
        expect(text, `${file} shows 「${colloquial}」 to the user`).not.toContain(colloquial);
      }
    }
  });
});
