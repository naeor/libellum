import { decimalsFor, CURRENCIES, MAX_TAGS_PER_TRANSACTION, type Currency } from "@libellum/shared";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { Alert } from "../components/Alert.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { InnerPage } from "../components/Layouts.js";
import { ErrorState, SkeletonRows } from "../components/States.js";
import { useUndo } from "../components/UndoProvider.js";
import { errorMessage } from "../lib/api.js";
import { deleteEntry, updateEntry } from "../lib/offline/write.js";
import {
  formatDateTimeInZone,
  fromDateTimeLocalValue,
  toDateTimeLocalValue,
  toLocalDate,
  toLocalIso,
} from "../lib/datetime.js";
import { currencyName, formatMoney, minorToInput, parseAmountInput } from "../lib/format.js";
import {
  useDeleteTransaction,
  useLedger,
  useRestoreTransaction,
  useTransaction,
  useUpdateTransaction,
} from "../lib/queries.js";

/**
 * One entry: everything recorded about it, plus the three things a person
 * actually wants here — correct it, copy it, or remove it.
 *
 * Removal asks first and offers to undo afterwards. The wording of that dialog
 * is specific on purpose: the row is kept on the server, but **the user cannot
 * bring it back through the interface on their own**, and saying "may be
 * unrecoverable" instead would be a vaguer claim than the truth.
 */
export function EntryDetailPage(): React.JSX.Element {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { showUndo } = useUndo();

  const ledger = useLedger();
  const entry = useTransaction(id);
  const update = useUpdateTransaction(id);
  const remove = useDeleteTransaction();
  const restore = useRestoreTransaction();

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [amountText, setAmountText] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [paymentMethodId, setPaymentMethodId] = useState<string | null>(null);
  const [currency, setCurrency] = useState<Currency>("CNY");
  const [note, setNote] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  /**
   * ⚠️ **The entry's own time, or `null` until it has loaded — and the `null` is the fix.**
   *
   * The owner's report: "在明细页面修改订单时，什么都不要变，也就是说不要把时间改成系统当时的时间——修改订单时时间应当
   * 默认是订单修改之前记录的时间."
   *
   * **Why it happened**: this started as `new Date()`, and the effect below replaces it with the entry's own time
   * **once the entry arrives**. The 编辑 button was live before that — **so opening the editor early, or saving
   * quickly, used "now" as the entry's time and wrote it back.** The row then moved to the top of the ledger for no
   * reason the user could see.
   *
   * ⚠️ **`null` means "not known yet", and the editor is not offered until it is known.** A default is only a
   * convenience when it is the right one; **a default that silently overwrites the user's data is a defect.**
   */
  const [occurredAt, setOccurredAt] = useState<Date | null>(null);

  useEffect(() => {
    if (!entry.data) return;
    setAmountText(minorToInput(entry.data.amountCents, entry.data.currency));
    setCategoryId(entry.data.categoryId);
    setPaymentMethodId(entry.data.paymentMethodId);
    setCurrency(entry.data.currency);
    setNote(entry.data.note ?? "");
    setTagIds(entry.data.tags.map((tag) => tag.id));
    setOccurredAt(new Date(entry.data.occurredAt));
  }, [entry.data]);

  if (entry.isPending) {
    return (
      <InnerPage title="记账详情" backTo="/">
        <SkeletonRows rows={3} />
      </InnerPage>
    );
  }

  if (entry.isError || !entry.data) {
    return (
      <InnerPage title="记账详情" backTo="/">
        <ErrorState
          message={errorMessage(entry.error)}
          onRetry={() => {
            void entry.refetch();
          }}
        />
      </InnerPage>
    );
  }

  const data = entry.data;
  const ownCategories = (ledger.data?.categories ?? []).filter(
    (category) => category.kind === data.kind && !category.isArchived,
  );
  const ownPaymentMethods = (ledger.data?.paymentMethods ?? []).filter((method) => !method.isArchived);

  async function save(): Promise<void> {
    /**
     * ⚠️ **The entry's time is required, and the guard is the point.** See the note on `occurredAt`: writing "now"
     * because the entry had not loaded is how an edit silently moved a row to the top of the ledger.
     */
    if (occurredAt === null) return;
    setError(null);

    let amountCents: number;
    try {
      amountCents = parseAmountInput(amountText, currency);
    } catch {
      setError(
        decimalsFor(currency) === 0
          ? `${currencyName(currency)}不支持小数，请输入整数金额。`
          : `金额格式不正确，${currencyName(currency)}最多两位小数。`,
      );
      return;
    }

    try {
      /**
       * ⚠️ **Editing goes through the offline path, so it works with no signal and the row changes at once.**
       *
       * `updateEntry` writes the device's copy first and queues the change for the server, then delivers it
       * if it can. **`occurredAt` is deliberately *not* sent as a field the device cannot resolve**: the
       * offline copy is built from the stored entry, so everything the user did not edit keeps the value the
       * server gave it — **including `categoryName` and `version`, which the screen shows and the queue needs
       * as its base.** Sending only what changed is what makes the local entry identical to the server's once
       * the queue drains, instead of a second shape that has to be reconciled.
       */
      const outcome = await updateEntry(
        id,
        {
          version: data.version,
          amountCents,
          categoryId,
          paymentMethodId,
          currency,
          note: note.trim() === "" ? null : note.trim(),
          tagIds,
          occurredAt: toLocalIso(occurredAt),
          occurredLocalDate: toLocalDate(occurredAt),
          occurredTz: data.occurredTz,
        },
        (current) => {
          /**
           * ⚠️ **The offline copy needs a category id, and the update may not have one.**
           *
           * `UpdateTransactionInput.categoryId` allows null — the server files a null category under the
           * book's own 暂无分类 row and **resolves it on the way in**, so the stored entry always has an id.
           * The device cannot resolve it, so it keeps the id it already holds: **the offline entry stays
           * well-formed and the server corrects it if the two differ.**
           */
          const resolvedCategoryId = categoryId ?? current.categoryId;

          return {
            ...current,
            amountCents,
            categoryId: resolvedCategoryId,
            currency,
            note: note.trim() === "" ? null : note.trim(),
            paymentMethodId,
            occurredAt: toLocalIso(occurredAt),
            occurredLocalDate: toLocalDate(occurredAt),
            /**
             * ⚠️ **The category's *name* is taken from the ledger**, because the server denormalises it onto
             * each entry and the offline copy has no server to ask. An entry whose category was changed would
             * otherwise keep showing the old name until the queue drained — **a display that contradicts the
             * edit the user just made, for as long as the network is out.**
             */
            categoryName:
              ledger.data?.categories.find((category) => category.id === resolvedCategoryId)?.name ??
              current.categoryName,
            paymentMethodName:
              paymentMethodId === null
                ? null
                : (ledger.data?.paymentMethods.find((method) => method.id === paymentMethodId)?.name ??
                  current.paymentMethodName),
            tagIds,
          };
        },
      );

      /**
       * A `null` means the device does not hold this entry, which should not happen for a screen reached from
       * the ledger — but if it does, the server path is the honest fallback rather than a silent no-op.
       */
      if (outcome === null) {
        await update.mutateAsync({
          version: data.version,
          amountCents,
          categoryId,
          paymentMethodId,
          currency,
          note: note.trim() === "" ? null : note.trim(),
          tagIds,
          occurredAt: toLocalIso(occurredAt),
          occurredLocalDate: toLocalDate(occurredAt),
          occurredTz: data.occurredTz,
        });
      }

      /**
       * ⚠️ **Saving an edit goes back to the ledger, not to the entry's own read-only view.**
       *
       * The owner's report: "修改记账之后不会跳转到明细；反而会跳转到记账详情，还要自己退出."
       *
       * ⚠️ **His reading of it is the right one** — the screen behaves differently for its two jobs. **Deleting
       * already returns to the ledger** (the entry is gone; there is nothing to stay for), while editing left the
       * user on a read-only page **they had just finished with**, so every edit cost an extra tap to get back to
       * the list they were working in.
       *
       * ⚠️ **The screen is reached from the ledger and returns to the ledger** — a push and a pop, not a detour.
       */
      await navigate("/");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function doDelete(): Promise<void> {
    setConfirmDelete(false);
    setError(null);

    try {
      /**
       * ⚠️ **Deleting offline marks the entry instead of removing it.**
       *
       * The row leaves the screen immediately, and its stored copy stays — **that copy is what round 3 needs
       * to show the user what they deleted while asking whether the delete should stand.** The undo below
       * restores from the server, so it needs a connection; **its button is honest about that rather than
       * pretending to work.**
       */
      await deleteEntry(id);
      await navigate("/");
      showUndo({
        message: "已删除这笔记账",
        onUndo: async () => {
          await restore.mutateAsync(id);
        },
      });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <InnerPage
      title={editing ? "修改记账" : "记账详情"}
      onBack={() => {
        if (editing) setEditing(false);
        else void navigate("/");
      }}
      actions={
        editing ? null : (
          <button
            type="button"
            onClick={() => {
              setEditing(true);
            }}
            className="text-sm font-medium text-brand-dark transition hover:underline"
          >
            修改
          </button>
        )
      }
    >
      {error ? <Alert>{error}</Alert> : null}

      <section className="rounded-card border border-line bg-surface p-5">
        <p className="text-xs text-muted">{data.kind === "expense" ? "支出" : "收入"}</p>
        <p className="mt-1 text-3xl font-semibold text-ink">
          {data.kind === "expense" ? "-" : "+"}
          {formatMoney(data.amountCents, data.currency, { withCode: true })}
        </p>
      </section>

      {editing ? (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="px-1 text-xs text-muted">金额</h2>
            <input
              value={amountText}
              onChange={(event) => {
                setAmountText(event.target.value);
              }}
              inputMode="decimal"
              className="rounded-field border border-line bg-surface px-3.5 py-3 text-2xl font-semibold text-ink outline-none focus:border-brand focus:ring-4 focus:ring-brand-soft"
            />
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="px-1 text-xs text-muted">分类</h2>
            <div className="grid grid-cols-3 gap-2">
              {ownCategories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => {
                    setCategoryId(category.id === categoryId ? null : category.id);
                  }}
                  className={`rounded-field py-3 text-sm transition ${
                    category.id === categoryId ? "bg-brand text-white" : "bg-surface text-ink"
                  }`}
                >
                  {category.name}
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="px-1 text-xs text-muted">支付方式</h2>
            <div className="flex flex-wrap gap-2">
              {ownPaymentMethods.map((method) => (
                <button
                  key={method.id}
                  type="button"
                  onClick={() => {
                    setPaymentMethodId(method.id === paymentMethodId ? null : method.id);
                  }}
                  className={`rounded-full px-4 py-2 text-sm transition ${
                    method.id === paymentMethodId ? "bg-brand text-white" : "bg-surface text-ink"
                  }`}
                >
                  {method.name}
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="px-1 text-xs text-muted">币种</h2>
            <div className="flex flex-wrap gap-2">
              {CURRENCIES.map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => {
                    setCurrency(code);
                  }}
                  className={`rounded-full px-4 py-2 text-sm transition ${
                    code === currency ? "bg-brand text-white" : "bg-surface text-ink"
                  }`}
                >
                  {currencyName(code)}
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="px-1 text-xs text-muted">时间</h2>
            <input
              type="datetime-local"
              step="1"
              value={occurredAt === null ? "" : toDateTimeLocalValue(occurredAt)}
              onChange={(event) => {
                const parsed = fromDateTimeLocalValue(event.target.value);
                if (parsed) setOccurredAt(parsed);
              }}
              className="rounded-field border border-line bg-surface px-3.5 py-3 text-base text-ink outline-none focus:border-brand focus:ring-4 focus:ring-brand-soft"
            />
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="px-1 text-xs text-muted">备注</h2>
            <input
              value={note}
              maxLength={200}
              onChange={(event) => {
                setNote(event.target.value);
              }}
              className="rounded-field border border-line bg-surface px-3.5 py-3 text-base text-ink outline-none focus:border-brand focus:ring-4 focus:ring-brand-soft"
            />
          </section>

          {(ledger.data?.tags.length ?? 0) > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="px-1 text-xs text-muted">
                标签（最多 {String(MAX_TAGS_PER_TRANSACTION)} 个）
              </h2>
              <div className="flex flex-wrap gap-2">
                {(ledger.data?.tags ?? []).map((tag) => {
                  const selected = tagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => {
                        setTagIds((current) =>
                          current.includes(tag.id)
                            ? current.filter((value) => value !== tag.id)
                            : current.length >= MAX_TAGS_PER_TRANSACTION
                              ? current
                              : [...current, tag.id],
                        );
                      }}
                      style={selected ? { backgroundColor: tag.color, borderColor: tag.color } : undefined}
                      className={`rounded-full border px-3.5 py-1.5 text-sm transition ${
                        selected ? "text-white" : "border-line bg-surface text-ink"
                      }`}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}

          <button
            type="button"
            disabled={update.isPending}
            onClick={() => void save()}
            className="w-full rounded-field bg-brand py-3.5 text-[15px] font-medium text-white transition hover:bg-brand-dark disabled:opacity-50"
          >
            {update.isPending ? "保存中…" : "保存修改"}
          </button>
        </>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3 rounded-card border border-line bg-surface p-5 text-sm">
            <dt className="text-muted">分类</dt>
            <dd className="text-right text-ink">
              {data.categoryIsSystem ? "暂无分类" : data.categoryName}
            </dd>

            <dt className="text-muted">支付方式</dt>
            <dd className="text-right text-ink">{data.paymentMethodName ?? "未记录"}</dd>

            <dt className="text-muted">币种</dt>
            <dd className="text-right text-ink">{currencyName(data.currency)}</dd>

            <dt className="text-muted">时间</dt>
            <dd className="text-right text-ink">{formatDateTimeInZone(data.occurredAt, data.occurredTz)}</dd>

            <dt className="text-muted">时区</dt>
            <dd className="text-right text-muted">{data.occurredTz}</dd>

            <dt className="text-muted">备注</dt>
            <dd className="text-right text-ink">{data.note ?? "无"}</dd>
          </dl>

          <section className="flex flex-col gap-2">
            <h2 className="px-1 text-xs text-muted">标签</h2>
            {data.tags.length === 0 ? (
              <p className="px-1 text-sm text-muted">没有标签</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {data.tags.map((tag) => (
                  <span
                    key={tag.id}
                    style={{ backgroundColor: tag.color }}
                    className="rounded-full px-3.5 py-1.5 text-sm text-white"
                  >
                    {tag.name}
                  </span>
                ))}
              </div>
            )}
          </section>

          <button
            type="button"
            onClick={() => {
              void navigate("/add", { state: { copyFrom: data } });
            }}
            className="w-full rounded-field bg-brand-soft py-3 text-sm font-medium text-brand-dark transition hover:bg-brand-soft/70"
          >
            复制这一笔
          </button>

          <button
            type="button"
            onClick={() => {
              setConfirmDelete(true);
            }}
            className="w-full rounded-field bg-danger py-3.5 text-[15px] font-medium text-white transition hover:bg-danger-dark"
          >
            删除这笔记账
          </button>
        </>
      )}

      <ConfirmDialog
        open={confirmDelete}
        busy={remove.isPending}
        title="删除这笔记账？"
        description={`即将删除这笔 ${formatMoney(data.amountCents, data.currency, { withCode: true })} 的记录。`}
        consequences={[
          "删除后，你无法在应用里自行恢复这笔记录",
          "本月的总额、笔数与结余会立即重新计算",
          "删除后的几秒内仍可在底部选择「撤销」",
        ]}
        confirmLabel="确认删除"
        onCancel={() => {
          setConfirmDelete(false);
        }}
        onConfirm={() => void doDelete()}
      />
    </InnerPage>
  );
}
