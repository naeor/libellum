import { useNavigate } from "react-router";

import { InnerPage } from "../components/Layouts.js";

/**
 * What the project promises, in the user's own words rather than the
 * repository's. Kept short: nobody reads a licence page, but everybody
 * deserves to be told plainly where their data goes.
 */
export function AboutPage(): React.JSX.Element {
  const navigate = useNavigate();

  return (
    <InnerPage title="关于 Libellum" subtitle="the free, open ledger" backTo="/settings">
      <div className="flex flex-col gap-5 text-sm leading-relaxed text-ink">
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
          <p className="mt-2 text-muted">仓库地址：github.com/naeor/libellum</p>
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
