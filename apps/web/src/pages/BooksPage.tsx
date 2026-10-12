import { useState } from "react";
import { useNavigate } from "react-router";

import { useAuth } from "../auth/AuthProvider.js";
import { Button } from "../components/Button.js";
import { ChoiceDialog } from "../components/ChoiceDialog.js";
import { InnerPage } from "../components/Layouts.js";
import { SkeletonRows } from "../components/States.js";
import { errorMessage } from "../lib/api.js";
import {
  useActivateBook,
  useBooks,
  useCreateBook,
  useCreateShareLink,
  useDisposeBook,
  useLeaveBook,
  useLedger,
  useRestoreBook,
  useRevokeShareLink,
  useShareLinks,
  type BookSummary,
  type ShareLinkView,
} from "../lib/queries.js";

/**
 * The ledgers this account can open — and the one place a second ledger is made.
 *
 * ⚠️ **This screen replaces a page that stated a fact** ("一个账号对应一本账本"), and the fact is
 * no longer true: an account can belong to several ledgers, some of them made by other people.
 * Left as it was, it would have kept telling people they had one.
 *
 * ⚠️ **It is the functional form only.** The owner's plan gives this page two states — a display
 * state for the first sign-in and a ledger state for working in — and he asked for the functions
 * first: *"不过现在先制作功能页面就行，展示回头再说."* So this is the ledger state, reached from
 * the account screen.
 *
 * ⚠️ **`role` is shown, not assumed.** A viewer opening this screen sees the same ledgers and the
 * same numbers as an editor; the difference is that the server will refuse their writes, and the
 * badge is how they find that out before trying.
 */
export function BooksPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { user } = useAuth();
  const books = useBooks();
  const current = useLedger();

  const createBook = useCreateBook();
  const activateBook = useActivateBook();
  const disposeBook = useDisposeBook();
  const restoreBook = useRestoreBook();
  const leaveBook = useLeaveBook();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [pendingDispose, setPendingDispose] = useState<BookSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const currentBookId = current.data?.book.id ?? null;

  async function enterLedger(bookId: string): Promise<void> {
    if (bookId === currentBookId) {
      navigate("/");
      return;
    }

    setError(null);
    setSwitching(true);

    try {
      await activateBook.mutateAsync(bookId);

      /**
       * ⚠️ **A full reload, deliberately, and this is the one place in the app that does it.**
       *
       * Entering a ledger changes which ledger *every* subsequent request addresses **and** which
       * slice of the device's offline copy is read. Invalidating queries and hoping they refetch
       * in the right order risks a screen showing one ledger's name over another's entries —
       * **and that mixture is precisely what this stage exists to make impossible.** A reload
       * cannot be half-done, which is exactly the property wanted here.
       */
      window.location.assign("/");
    } catch (caught) {
      setSwitching(false);
      setError(errorMessage(caught));
    }
  }

  async function submitCreate(): Promise<void> {
    setError(null);

    try {
      const created = await createBook.mutateAsync(name.trim() === "" ? "我的账本" : name.trim());
      setCreating(false);
      setName("");
      await enterLedger(created.id);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <InnerPage title="我的账本" subtitle={user?.displayName ?? ""} backTo="/start">
      {books.isPending ? <SkeletonRows rows={2} /> : null}

      {error !== null ? (
        <p role="alert" className="mb-4 rounded-field bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {switching ? (
        <p role="status" className="mb-4 text-sm text-muted">
          正在切换到那本账……
        </p>
      ) : null}

      {books.isSuccess ? (
        <div className="flex flex-col gap-4">
          <ul className="overflow-hidden rounded-card border border-line bg-surface">
            {books.data.books.map((book) => (
              <li key={book.id} className="border-b border-line last:border-b-0">
                <BookRow
                  book={book}
                  isCurrent={book.id === currentBookId}
                  busy={switching}
                  onEnter={() => void enterLedger(book.id)}
                  onDispose={() => {
                    setPendingDispose(book);
                  }}
                  onLeave={() => {
                    setError(null);
                    void leaveBook
                      .mutateAsync(book.id)
                      .then(() => {
                        /**
                         * ⚠️ **A reload, for the same reason entering a ledger is one**: leaving the
                         * ledger currently in hand changes which ledger every later request
                         * addresses and which slice of the offline copy is read. **A screen showing
                         * one ledger's header over another's entries is the failure this stage
                         * exists to prevent**, and a reload cannot be half-done.
                         */
                        if (book.id === currentBookId) window.location.assign("/");
                      })
                      .catch((caught: unknown) => {
                        setError(errorMessage(caught));
                      });
                  }}
                />
              </li>
            ))}
          </ul>

          {creating ? (
            <div className="rounded-card border border-line bg-surface p-5">              <label className="flex flex-col gap-2 text-sm text-muted">
                新账本的名称
                <input
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                  maxLength={40}
                  placeholder="我的账本"
                  className="rounded-field border border-line bg-canvas px-4 py-3 text-ink"
                />
              </label>

              <div className="mt-4 flex gap-3">
                <Button
                  onClick={() => void submitCreate()}
                  disabled={createBook.isPending}
                >
                  {createBook.isPending ? "正在创建……" : "创建并进入"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setCreating(false);
                    setName("");
                  }}
                >
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <Button
              onClick={() => {
                setCreating(true);
              }}
            >
              新建一本账
            </Button>
          )}

          {currentBookId === null ? null : <ShareSection />}

          {books.data.disposed.length > 0 ? (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm text-muted">已弃置</h2>              <p className="text-xs leading-relaxed text-muted">
                这些账本的数据都还在，只是不再出现在列表里。恢复后立刻可以使用。
              </p>

              <ul className="overflow-hidden rounded-card border border-line bg-surface">
                {books.data.disposed.map((book) => (
                  <li
                    key={book.id}
                    className="flex items-center justify-between gap-4 border-b border-line px-5 py-4 last:border-b-0"
                  >
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm text-ink">{book.name}</span>
                      <span className="font-mono text-xs text-muted">
                        {book.bookNumber ?? "（未分配编号）"}
                      </span>
                    </span>

                    <Button
                      variant="secondary"
                      fullWidth={false}
                      onClick={() => {
                        setError(null);
                        void restoreBook.mutateAsync(book.id).catch((caught: unknown) => {
                          setError(errorMessage(caught));
                        });
                      }}
                    >
                      恢复
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="text-xs leading-relaxed text-muted">
            账本编号用于两个人核对"看的是不是同一本账"。它不能用来搜索账本——
            加入别人的账本只能通过邀请。
          </p>
        </div>
      ) : null}

      <ChoiceDialog
        open={pendingDispose !== null}
        title={`弃置「${pendingDispose?.name ?? ""}」？`}
        description="弃置后这本账不再出现在你的列表里。数据都保留着，随时可以恢复。"
        choices={[
          {
            id: "dispose",
            label: "弃置这本账",
            hint: "数据不会被删除，之后可以在「已弃置」里恢复",
          },
          { id: "keep", label: "再想想", hint: "什么都不做", dismissive: true },
        ]}
        onChoose={(id) => {
          const target = pendingDispose;
          setPendingDispose(null);
          if (id !== "dispose" || !target) return;

          setError(null);
          void disposeBook.mutateAsync(target.id).catch((caught: unknown) => {
            setError(errorMessage(caught));
          });
        }}
      />
    </InnerPage>
  );
}

/**
 * Share links for the ledger in hand.
 *
 * ⚠️ **The URL is built from `window.location.origin`, not hard-coded.** The same build is served
 * from the LAN address on the family's devices and from localhost during development, and a link
 * pasted into a chat has to open from wherever the recipient is — so the origin of the page that
 * generated it is the only correct answer.
 *
 * ⚠️ **A token is shown exactly once, right after it is generated.** The server keeps only a hash
 * and cannot produce it again, so the list below deliberately has no "copy" action: for an existing
 * link the honest offer is "generate a new one", which is why regeneration is an ordinary button
 * rather than a recovery procedure.
 */
function ShareSection(): React.JSX.Element {
  const links = useShareLinks();
  const create = useCreateShareLink();
  const revoke = useRevokeShareLink();
  const [role, setRole] = useState<"editor" | "viewer">("viewer");
  /**
   * ⚠️ **Defaults are the permissive end of the owner's ranges** (7 days, 10 people), so a person
   * who does not care gets a usable link. The pickers exist because the ranges are his
   * specification — *"分享链接（1–7 天、1–10 人、可撤销）"* — and **a range that can only be used at
   * one end is not the range he asked for.**
   */
  const [days, setDays] = useState(7);
  const [maxUses, setMaxUses] = useState(10);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const all = links.data?.links ?? [];
  const live = all.filter((link) => link.active);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm text-muted">分享这本账</h2>

      {error !== null ? (
        <p role="alert" className="rounded-field bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <p className="text-xs leading-relaxed text-muted">
        拿到链接的人打开后，会先看到这是哪本账、他会被给什么权限，确认之后才会加入。
        链接可以随时撤销；撤销之后旧的立刻失效。
      </p>

      {freshToken === null ? (
        <div className="flex flex-col gap-4 rounded-card border border-line bg-surface px-5 py-4">
          <Picker
            label="给对方的权限"
            value={role}
            options={[
              { value: "viewer" as const, label: "仅查看" },
              { value: "editor" as const, label: "可编辑" },
            ]}
            onPick={setRole}
          />

          {/**
            * ⚠️ **The two ranges are stated, not just enforced.** Somebody choosing "3 天" should be
            * able to see that 7 is the maximum, otherwise the picker looks like it simply ran out.
            */}
          <Picker
            label="有效期（1–7 天）"
            value={days}
            options={[1, 3, 7].map((value) => ({ value, label: `${String(value)} 天` }))}
            onPick={setDays}
          />

          <Picker
            label="最多几人可以加入（1–10）"
            value={maxUses}
            options={[1, 3, 5, 10].map((value) => ({ value, label: `${String(value)} 人` }))}
            onPick={setMaxUses}
          />

          <Button
            fullWidth={false}
            disabled={create.isPending}
            onClick={() => {
              setError(null);
              void create
                .mutateAsync({ role, days, maxUses })
                .then((created) => {
                  setFreshToken(created.token);
                })
                .catch((caught: unknown) => {
                  setError(errorMessage(caught));
                });
            }}
          >
            {create.isPending ? "正在生成……" : "生成分享链接"}
          </Button>
        </div>
      ) : (
        <div className="rounded-card border border-brand bg-brand-soft/40 px-5 py-4">
          <p className="text-xs text-muted">这条链接只会显示这一次，请现在复制并保存：</p>
          <p className="mt-2 break-all rounded-field bg-surface px-3 py-2 font-mono text-xs text-ink">
            {`${window.location.origin}/join/${freshToken}`}
          </p>
          <div className="mt-3 flex gap-3">
            <Button
              fullWidth={false}
              onClick={() => {
                void navigator.clipboard
                  .writeText(`${window.location.origin}/join/${freshToken}`)
                  .catch(() => undefined);
              }}
            >
              复制链接
            </Button>
            <Button variant="secondary" fullWidth={false} onClick={() => { setFreshToken(null); }}>
              我已保存
            </Button>
          </div>
        </div>
      )}

      {/**
        * ⚠️ **Every link is listed, including the dead ones.** An earlier version filtered to the
        * active ones — which meant **`已撤销`、`已过期`、`名额已用完` could never appear**, because a
        * link in those states had already been filtered out. The states existed in the code and were
        * unreachable on screen, which is `教训.md` §8.11 in miniature.
        */}
      {all.length > 0 ? (
        <ul className="overflow-hidden rounded-card border border-line bg-surface">
          {all.map((link) => (
            <LinkRow
              key={link.id}
              link={link}
              busy={revoke.isPending}
              onRevoke={() => {
                setError(null);
                void revoke.mutateAsync(link.id).catch((caught: unknown) => {
                  setError(errorMessage(caught));
                });
              }}
            />
          ))}
        </ul>
      ) : null}

      {links.isSuccess && all.length === 0 ? (
        <p className="text-xs text-muted">这本账现在没有分享链接。</p>
      ) : null}

      {all.length > 0 ? (
        <p className="text-xs leading-relaxed text-muted">
          生效中 {String(live.length)} 条。撤销与过期的链接会留在列表里——
          它们记录着"谁曾经可以进来"，删掉就没有依据可查了。
        </p>
      ) : null}
    </section>
  );
}

/**
 * A row of mutually exclusive choices.
 *
 * ⚠️ **Deliberately not a `<select>`.** These are three-to-four options on a phone, and the whole
 * point of *"1–7 天、1–10 人"* is that the person sees the range at a glance — **a dropdown hides
 * exactly the thing the range is for.**
 */
function Picker<T extends string | number>({
  label,
  value,
  options,
  onPick,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onPick: (value: T) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-full text-xs text-muted sm:w-auto">{label}</span>

      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          onClick={() => {
            onPick(option.value);
          }}
          className={`rounded-field px-3 py-1.5 text-xs transition ${
            option.value === value ? "bg-brand text-white" : "bg-canvas text-muted hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function LinkRow({
  link,
  busy,
  onRevoke,
}: {
  readonly link: ShareLinkView;
  readonly busy: boolean;
  readonly onRevoke: () => void;
}): React.JSX.Element {
  const remaining = Math.max(0, link.maxUses - link.useCount);

  /**
   * ⚠️ **Why a link stopped working is shown, not left to be guessed.** The three reasons send the
   * owner to different actions — revoke another link, generate a fresh one, or raise the cap next
   * time — and **"this link no longer works" without a reason is a support question.**
   */
  const state = link.revokedAt !== null
    ? "已撤销"
    : remaining === 0
      ? "名额已用完"
      : new Date(link.expiresAt).getTime() <= Date.now()
        ? "已过期"
        : null;

  return (
    <li className="flex items-center justify-between gap-4 border-b border-line px-5 py-4 last:border-b-0">
      <span className="flex flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm text-ink">
          {link.role === "editor" ? "可编辑" : "仅查看"}
          {state === null ? (
            <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] text-brand-dark">
              生效中
            </span>
          ) : (
            <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] text-muted">{state}</span>
          )}
        </span>

        <span className="text-xs text-muted">
          {String(link.days)} 天 · 已加入 {String(link.useCount)}/{String(link.maxUses)} 人
          {remaining > 0 ? ` · 还剩 ${String(remaining)} 个名额` : ""}
        </span>

        <span className="text-xs text-muted">
          {link.lastUsedAt === null
            ? `生成于 ${link.createdAt.slice(0, 10)}`
            : `最近一次使用 ${link.lastUsedAt.slice(0, 10)}`}
        </span>
      </span>

      {link.revokedAt === null ? (
        <button
          type="button"
          disabled={busy}
          onClick={onRevoke}
          className="shrink-0 text-xs text-muted transition hover:text-danger disabled:opacity-45"
        >
          撤销
        </button>
      ) : null}
    </li>
  );
}

/** One ledger in the list. */
function BookRow({
  book,
  isCurrent,
  busy,
  onEnter,
  onDispose,
  onLeave,
}: {
  readonly book: BookSummary;
  readonly isCurrent: boolean;
  readonly busy: boolean;
  readonly onEnter: () => void;
  readonly onDispose: () => void;
  /** Leaving somebody else's ledger — the other of the two meanings the owner asked to keep apart. */
  readonly onLeave: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <button
        type="button"
        onClick={onEnter}
        disabled={busy}
        className="flex flex-1 flex-col gap-0.5 text-left"
      >
        <span className="flex items-center gap-2 text-sm text-ink">
          {book.name}
          {isCurrent ? (
            <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] text-brand-dark">
              当前
            </span>
          ) : null}
          {book.role === "viewer" ? (
            <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] text-muted">
              仅查看
            </span>
          ) : null}
        </span>

        <span className="font-mono text-xs text-muted">
          {book.bookNumber ?? "（未分配编号）"} · {String(book.memberCount)} 位成员
          {book.isCreator ? " · 我创建的" : ""}
        </span>
      </button>

      {book.isCreator && !isCurrent ? (
        <button
          type="button"
          onClick={onDispose}
          className="shrink-0 text-xs text-muted transition hover:text-danger"
        >
          弃置
        </button>
      ) : null}

      {/**
        * ⚠️ **"退出" only for ledgers I did not create, and it is a different thing from "弃置".**
        *
        * The owner asked to keep the two apart: disposing is *"整本弃置"* — the ledger itself is set
        * aside, and only its creator may do it — while this is *"我不想再显示这本账"*, one person
        * stepping out of somebody else's ledger. Showing both on the same row under one word is how
        * people dispose of a ledger they meant to leave.
        */}
      {!book.isCreator ? (
        <button
          type="button"
          disabled={busy}
          onClick={onLeave}
          className="shrink-0 text-xs text-muted transition hover:text-danger disabled:opacity-45"
        >
          退出
        </button>
      ) : null}
    </div>
  );
}
