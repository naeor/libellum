import { CURRENCIES, type Currency } from "@libellum/shared";
import { useState } from "react";
import { useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { InnerPage } from "../components/Layouts.js";
import { useAuth } from "../auth/AuthProvider.js";
import { errorMessage } from "../lib/api.js";
import { currencyName } from "../lib/format.js";
import { useUpdatePreferences } from "../lib/queries.js";
import { useAdminEntry } from "../lib/admin.js";

interface Row {
  readonly label: string;
  readonly hint?: string;
  readonly to?: string;
}

/** Section of tappable rows; `to` absent means "not available yet". */
function RowList({ rows, onNavigate }: { readonly rows: readonly Row[]; readonly onNavigate: (to: string) => void }): React.JSX.Element {
  return (
    <ul className="overflow-hidden rounded-card border border-line bg-surface">
      {rows.map((row) => (
        <li key={row.label}>
          <button
            type="button"
            disabled={row.to === undefined}
            onClick={() => {
              if (row.to !== undefined) onNavigate(row.to);
            }}
            className="flex w-full items-center justify-between gap-4 border-b border-line px-5 py-4 text-left transition last:border-b-0 enabled:hover:bg-canvas disabled:cursor-default"
          >
            <span className="flex flex-col gap-0.5">
              <span className={`text-sm ${row.to === undefined ? "text-muted" : "text-ink"}`}>
                {row.label}
              </span>
              {row.hint ? <span className="text-helper text-muted">{row.hint}</span> : null}
            </span>
            <span className="shrink-0 text-helper text-muted">
              {row.to === undefined ? "后续开放" : "›"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Settings.
 *
 * The categories, payment methods and tags screens are real, and so is the
 * default currency; the rest are listed and marked "后续开放" rather than
 * hidden, so their absence is a stated fact instead of something the user has
 * to wonder about.
 */
export function SettingsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { user } = useAuth();
  const preferences = useUpdatePreferences();

  const go = (to: string): void => void navigate(to);
  const [saved, setSaved] = useState(false);

  const current: Currency = user?.defaultCurrency ?? "CNY";

  return (
    <InnerPage title="设置" backTo="/me">
      <section className="flex flex-col gap-2">
        <h2 className="px-1 text-helper text-muted">记账偏好</h2>

        <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5">
          <div className="flex flex-col gap-1">
            <span className="text-body text-ink">默认币种</span>
            <span className="text-helper-relaxed text-muted">
              该币种将排在所有币种列表的最前。汇率折算功能开放后，其它币种默认折算为该币种。
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {CURRENCIES.map((option) => (
              <button
                key={option}
                type="button"
                disabled={preferences.isPending}
                onClick={() => {
                  setSaved(false);
                  preferences.mutate(
                    { defaultCurrency: option },
                    { onSuccess: () => { setSaved(true); } },
                  );
                }}
                className={`rounded-full px-4 py-2 text-sm transition disabled:opacity-45 ${
                  current === option ? "bg-brand text-white" : "bg-canvas text-muted hover:text-ink"
                }`}
              >
                {currencyName(option)}
              </button>
            ))}
          </div>

          {preferences.isError ? <Alert tone="error">{errorMessage(preferences.error)}</Alert> : null}
          {saved && !preferences.isPending ? (
            <p className="text-helper text-brand-dark">已保存。</p>
          ) : null}
        </div>

        <RowList
          rows={[
            { label: "大键盘输入金额", hint: "使用应用内的大号数字键盘" },
            { label: "沿用上一笔", hint: "新建记录时自动填入上次使用的分类等信息" },
            { label: "登录后直接开始记账", hint: "跳过明细页，直接进入记账界面" },
            { label: "币种显示顺序", hint: "默认币种固定排在最前" },
            { label: "主界面按钮位置", hint: "左手 / 右手" },
          ]}
          onNavigate={go}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="px-1 text-helper text-muted">显示与数据</h2>
        <RowList
          rows={[
            { label: "语言", hint: "中文 / English" },
            { label: "主题色" },
            { label: "汇率折算", hint: "将各币种折算为一种货币后统计" },
            { label: "导出数据", hint: "CSV / Excel" },
            { label: "导入历史账", hint: "从 CSV 批量导入" },
          ]}
          onNavigate={go}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="px-1 text-helper text-muted">账号安全</h2>
        <RowList
          rows={[
            { label: "更改密码", hint: "修改后，其它设备上的登录状态将失效", to: "/settings/password" },
            { label: "生成新的恢复码", hint: "生成后，原有恢复码将立即失效", to: "/settings/recovery-code" },
            /**
             * ⚠️ **The owner asked for the referral code to become an entry of its own here**
             * (2026-10-13): *"账户里边生成邀请码单独包装成一个入口，放到设置-账号安全里面."*
             *
             * ⚠️ **It belongs in this section rather than under 显示与数据 or 记账偏好**, because it
             * is about **the account** — like 密码 and 恢复码 — and about no ledger and no preference.
             * The hint keeps the distinction the owner drew visible at the point of choice: a code
             * **注册账号**, it does not put anybody into a ledger.
             */
            {
              label: "邀请码",
              hint: "让别人注册 Libevra 账号，与你的账本无关",
              to: "/settings/referral-codes",
            },
          ]}
          onNavigate={go}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="px-1 text-helper text-muted">关于</h2>
        <RowList rows={[{ label: "关于 Libevra", hint: "开源协议与隐私说明", to: "/about" }]} onNavigate={go} />
      </section>
    </InnerPage>
  );
}
