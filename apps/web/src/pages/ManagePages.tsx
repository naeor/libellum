import { useState } from "react";
import { useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { InnerPage } from "../components/Layouts.js";
import { SkeletonRows } from "../components/States.js";
import { errorMessage } from "../lib/api.js";
import { CATEGORICAL_COLORS } from "../lib/chart/theme.js";
import {
  useCategoryMutations,
  useLedger,
  usePaymentMethodMutations,
  useTagMutations,
} from "../lib/queries.js";

/**
 * The three management screens.
 *
 * They share one rule, and the wording of their dialogs is where that rule
 * becomes visible to a person:
 *
 *   **A category or payment method is never destroyed — it is archived.**
 *   Entries from months ago still point at it, so it keeps its name in history
 *   and can be brought back at any time.
 *
 *   **A tag is destroyed, but nothing else is.** Entries keep every cent;
 *   they simply lose that label.
 *
 * Every destructive control asks first, and the safe option holds focus.
 */

function AddRow({
  placeholder,
  onAdd,
  busy,
}: {
  readonly placeholder: string;
  readonly onAdd: (name: string) => Promise<void>;
  readonly busy: boolean;
}): React.JSX.Element {
  const [name, setName] = useState("");

  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (trimmed === "") return;
        void onAdd(trimmed).then(() => {
          setName("");
        });
      }}
    >
      <input
        value={name}
        maxLength={20}
        placeholder={placeholder}
        onChange={(event) => {
          setName(event.target.value);
        }}
        className="flex-1 rounded-field border border-line bg-surface px-3.5 py-3 text-base text-ink outline-none placeholder:text-muted/60 focus:border-brand focus:ring-4 focus:ring-brand-soft"
      />
      <button
        type="submit"
        disabled={busy || name.trim() === ""}
        className="shrink-0 rounded-field bg-brand px-5 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-50"
      >
        添加
      </button>
    </form>
  );
}

interface Archivable {
  readonly id: string;
  readonly name: string;
  readonly isArchived: boolean;
  /** Present only while this still carries the preset wording. */
  readonly description?: string | null | undefined;
}

function ArchivableList({
  items,
  busyId,
  onArchive,
  onRestore,
  lockedIds = [],
}: {
  readonly items: readonly Archivable[];
  readonly busyId: string | null;
  readonly onArchive: (item: Archivable) => void;
  readonly onRestore: (item: Archivable) => void;
  readonly lockedIds?: readonly string[];
}): React.JSX.Element {
  return (
    <ul className="overflow-hidden rounded-card border border-line bg-surface">
      {items.map((item) => {
        const locked = lockedIds.includes(item.id);
        const description = item.description ?? null;

        return (
          <li key={item.id}>
            <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5 last:border-b-0">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={`text-sm ${item.isArchived ? "text-muted line-through" : "text-ink"}`}>
                  {item.name}
                </span>
                {/* The preset explanation, shown plainly here: this is the
                    screen somebody opens precisely to read them. */}
                {description ? (
                  <span className="text-xs leading-relaxed text-muted">{description}</span>
                ) : null}
                {locked ? <span className="text-xs text-muted">系统分类，不可修改</span> : null}
                {item.isArchived && !locked ? (
                  <span className="text-xs text-muted">已归档，历史记录仍显示</span>
                ) : null}
              </span>

              {locked ? null : item.isArchived ? (
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() => {
                    onRestore(item);
                  }}
                  className="shrink-0 text-sm text-brand-dark transition hover:underline disabled:opacity-50"
                >
                  恢复
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() => {
                    onArchive(item);
                  }}
                  className="shrink-0 text-sm text-muted transition hover:text-ink disabled:opacity-50"
                >
                  归档
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function CategoriesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const ledger = useLedger();
  const { create, update, archive } = useCategoryMutations();

  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [pending, setPending] = useState<Archivable | null>(null);
  const [error, setError] = useState<string | null>(null);

  const categories = (ledger.data?.categories ?? []).filter((item) => item.kind === kind);
  const active = categories.filter((item) => !item.isArchived);
  const archived = categories.filter((item) => item.isArchived);
  const systemIds = categories.filter((item) => item.isSystem).map((item) => item.id);

  return (
    <InnerPage
      title="分类管理"
      subtitle="归档后不再出现在记账选项中。已有记录仍会显示该分类的名称，可随时恢复。"
      backTo="/settings"
    >
      {error ? <Alert>{error}</Alert> : null}

      <div className="flex gap-2">
        {(["expense", "income"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setKind(option);
            }}
            className={`flex-1 rounded-field py-2.5 text-sm font-medium transition ${
              kind === option ? "bg-brand text-white" : "bg-surface text-muted"
            }`}
          >
            {option === "expense" ? "支出分类" : "收入分类"}
          </button>
        ))}
      </div>

      {ledger.isPending ? <SkeletonRows rows={4} /> : null}

      {ledger.isSuccess ? (
        <>
          <AddRow
            placeholder="新分类名称"
            busy={create.isPending}
            onAdd={async (name) => {
              setError(null);
              try {
                await create.mutateAsync({ name, kind });
              } catch (caught) {
                setError(errorMessage(caught));
              }
            }}
          />

          <ArchivableList
            items={active}
            busyId={archive.isPending ? (pending?.id ?? null) : null}
            lockedIds={systemIds}
            onArchive={(item) => {
              setPending(item);
            }}
            onRestore={(item) => {
              void update.mutateAsync({ id: item.id, isArchived: false }).catch((caught: unknown) => {
                setError(errorMessage(caught));
              });
            }}
          />

          {archived.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="px-1 text-xs text-muted">已归档（{String(archived.length)}）</h2>
              <ArchivableList
                items={archived}
                busyId={update.isPending ? (pending?.id ?? null) : null}
                onArchive={() => undefined}
                onRestore={(item) => {
                  void update.mutateAsync({ id: item.id, isArchived: false }).catch((caught: unknown) => {
                    setError(errorMessage(caught));
                  });
                }}
              />
            </section>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        busy={archive.isPending}
        tone="default"
        title={`归档「${pending?.name ?? ""}」？`}
        description="归档不会删除任何数据。"
        consequences={[
          "它会从记账时的分类选项中消失",
          "已有的记录仍然显示这个分类的名字",
          "你随时可以在这里把它恢复",
        ]}
        confirmLabel="归档"
        onCancel={() => {
          setPending(null);
        }}
        onConfirm={() => {
          const target = pending;
          setPending(null);
          if (target) void archive.mutateAsync(target.id);
        }}
      />
    </InnerPage>
  );
}

export function PaymentMethodsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const ledger = useLedger();
  const { create, update, archive } = usePaymentMethodMutations();

  const [pending, setPending] = useState<Archivable | null>(null);
  const [error, setError] = useState<string | null>(null);

  const methods = ledger.data?.paymentMethods ?? [];
  const active = methods.filter((item) => !item.isArchived);
  const archived = methods.filter((item) => item.isArchived);

  return (
    <InnerPage
      title="支付方式"
      subtitle="记录款项的支付渠道。归档后不再出现在记账选项中，已有记录不受影响。"
      backTo="/settings"
    >
      {error ? <Alert>{error}</Alert> : null}

      {ledger.isPending ? <SkeletonRows rows={3} /> : null}

      {ledger.isSuccess ? (
        <>
          <AddRow
            placeholder="新支付方式"
            busy={create.isPending}
            onAdd={async (name) => {
              setError(null);
              try {
                await create.mutateAsync({ name });
              } catch (caught) {
                setError(errorMessage(caught));
              }
            }}
          />

          <ArchivableList
            items={active}
            busyId={archive.isPending ? (pending?.id ?? null) : null}
            onArchive={(item) => {
              setPending(item);
            }}
            onRestore={(item) => {
              void update.mutateAsync({ id: item.id, isArchived: false }).catch((caught: unknown) => {
                setError(errorMessage(caught));
              });
            }}
          />

          {archived.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="px-1 text-xs text-muted">已归档（{String(archived.length)}）</h2>
              <ArchivableList
                items={archived}
                busyId={update.isPending ? (pending?.id ?? null) : null}
                onArchive={() => undefined}
                onRestore={(item) => {
                  void update.mutateAsync({ id: item.id, isArchived: false }).catch((caught: unknown) => {
                    setError(errorMessage(caught));
                  });
                }}
              />
            </section>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        busy={archive.isPending}
        tone="default"
        title={`归档「${pending?.name ?? ""}」？`}
        description="归档不会删除任何数据。"
        consequences={[
          "它会从记账时的支付方式选项中消失",
          "已有的记录仍然显示这个支付方式",
          "你随时可以在这里把它恢复",
        ]}
        confirmLabel="归档"
        onCancel={() => {
          setPending(null);
        }}
        onConfirm={() => {
          const target = pending;
          setPending(null);
          if (target) void archive.mutateAsync(target.id);
        }}
      />
    </InnerPage>
  );
}

/**
 * The swatches offered when creating a tag.
 *
 * Taken from the chart palette rather than written out again, because a tag
 * colour and a chart series colour are the same kind of thing: a value the user
 * picks, which has to be distinguishable from the ones beside it. Two lists
 * meant the same green could drift into two slightly different greens — and it
 * already had: the old list here contained the accent green, so the first
 * swatch was the button colour.
 */
const TAG_COLORS = CATEGORICAL_COLORS;

/**
 * The colour a new tag starts on.
 *
 * `CATEGORICAL_COLORS` is a non-empty constant, so the first entry always
 * exists; the assertion says that rather than a `?? "#…"` fallback, which would
 * have been a colour literal outside the token file — the one thing
 * `docs/COLORS.md` §7 forbids.
 */
const DEFAULT_TAG_COLOR = CATEGORICAL_COLORS[0] as string;

export function TagsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const ledger = useLedger();
  const { create, remove } = useTagMutations();

  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_TAG_COLOR);
  const [pending, setPending] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tags = ledger.data?.tags ?? [];

  return (
    <InnerPage
      title="标签"
      subtitle="标签用于跨分类标注，例如「出差」「可报销」。每条记录最多添加 10 个标签。"
      backTo="/settings"
    >
      {error ? <Alert>{error}</Alert> : null}

      <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
        <input
          value={name}
          maxLength={12}
          placeholder="新标签名称"
          onChange={(event) => {
            setName(event.target.value);
          }}
          className="rounded-field border border-line bg-surface px-3.5 py-3 text-base text-ink outline-none placeholder:text-muted/60 focus:border-brand focus:ring-4 focus:ring-brand-soft"
        />

        <div className="flex items-center gap-2">
          {TAG_COLORS.map((option) => (
            <button
              key={option}
              type="button"
              aria-label={`颜色 ${option}`}
              onClick={() => {
                setColor(option);
              }}
              style={{ backgroundColor: option }}
              className={`size-7 rounded-full transition ${
                color === option ? "ring-2 ring-ink ring-offset-2" : ""
              }`}
            />
          ))}
        </div>

        <button
          type="button"
          disabled={create.isPending || name.trim() === ""}
          onClick={() => {
            setError(null);
            void create
              .mutateAsync({ name: name.trim(), color })
              .then(() => {
                setName("");
              })
              .catch((caught: unknown) => {
                setError(errorMessage(caught));
              });
          }}
          className="w-full rounded-field bg-brand py-3 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-50"
        >
          添加标签
        </button>
      </section>

      {ledger.isPending ? <SkeletonRows rows={3} /> : null}

      {tags.length > 0 ? (
        <ul className="overflow-hidden rounded-card border border-line bg-surface">
          {tags.map((tag) => (
            <li key={tag.id}>
              <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5 last:border-b-0">
                <span className="flex items-center gap-3">
                  <span style={{ backgroundColor: tag.color }} className="size-3 rounded-full" />
                  <span className="text-sm text-ink">{tag.name}</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setPending({ id: tag.id, name: tag.name });
                  }}
                  className="shrink-0 text-sm text-muted transition hover:text-danger"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        busy={remove.isPending}
        title={`删除标签「${pending?.name ?? ""}」？`}
        description="删除标签不会影响任何一笔账的金额。"
        consequences={[
          "使用过这个标签的记账会失去该标签，账目本身完整保留",
          "删除后，你无法在应用里自行恢复这个标签",
          "如果需要，之后可以重新创建一个同名标签，但不会自动贴回原来的记账",
        ]}
        confirmLabel="确认删除"
        onCancel={() => {
          setPending(null);
        }}
        onConfirm={() => {
          const target = pending;
          setPending(null);
          if (target) void remove.mutateAsync(target.id);
        }}
      />
    </InnerPage>
  );
}
