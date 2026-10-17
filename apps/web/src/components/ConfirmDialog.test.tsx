import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConfirmDialog } from "./ConfirmDialog.js";

/**
 * The confirmation every destructive action goes through.
 *
 * ⚠️ **The regression this exists for (1.13.02).** S13's console passes its reason and
 * password inputs as `children`, and the component's type declared them — but the markup
 * never rendered them. The dialog therefore offered a confirmation with no way to supply
 * the two things the confirmation required. **A declared prop that callers pass is not
 * rendered until something proves it is**, and a type cannot be the proof.
 *
 * Static rendering is enough for "is it in the document, and in the right order". Focus
 * behaviour needs a DOM and is not covered here; that is stated rather than implied.
 */
function render(extra: { readonly open?: boolean } = {}): string {
  return renderToStaticMarkup(
    <ConfirmDialog
      open={extra.open ?? true}
      title="作废邀请码？"
      description="GTK7-••••-••••"
      consequences={["作废后这个码不能再被用来注册。"]}
      confirmLabel="作废"
      onConfirm={() => undefined}
      onCancel={() => undefined}
    >
      <label htmlFor="reason">原因（会记进操作记录）</label>
      <input id="reason" defaultValue="" />
      <label htmlFor="password">你的密码（二次验证）</label>
      <input id="password" type="password" defaultValue="" />
    </ConfirmDialog>,
  );
}

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    expect(render({ open: false })).toBe("");
  });

  it("renders the fields it was given", () => {
    const html = render();

    expect(html).toContain('id="reason"');
    expect(html).toContain('id="password"');
    expect(html).toContain("原因（会记进操作记录）");
    expect(html).toContain("你的密码（二次验证）");
  });

  it("puts the fields between the consequences and the buttons", () => {
    const html = render();
    const consequence = html.indexOf("作废后这个码不能再被用来注册。");
    const reason = html.indexOf('id="reason"');
    const cancel = html.indexOf("取消");

    expect(consequence).toBeGreaterThanOrEqual(0);
    expect(reason).toBeGreaterThan(consequence);
    expect(cancel).toBeGreaterThan(reason);
  });

  it("announces itself as an alert dialog", () => {
    const html = render();

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("作废邀请码？");
  });
});
