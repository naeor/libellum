import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { useAuth } from "../auth/AuthProvider.js";
import { Button } from "../components/Button.js";
import { ChoiceDialog } from "../components/ChoiceDialog.js";
import { OceanBackdrop } from "../components/OceanBackdrop.js";
import { QrCodeView } from "../components/QrCodeView.js";
import { SkeletonRows } from "../components/States.js";
import { errorMessage } from "../lib/api.js";
import { markPresentationSeen, readSeenPresentation, useSpaceTransition } from "../lib/spaceTransition.js";
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
export function LedgerSpacePage(): React.JSX.Element {
  const navigate = useNavigate();
  const { user } = useAuth();

  /**
   * ⚠️ **`0` is the presentation state — the sea. `1` is the ordinary one — this list.**
   *
   * ⚠️ **The progress is a React state *here*, and a ref everywhere else in the project, and the
   * difference is deliberate.** The ledger screen animates on every frame of a finger's movement, so
   * it cannot afford a re-render. **This page moves between two places in response to a gesture that
   * has already ended** — so it is two renders, and React is the right place for it.
   *
   * ⚠️ **The timing lives in CSS (`transition`) and not in the spring**, which is the second
   * departure. The owner gave a duration for this specific move — *"整体时长大致是 600–850 毫秒"* —
   * and **a spring's duration is a consequence of its constants, not something you can set.** The
   * tested spring is still what the ledger screen uses; borrowing it here would mean tuning two
   * numbers until the result happened to land in the owner's range.
   */
  /**
   * ⚠️ **The tested spring, not a CSS transition — and the reason is the gesture.**
   *
   * My first version drove `--p` from React state and let `transition: 850ms` do the movement. That
   * reads the owner's duration literally, **and it cannot follow a finger**: a CSS transition has one
   * duration and no notion of "the position the finger is at right now". The owner asked for
   * *"不同层次的波面可以带有轻微的速度差和惯性"* — **inertia is what a spring has and a transition
   * does not.**
   *
   * ⚠️ **So the physics come from `transitionPhysics.ts`** — the same spring, speed ceiling and
   * gesture rules the ledger screen uses, fixed by 13 tests. **A second implementation would be a
   * second answer to "how fast does a flick count"**, whose symptom is *"this screen feels slightly
   * off"*, the hardest kind of bug to attribute.
   *
   * ⚠️ **The owner's 600–850ms is honoured by the constants, not by a CSS rule.** The speed ceiling
   * guarantees **at least** 500ms; the spring's stiffness and damping put an ordinary gesture above
   * that. **The duration is a consequence of the motion rather than a number imposed on it**, which
   * is the only way it can also follow the finger.
   */
  const [initial] = useState(() => (readSeenPresentation(user?.id) ? 1 : 0));
  const space = useSpaceTransition(initial);

  /**
   * ⚠️ **The ordinary state is remembered as soon as it is reached**, not on unmount: the reader may
   * close the tab from the list, and **a welcome that returns because the tab was closed is the
   * "startup advertisement" the owner ruled out.**
   */
  useEffect(() => {
    if (space.atList) markPresentationSeen(user?.id);
  }, [space.atList, user?.id]);
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
    /**
     * ⚠️ **The page builds its own frame rather than using `InnerPage`, and it has to.**
     *
     * `InnerPage` is the white, `max-w-md`, back-arrow frame for screens *reached from* somewhere —
     * **and this page's second state is a full-bleed sea that must reach every edge.** It was also
     * already wrong in a smaller way: its `backTo` was `/start`, **so the back arrow pointed at the
     * page it was on.**
     *
     * ⚠️ **`fixed inset-0` for the sea and `overflow-y-auto` for the list**, because the two states
     * do not share a scroll: the sea is a fixed picture that recedes, and the ledger list scrolls
     * under it. **One scroller cannot be both.**
     */
    <div
      ref={space.rootRef}
      /**
       * ⚠️ **`overflow-x-hidden`, not `overflow-hidden`.**
       *
       * My first version hid both axes — and it looked right, because **the sea's travel would slide
       * the page sideways if it could scroll.** But this element is also the page: with `overflow:
       * hidden` **a list longer than the screen is simply cut off**, and the reader cannot reach the
       * ledgers below the fold. **That failure appears only once somebody has enough ledgers**, which
       * is the worst way for a bug to arrive.
       *
       * ⚠️ **The vertical axis has to stay scrollable for a second reason too**: `claimsGesture` only
       * takes a downward pull when `scrollTop` is 0, so **a scroller that can never move would turn
       * every downward drag into a retreat**, including the ones meant to scroll back up the list.
       */
      className="relative min-h-dvh overflow-x-hidden bg-canvas"
    >
      {/**
        * ⚠️ **The sea, and the whole of the retreat is this one transform.**
        *
        * `translateY(calc(var(--p) * -100%))` — **the picture leaves upward, it does not fade.**
        * The owner ruled out the alternative twice: *"不能只是绿色画面渐隐、白色页面渐显，更不要简单把一个
        * 完整的新页面从下面推上来覆盖旧页面."* So there is no opacity on this element at all:
        * **what the reader sees is water moving off the top of the screen, uncovering what is under
        * it** — and the layers inside it travel at their own speeds, which is where the depth comes
        * from.
        */}
      <div
        className="fixed inset-0"
        style={{
          transform: "translateY(calc(var(--p, 0) * -100%))",

        }}
      >
        <OceanBackdrop />

        {/**
          * ⚠️ **The brand text is part of the water, so it leaves with it.** Putting it in the layer
          * rather than above it is what makes the retreat read as one movement — **the title sinks
          * with the surface it is written on.**
          */}
        <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
          <p className="text-4xl font-semibold tracking-[0.18em] text-white/95">Libellum</p>
          <p className="mt-4 text-sm leading-relaxed text-white/75">记一本账，安静而长久。</p>
        </div>
      </div>

      {/**
        * ⚠️ **The ordinary state arrives from slightly below and fades in**, so the two movements are
        * opposites rather than one replacing the other: **water up, list up-behind-it.** A list that
        * simply appeared would be the "new page" the owner ruled out, even with the sea receding.
        *
        * ⚠️ **Nothing here is a React value, and that is the point.** `--p` is written by the spring on
        * every frame; **reading it into state to compute an opacity would put a re-render in the
        * middle of the animation** — the failure the ledger screen hit and the reason its progress is
        * a ref. So the opacity and the small rise are both `calc()` on the same variable the sea uses,
        * and React never hears about the movement at all.
        */}
      <div
        ref={space.scrollRef}
        /**
         * ⚠️ **The top inset, because this is a full-bleed screen now.**
         *
         * Every other screen sits inside a frame that already accounts for the notch. **This one
         * starts at the top edge of the display**, so without the inset the title sits under the
         * status bar on a phone with one — **and only on a phone with one.**
         *
         * ⚠️ There is no bottom inset here on purpose: the list is the page's own content and the
         * page scrolls, so **the last card should be able to reach the bottom edge**; the extra space
         * belongs to a fixed bar, and this screen has none.
         */
        className="space-scroll relative mx-auto w-full max-w-md px-6 pb-16"
        style={{
          /** ⚠️ The notch, plus the ordinary rhythm. */
          paddingTop: "calc(2.5rem + env(safe-area-inset-top, 0px))",
          opacity: "var(--p, 0)",
          transform: "translateY(calc((1 - var(--p, 0)) * 24px))",
        }}
      >
        <h1 className="text-2xl font-semibold tracking-tight text-ink">我的账本</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          {user?.displayName ?? ""}
        </p>
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
      </div>
    </div>
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
          {/**
            * ⚠️ **The link and the symbol sit together, and both are shown.** The owner asked for the
            * QR code *"方便当面扫码加入"* — two people in the same room. **The text stays because the
            * other case is unchanged**: somebody on a call who needs to paste it.
            *
            * ⚠️ **Same string in both**, taken from `window.location.origin` at render time, so a code
            * scanned on a phone points at whatever address the person generating it is actually using —
            * **not at a hostname baked into the bundle**, which would be wrong on every LAN and every
            * self-hosted deployment.
            */}
          <div className="mt-3 flex justify-center">
            <QrCodeView
              text={`${window.location.origin}/join/${freshToken}`}
              label="这本账的加入二维码"
            />
          </div>

          <p className="mt-2 text-center text-xs text-muted">让对方用相机扫这个码</p>
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