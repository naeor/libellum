import { Link } from "react-router";

import { formatTransactionNumber } from "@libellum/shared";

import { useLedgerHistory, type LedgerHistoryEntry } from "../lib/queries.js";

/**
 * **账本的编辑历史：谁在什么时候，对哪一笔做了什么。**
 *
 * ⚠️ **A list of sentences, not a log viewer.** The owner's requirement is explicit:
 * *"历史记录尽量以**简洁、易读**的方式呈现，**不要变成复杂的数据库日志界面**."* So a row here is
 * one line plus, when the change was an edit, **what changed** — and nothing else.
 *
 * ⚠️ **The sentence is the server's.** This component renders `summary` instead of assembling one,
 * because the API is the side that knows which fields are tracked.
 *
 * ⚠️ **No "今天/昨天".** The API returns an instant; saying it in the reader's own words happens
 * here, from their clock — **a relative time computed anywhere else is wrong for somebody.**
 */
export function HistoryList({
  limit,
  emptyHint,
  embedded = false,
}: {
  readonly limit: number;
  readonly emptyHint: string;
  /**
   * ⚠️ **Draw no frame of its own, because the caller already has one.**
   *
   * The owner's complaint about the first-level page was *"盒子套盒子"* — a heading, a frame, and
   * then **a complete second card inside it** before any content. On the full history screen this
   * list *is* the page and its frame is right; inside `SectionFrame` it would be the nesting he
   * asked to remove. **One flag, one list** — a second copy for the embedded case would be two
   * renderers of one server sentence (`教训.md` §8.12).
   *
   * ⚠️ **The separators move to the rows here.** The framed version lets the card's border own the
   * edges, so its `last:border-b-0` is doing nothing; unframed, **every** row needs its divider and
   * the last one must drop it — otherwise the frame's bottom edge and a divider sit on top of each
   * other.
   */
  readonly embedded?: boolean;
}): React.JSX.Element {
  const history = useLedgerHistory(limit);

  if (history.isPending) {
    return <p className="px-5 py-4 text-body text-muted">正在载入历史记录…</p>;
  }

  if (history.isError) {
    return <p className="px-5 py-4 text-body text-muted">无法载入历史记录，请重试。</p>;
  }

  const { entries, total } = history.data;

  /**
   * ⚠️ **Empty is stated, not left blank.** An empty list reads as "this ledger has no history",
   * which after S9.5 is **false for any ledger that has been touched since** — the events simply
   * start when the feature did. The hint says which of the two it is.
   *
   * ⚠️ **Frameless when embedded**, so the empty state does not put a card inside the frame either.
   */
  if (entries.length === 0) {
    return embedded ? (
      <p className="px-5 py-4 text-body-relaxed text-muted">{emptyHint}</p>
    ) : (
      <p className="rounded-card border border-line bg-surface px-5 py-4 text-body-relaxed text-muted">
        {emptyHint}
      </p>
    );
  }

  const rows = (
    <ul className={embedded ? "" : "overflow-hidden rounded-card border border-line bg-surface"}>
      {entries.map((entry) => (
        <li key={entry.id} className="border-b border-line last:border-b-0">
          <HistoryRow entry={entry} />
        </li>
      ))}
    </ul>
  );

  if (embedded) {
    /**
     * ⚠️ **The "共 N 条" footnote is dropped here.** It belongs to the full screen, where the reader
     * is asking "how much is there"; on the first-level page the 查看全部 › link in the heading
     * already answers that, and a second sentence saying it is the crowding the owner is removing.
     */
    return rows;
  }

  return (
    <div className="flex flex-col gap-3">
      {rows}

      {total > entries.length ? (
        <p className="text-helper text-muted">
          共 {String(total)} 条记录，这里显示最近 {String(entries.length)} 条。
        </p>
      ) : null}
    </div>
  );
}

/**
 * One line of history.
 *
 * ⚠️ **The whole row is a link when there is an entry to open.** The owner asked for it directly:
 * *"在历史记录中**点击某笔账，应尽可能直接打开对应的账目详情**，而不是要求用户手动搜索编号."*
 *
 * ⚠️ **A deleted entry has no detail page to open** — its row is a tombstone, and
 * `transactionId` survives (the delete is a soft one) — **so the link is offered, and the entry
 * detail screen is what explains it is deleted.** Refusing the link here would be a second place
 * deciding what "deleted" means.
 */
function HistoryRow({ entry }: { readonly entry: LedgerHistoryEntry }): React.JSX.Element {
  const body = (
    <>
      <span className="flex flex-wrap items-center gap-2 text-body text-ink">
        {entry.summary}
        {entry.transactionSeq === null ? null : (
          /**
           * ⚠️ **The number is copyable, and the owner asked for exactly that**: *"应当能够在账目详情和
           * 历史记录中查看、复制."* The whole row is a link, so this button **stops the tap from
           * propagating** — otherwise copying the number would navigate away and the number would be
           * gone from the clipboard's context.
           *
           * ⚠️ **A `button`, not a `<span>` with a click handler**, because the row already contains
           * one interactive element and **a nested link inside a link is not valid HTML** — the screen
           * reader would announce one target where there are two.
           */
          <button
            type="button"
            title="复制编号"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void navigator.clipboard.writeText(formatTransactionNumber(entry.transactionSeq ?? 0)).catch(() => undefined);
            }}
            className="rounded-field bg-canvas px-1.5 py-0.5 font-mono text-micro text-muted transition hover:text-ink"
          >
            {formatTransactionNumber(entry.transactionSeq)}
          </button>
        )}
      </span>

      {entry.changes.length === 0 ? null : (
        <span className="flex flex-col gap-0.5">
          {entry.changes.map((change) => (
            <span key={change.label} className="text-helper text-muted">
              {change.label}：{change.from} → {change.to}
            </span>
          ))}
        </span>
      )}

      <span className="text-helper text-muted">{formatWhen(entry.occurredAt)}</span>
    </>
  );

  if (entry.transactionId === null) {
    return <div className="flex flex-col gap-1 px-5 py-3">{body}</div>;
  }

  return (
    <Link
      to={`/transactions/${entry.transactionId}`}
      className="flex flex-col gap-1 px-5 py-3 transition hover:bg-canvas"
    >
      {body}
    </Link>
  );
}

/**
 * The instant, in the reader's own words.
 *
 * ⚠️ **Deliberately coarse**: "今天 14:32" is what somebody wants from a history line. Seconds would
 * add precision nobody reads and **make two edits in the same minute look different for no reason.**
 */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  const now = new Date();

  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

  if (sameDay(at, now)) return `今天 ${time}`;
  if (sameDay(at, yesterday)) return `昨天 ${time}`;

  return `${String(at.getMonth() + 1)} 月 ${String(at.getDate())} 日 ${time}`;
}
