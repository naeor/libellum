import { useLocation, useNavigate } from "react-router";

import { InnerPage } from "../components/Layouts.js";

/**
 * What the project promises, in the user's own words rather than the
 * repository's. Kept short: nobody reads a licence page, but everybody
 * deserves to be told plainly where their data goes.
 *
 * ⚠️ **The way back depends on how the reader arrived, and the owner reported the bug that shows why**
 * (2026-10-13): *"从关于退出会进到设置，从设置退出又会回到关于界面."* This screen is reachable from
 * 设置 **and** from the start page's footer, and a single hard-coded `backTo` made those two
 * indistinguishable — so the reader bounced between 关于 and 设置 instead of returning.
 *
 * ⚠️ **`state.from` is the caller saying where it came from**, and `useGoBack` prefers it over history
 * — see the long note there. **`backTo` stays as the deep-link fallback**, which is the only case it
 * was ever really for: somebody opening `/about` directly has no origin to honour.
 */
export function AboutPage(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();

  const declared = (location.state as { from?: unknown } | null)?.from;
  const from = typeof declared === "string" ? declared : null;

  return (
    <InnerPage
      title="关于 Libevra"
      subtitle="the free, open ledger"
      backTo={from ?? "/settings"}
    >
      <div className="flex flex-col gap-5 text-body-relaxed text-ink">
        <section className="rounded-card border border-line bg-surface p-5">
          <h2 className="font-medium">你的数据</h2>
          <p className="mt-2 text-muted">
            账目只保存在你自己部署的服务器上。应用不接入任何第三方统计、广告或分析服务，
            日志中不记录金额、备注与图片内容。
          </p>
        </section>

        <section className="rounded-card border border-line bg-surface p-5">
          <h2 className="font-medium">开源</h2>
          <p className="mt-2 text-muted">
            本项目以 AGPL-3.0 协议开源。源代码公开可查，任何人都可以自行部署。
          </p>
          {/**
            * ⚠️ **The repository moved with the brand, and this line has to land on the real one**
            * (2026-10-14, Libellum → Libevra). It said `…/libellum` while the remote still had that
            * name — **a link to a repository that does not exist is worse than an old one that
            * does.** The remote was renamed on 2026-10-14 and this line followed it in the same
            * version; GitHub keeps a redirect for the old slug, so old links still resolve.
            * The rename is recorded in `docs/开发过程记录/Libevra品牌迁移记录.md`.
            */}
          <p className="mt-2 text-muted">仓库地址：github.com/naeor/libevra</p>
        </section>

        <section className="rounded-card border border-line bg-surface p-5">
          <h2 className="font-medium">金额的处理方式</h2>
          <p className="mt-2 text-muted">
            金额以「分」为单位按整数保存与计算，不使用浮点数，避免出现分位误差。
            所有币种目前统一按两位小数记录，不同币种分开统计。
          </p>
        </section>
      </div>
    </InnerPage>
  );
}
