import { useLocation } from "react-router";

import { InnerPage } from "../components/Layouts.js";

/**
 * **隐私政策 / 使用条款 —— 页面存在，内容尚未编写。**
 *
 * ⚠️ **Why these pages exist at all, given there is nothing in them.** The owner asked for all three
 * footer items to be tappable (2026-10-13): *"把他们仨放到屏幕的最底下。并且颜色都是灰色，只是点击可以跳转."*
 * **A tappable item that goes nowhere is worse than a label**, so each gets a real route.
 *
 * ⚠️ **⚠️ And each one says plainly that the text is not written yet.** The owner attached this
 * condition to the same section earlier: *"如果尚未准备正式内容，可以先建立合理的页面和文案结构，但
 * **不要编造已经具备法律效力的条款**，也不要未经确认就宣称符合某项法规."*
 *
 * So this page is **not a stub policy and not a placeholder paragraph** — it is a page whose content is
 * the honest statement that the document does not exist, plus what it will have to cover. **Invented
 * terms would be worse than no terms**, because a reader cannot tell a drafted clause from a real one.
 *
 * ⚠️ **It lists what must be settled before launch**, drawn from what this app actually does and does
 * not do — which is the useful half of the job and the part that can be written without a lawyer.
 * **Nothing here claims compliance with any regulation**, and nothing should be added that does.
 */

/** The two documents, and what each will have to cover. */
const DOCUMENTS = {
  privacy: {
    title: "隐私政策",
    lede: "这一页还没有内容。下面是上线前必须写清楚的事项——不是条款草案，是一份待办清单。",
    questions: [
      "账目、备注、照片与语音分别存在哪里，保留多久，由谁运营的服务器承载。",
      "拍照与语音识别在设备本机完成还是传到服务器；如果传输，传了什么、留不留。",
      "诊断日志记录什么。目前的设计是不记录金额、备注与图片内容，这一点需要逐条核实后写进正文。",
      "数据导出与删除的途径，以及账号注销后各类数据分别如何处理。",
      "Cookie 与本地存储的用途。会话 Cookie 是必需的；其它本地存储用于离线缓存与界面偏好。",
      "是否接入任何第三方服务。当前没有统计、广告或分析服务，若将来引入，本节需同步更新。",
    ],
  },
  terms: {
    title: "使用条款",
    lede: "这一页还没有内容。下面是上线前必须写清楚的事项——不是条款草案，是一份待办清单。",
    questions: [
      "服务以何种形式提供（自建部署还是托管），可用性上作不作承诺。",
      "账号与邀请码的发放规则、有效期，以及滥用时的处置方式。",
      "共享账本中各位成员的数据归属：谁可以看、谁可以改、退出后各自留下什么。",
      "备份与数据丢失的责任边界。",
      "开源许可（AGPL-3.0）与使用条款之间的关系。",
      "服务变更或终止时，用户如何取回自己的数据。",
    ],
  },
} as const;

export function LegalPage({ kind }: { readonly kind: keyof typeof DOCUMENTS }): React.JSX.Element {
  const location = useLocation();
  const document = DOCUMENTS[kind];

  /**
   * ⚠️ **The same declared-origin rule as `AboutPage`**, so 返回 goes back to the start page when the
   * footer was the way in — and to 设置 when it was reached from there. **Both of these are in the
   * footer, so without this they would inherit the same bounce the owner just reported.**
   */
  const declared = (location.state as { from?: unknown } | null)?.from;
  const from = typeof declared === "string" ? declared : null;

  return (
    <InnerPage title={document.title} subtitle="尚未编写" backTo={from ?? "/settings"}>
      <div className="flex flex-col gap-5 text-body-relaxed text-ink">
        <section className="rounded-card border border-line bg-surface p-5">
          {/**
            * ⚠️ **Said first and plainly.** Somebody who taps 隐私政策 wants to know what happens to
            * their data; the second-best answer is **an accurate statement that the document is not
            * written**, and the worst is a paragraph that looks like a policy and is not one.
            */}
          <p className="text-muted">{document.lede}</p>
        </section>

        <section className="rounded-card border border-line bg-surface p-5">
          <h2 className="font-medium">上线前需要写清楚的事</h2>
          <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-muted">
            {document.questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </section>

        <p className="text-helper-relaxed text-muted">
          项目尚未上线。这两份文档会在正式提供对外服务之前补齐，
          并由所有者确认后再对外声明——在此之前，此页不会出现任何未经确认的条款。
        </p>
      </div>
    </InnerPage>
  );
}
