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
   * The category a new entry starts on.
   *
   * ⚠️ **What was said wins over what was used last**, which is the opposite of
   * the camera path's rule and deliberately so. A screenshot carries no hint about
   * the category, so the last one used is the only evidence available. A sentence
   * often carries one — "午饭三十八" is food — and the server has already worked
   * out which of *this* ledger's categories it sounds like. Falling back to the
   * last used one only when nothing matched.
   */
  const recent = useTransactions({ month: currentMonth(), kind: spoken?.kind ?? "expense" });
  const lastCategoryId = recent.data?.pages[0]?.items[0]?.categoryId ?? null;

  /**
   * Whether a category id is usable: it has to exist, be the right kind and not
   * be archived. The server checked before answering, but the list can change
   * between the recording and this screen.
   */
  const usable = (id: string | null | undefined): string | null =>
    id !== null &&
    id !== undefined &&
    categories.some((category) => category.id === id && !category.isArchived)
      ? id
      : null;

  const heardCategoryId = usable(spoken?.categoryId);
  const categoryId = heardCategoryId ?? usable(lastCategoryId);

  /** The sentence the category came from, when it came from the sentence. */
  const categoryReason =
    heardCategoryId === null || spoken === null || spoken.categoryMatched.length === 0
      ? null
      : spoken.categoryMatched.join("、");

  const draft = useMemo<ReviewDraft>(
    () => ({
      amount: spoken?.amount ?? "",
      kind: spoken?.kind ?? "expense",
      currency: "CNY",
      date: toLocalDate(new Date()),
      time: "",
      categoryId,
      paymentMethodId: null,
      note: spoken?.text ?? "",
    }),
    [spoken, categoryId],
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
        <Alert tone="info">请先录音，再核对识别结果。</Alert>
        <button
          type="button"
          onClick={() => void navigate("/record")}
          className="text-body text-brand-dark underline"
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
      subtitle="识别结果已填入，请核对金额和分类后保存。"
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

      {/*
        Why the category is already filled in.

        The rule that applies to the amount applies to every field the app fills by
        itself: a value that looks plausible and is wrong is the failure to design
        against, so the app has to say where the value came from. "已选：餐饮" alone
        leaves the user wondering whether it was a guess; naming the word it
        latched onto turns it into something checkable at a glance.
      */}
      {categoryReason === null ? null : (
        <p className="text-helper text-muted">
          听到「{categoryReason}」，已把分类选为
          <span className="text-ink">
            {" "}
            {categories.find((category) => category.id === heardCategoryId)?.name ?? ""}
          </span>
          。如果不对，在上面的分类里改一下就好。
        </p>
      )}

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

          /**
           * `uuidV7()`, not `crypto.randomUUID()`: the latter is a
           * secure-context API and is undefined over plain `http://`, which
           * is how a phone on the LAN used to reach this app.
           *
           * ⚠️ **`idempotencyKey` is the same value as `id`** — see the longer
           * note in `ScanPage.tsx`. Two independent ids turned the server's
           * `idempotency_key` de-duplication into a no-op on this path.
           */
          const id = uuidV7();

          void createEntry
            .mutateAsync({
              id,
              idempotencyKey: id,
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
