import { InnerPage } from "../components/Layouts.js";

/**
 * Placeholders that keep the navigation honest.
 *
 * Showing the destination now means the shape of the product does not change
 * when the feature lands; saying plainly that it is not ready yet is better
 * than a menu item that leads nowhere or one that quietly disappears.
 */
function ComingSoon({
  title,
  description,
  planned,
}: {
  readonly title: string;
  readonly description: string;
  readonly planned: readonly string[];
}): React.JSX.Element {
  return (
    <InnerPage title={title} subtitle={description} backTo="/">
      <div className="rounded-card border border-line bg-surface p-5">
        <h2 className="text-sm font-medium text-muted">计划包含</h2>
        <ul className="mt-3 flex flex-col gap-2 text-sm text-ink">
          {planned.map((item) => (
            <li key={item} className="flex gap-2">
              <span className="text-brand" aria-hidden="true">
                ·
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
        <p className="mt-5 border-t border-line pt-4 text-xs leading-relaxed text-muted">
          该功能尚未开放。在此之前，你记录的所有数据都已妥善保存。
        </p>
      </div>
    </InnerPage>
  );
}

export function StatsPage(): React.JSX.Element {
  return (
    <ComingSoon
      title="分析"
      description="把账目变成看得懂的图。"
      planned={[
        "月度收支趋势折线",
        "分类占比饼图",
        "环比与同比对比",
        "年度总览",
        "每日花销日历热力图",
      ]}
    />
  );
}

export function CollaboratorsPage(): React.JSX.Element {
  return (
    <ComingSoon
      title="协作者"
      description="和他人一起维护同一本账。"
      planned={[
        "按用户名或账号编号查找他人",
        "发送协作申请，对方同意后建立关系",
        "邀请协作者加入同一本账",
        "以账本成员身份为唯一权限依据",
      ]}
    />
  );
}
