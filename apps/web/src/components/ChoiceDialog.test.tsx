import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ChoiceDialog, type Choice } from "./ChoiceDialog.js";

/**
 * The dialog that offers ways forward instead of picking one.
 *
 * Static rendering covers the *content* — which options exist, what they say,
 * which one is primary. The keyboard and backdrop behaviour needs a DOM and is
 * not covered here; that is stated rather than implied.
 */
type Id = "retry" | "manual" | "back";

const CHOICES: readonly Choice<Id>[] = [
  { id: "retry", label: "再试一次", hint: "用同一张图重新识别", primary: true },
  { id: "manual", label: "改为手动记账" },
  { id: "back", label: "返回拍照页", dismissive: true },
];

function render(props: Partial<Parameters<typeof ChoiceDialog<Id>>[0]> = {}): string {
  return renderToStaticMarkup(
    <ChoiceDialog
      open
      title="没能读出这张截图的信息"
      description="可以再试一次，或改为手动填写。"
      choices={CHOICES}
      onChoose={() => undefined}
      {...props}
    />,
  );
}

describe("ChoiceDialog", () => {
  it("renders nothing when closed", () => {
    expect(render({ open: false })).toBe("");
  });

  it("offers every option it was given", () => {
    const html = render();

    for (const choice of CHOICES) expect(html).toContain(choice.label);
  });

  it("says what the non-obvious option does", () => {
    // "再试一次" is ambiguous — same picture, or a new one? A hint is cheaper
    // than a support question.
    expect(render()).toContain("用同一张图重新识别");
  });

  it("marks exactly one option as primary", () => {
    const html = render();

    expect(html.split("bg-brand text-white").length - 1).toBe(1);
  });

  it("announces itself as a dialog and names itself", () => {
    // Not `alertdialog`: nothing here needs to interrupt, it needs an answer.
    const html = render();

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("没能读出这张截图的信息");
  });

  it("has no separate close affordance", () => {
    // Dismissal is one of the options; a close button beside a "go back" option
    // presents the same choice twice and raises the question of how they differ.
    expect(render()).not.toContain("✕");
  });

  it("copes with a single option", () => {
    const html = render({ choices: [{ id: "back", label: "返回", dismissive: true }] });

    expect(html).toContain("返回");
  });

  it("does not decide anything on its own", () => {
    // The point of the component: it renders choices, and calling one is the
    // caller's job. If it ever grew a default, that default would be the
    // decision the owner said not to make.
    const onChoose = vi.fn();
    renderToStaticMarkup(
      <ChoiceDialog
        open
        title="t"
        description="d"
        choices={CHOICES}
        onChoose={onChoose}
      />,
    );

    expect(onChoose).not.toHaveBeenCalled();
  });
});
