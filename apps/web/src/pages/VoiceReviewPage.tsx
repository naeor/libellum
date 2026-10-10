import { useMemo, useState } from "react";
import { UNCATEGORISED_NAME, decimalsFor, type Transaction } from "@libellum/shared";
import { useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { ChoiceDialog, type Choice } from "../components/ChoiceDialog.js";
import { EntrySaved } from "../components/EntrySaved.js";
import { ReviewStep, type ReviewDraft } from "../components/EntryForm.js";
import { InnerPage } from "../components/Layouts.js";
import { errorMessage } from "../lib/api.js";
import {
  currentMonth,
  localTimeZone,
  toLocalDate,
  toLocalIso,
} from "../lib/datetime.js";
import { currencyName, formatMoney, parseAmountInput } from "../lib/format.js";
import {
  useCreateTransaction,
  useDeleteTransaction,
  useLedger,
  useRestoreTransaction,
  useTransactions,
} from "../lib/queries.js";
import { takeSpokenHandover } from "../lib/scanHandoff.js";
import { uuidV7 } from "../lib/uuid.js";

/**
 * Confirming an entry that was spoken.
 *
 * **The same form as the camera path**, which is what the owner asked for:
 * "核对页面跟拍照记账的核对页面可以类似". Similar is served best by *being* the same
 * component — the questions are identical (how much, what kind, when, which
 * category, paid how, what note), and two copies would drift the first time a
 * field was added to one of them.
 *
 * What differs is where the starting values come from, and one line at the top:
 * the sentence that was heard. That line is the trust mechanism for speech and
 * the reason the transcript is shown rather than quietly consumed — recognition
 * fails in ways that look plausible, and the owner's own example is the one to
 * keep in mind: **午饭 came back as 五份**. Nobody can catch that in a filled-in
 * form; they can catch it beside the sentence that produced it.
 *
 * **No date is taken from speech.** The owner asked to leave it out of the first
 * version, and the reasoning holds: a misheard date is the hardest mistake to
 * notice, because 10-09 and 10-10 look equally plausible in a form. An entry
 * recorded now *is* now, which is right nearly always.
 */
export function VoiceReviewPage(): React.JSX.Element {
  const navigate = useNavigate();
  const ledger = useLedger();
  const createEntry = useCreateTransaction();
  const removeEntry = useDeleteTransaction();
  const restoreEntry = useRestoreTransaction();

  /**
   * Read once, on mount; the handover is emptied as it is read.
   *
   * A `useState` initialiser rather than `useMemo`, so it reads exactly once even
   * under React's development double-render — a double read takes the draft the
   * first time and `null` the second, which is a bug that only appears in dev.
   */
  const [spoken] = useState(() => takeSpokenHandover());

  const [saved, setSaved] = useState<Transaction | null>(null);
  const [undone, setUndone] = useState<Transaction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const categories = ledger.data?.categories ?? [];
  const paymentMethods = ledger.data?.paymentMethods ?? [];

  /**
   * The category a new entry starts on: whatever was used last.
   *
   * The same guess the camera path makes. Screenshots never carry a category and
   * neither does speech — nobody says "午饭，餐饮分类" — so the honest default is
   * the last one used, one tap away from being changed.
   */
  const recent = useTransactions({ month: currentMonth(), kind: spoken?.kind ?? "expense" });
  const lastCategoryId = recent.data?.pages[0]?.items[0]?.categoryId ?? null;

  const draft = useMemo<ReviewDraft>(
    () => ({
      amount: spoken?.amount ?? "",
      kind: spoken?.kind ?? "expense",
      currency: "CNY",
      date: toLocalDate(new Date()),
      time: "",
      categoryId:
        lastCategoryId !== null &&
        categories.some((category) => category.id === lastCategoryId && !category.isArchived)
          ? lastCategoryId
          : null,
      paymentMethodId: null,
      note: spoken?.text ?? "",
    }),
    [spoken, lastCategoryId, categories],
  );

  /**
   * Nothing to confirm.
   *
   * Reached by a refresh, a bookmark, or a back press after the handover has been
   * read. Saying so and offering the recorder is better than an empty form the
   * user has to work out is empty.
   */
  if (spoken === null) {
    return (
      <InnerPage title="核对" subtitle="没有听到内容。" backTo="/record">
        <Alert tone="info">这一页需要一个刚录好的语音。请先录一段。</Alert>
        <button
          type="button"
          onClick={() => void navigate("/record")}
          className="text-sm text-brand-dark underline"
        >
          去录音
        </button>
      </InnerPage>
    );
  }

  if (saved !== null) {
    return (
      <>
        <EntrySaved
          entry={saved}
          categoryName={
            categories.find((category) => category.id === saved.categoryId)?.name ??
            UNCATEGORISED_NAME
          }
          paymentName={
            paymentMethods.find((method) => method.id === saved.paymentMethodId)?.name ?? null
          }
          // One entry at a time, so nothing is waiting behind it.
          remaining={0}
          onHome={() => void navigate("/")}
          onAgain={() => void navigate("/record")}
          onUndo={() => {
            void removeEntry
              .mutateAsync(saved.id)
              .then(() => {
                setUndone(saved);
                setSaved(null);
              })
              .catch((caught: unknown) => {
                setError(errorMessage(caught));
              });
          }}
        />

        <ChoiceDialog
          open={undone !== null}
          title="已撤销这笔记账"
          description={
            undone === null
              ? ""
              : `${formatMoney(undone.amountCents, undone.currency)} 已从账本移除。`
          }
          choices={UNDONE_CHOICES}
          onChoose={(choice) => {
            const entry = undone;
            setUndone(null);
            if (entry === null || choice === "dismiss") return;

            void restoreEntry.mutateAsync(entry.id).catch((caught: unknown) => {
              setError(errorMessage(caught));
            });
          }}
        />
      </>
    );
  }

  return (
    <InnerPage
      title="核对"
      subtitle="听到的内容已经填进表单，请确认金额和分类后再保存。"
      backTo="/record"
    >
      {error === null ? null : <Alert tone="error">{error}</Alert>}

      {/*
        What was heard, kept on screen next to the numbers it produced.
        See the note at the top of the file for why this is not decoration.
      */}
      <p className="rounded-field bg-canvas px-4 py-3 text-sm leading-relaxed text-muted">
        听到：{spoken.text}
      </p>

      <ReviewStep
        draft={draft}
        warnings={[]}
        remaining={1}
        categories={categories}
        paymentMethods={paymentMethods}
        busy={createEntry.isPending}
        onManual={() => void navigate("/add")}
        onSave={(edited) => {
          setError(null);

          /**
           * Parsed with the shared helper, not `Number`.
           *
           * `parseAmountInput` already knows about per-currency precision — JPY
           * has no decimals — and returns minor units, which is what the API
           * wants. `Number(text)` would have accepted `12.345` and then rounded
           * it silently, and would have needed the currency rules reimplemented
           * here for no reason.
           */
          let amountCents: number;
          try {
            amountCents = parseAmountInput(edited.amount, edited.currency);
          } catch {
            setError(
              decimalsFor(edited.currency) === 0
                ? `${currencyName(edited.currency)}不支持小数，请输入整数金额。`
                : "金额格式不正确。",
            );
            return;
          }

          if (amountCents <= 0) {
            setError("金额需要大于 0。");
            return;
          }

          const occurredAt = new Date(
            `${edited.date}T${edited.time === "" ? "12:00" : edited.time}:00`,
          );

          void createEntry
            .mutateAsync({
              /**
               * `uuidV7()`, not `crypto.randomUUID()`: the latter is a
               * secure-context API and is undefined over plain `http://`, which
               * is how a phone on the LAN used to reach this app.
               */
              id: uuidV7(),
              idempotencyKey: uuidV7(),
              kind: edited.kind,
              amountCents,
              currency: edited.currency,
              categoryId: edited.categoryId,
              paymentMethodId: edited.paymentMethodId,
              occurredAt: toLocalIso(occurredAt),
              occurredLocalDate: toLocalDate(occurredAt),
              occurredTz: localTimeZone(),
              note: edited.note.trim() === "" ? null : edited.note.trim(),
              tagIds: [],
            })
            .then((entry) => {
              setSaved(entry);
            })
            .catch((caught: unknown) => {
              setError(errorMessage(caught));
            });
        }}
      />
    </InnerPage>
  );
}

/**
 * What to offer after the entry has been taken back.
 *
 * The same two choices the camera path offers, and for the same reason: an undo
 * that cannot be reversed makes the user restart the entry by hand if they change
 * their mind. 重新记上 rather than 撤销撤销, because the second is a word nobody
 * reads twice.
 */
const UNDONE_CHOICES: readonly Choice<"restore" | "dismiss">[] = [
  { id: "restore", label: "重新记上", hint: "我刚才点错了", primary: true },
  { id: "dismiss", label: "知道了", dismissive: true },
];
