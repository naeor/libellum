import { useNavigate } from "react-router";

import { InnerPage } from "../components/Layouts.js";

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
              {row.hint ? <span className="text-xs text-muted">{row.hint}</span> : null}
            </span>
            <span className="shrink-0 text-xs text-muted">
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
 * The categories, payment methods and tags screens are real; the rest are
 * listed and marked "后续开放" rather than hidden, so their absence is a stated
 * fact instead of something the user has to wonder about.
 */
export function SettingsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const go = (to: string): void => void navigate(to);

  return (
    <InnerPage title="设置" backTo="/me">
      <section className="flex flex-col gap-2">
        <h2 className="px-1 text-xs text-muted">账号安全</h2>
        <RowList
          rows={[
            { label: "更改密码", hint: "修改后其它设备的登录会失效", to: "/settings/password" },
            { label: "生成新的恢复码", hint: "旧的恢复码会立即失效", to: "/settings/recovery-code" },
          ]}
          onNavigate={go}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="px-1 text-xs text-muted">显示与数据</h2>
        <RowList
          rows={[
            { label: "语言", hint: "中文 / English" },
            { label: "主题色" },
            { label: "汇率折算", hint: "把各币种折算成一种货币统计" },
            { label: "导出数据", hint: "CSV / Excel" },
            { label: "导入历史账", hint: "从 CSV 批量导入" },
          ]}
          onNavigate={go}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="px-1 text-xs text-muted">记账偏好</h2>
        <RowList
          rows={[
            { label: "大键盘输入金额", hint: "使用自绘的大号数字键盘" },
            { label: "沿用上一笔", hint: "新建时自动带入上次的分类等信息" },
            { label: "登录后直接开始记账" },
            { label: "币种显示顺序" },
          ]}
          onNavigate={go}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="px-1 text-xs text-muted">关于</h2>
        <RowList rows={[{ label: "关于 Libellum", hint: "开源协议与隐私说明", to: "/about" }]} onNavigate={go} />
      </section>
    </InnerPage>
  );
}
