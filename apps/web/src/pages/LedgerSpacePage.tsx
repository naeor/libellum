import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import { useAuth } from "../auth/AuthProvider.js";
import { Button } from "../components/Button.js";
import { BookManageSheet } from "../components/BookManageSheet.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { AvatarIcon } from "../components/Icons.js";
import { GearIcon, PlusIcon } from "../components/Icons.js";
import { OceanBackdrop } from "../components/OceanBackdrop.js";
import { SkeletonRows } from "../components/States.js";
import { APP_VERSION } from "../lib/version.js";
import { errorMessage } from "../lib/api.js";
import { markPresentationSeen, readSeenPresentation, useSpaceTransition } from "../lib/spaceTransition.js";
import {
  useActivateBook,
  useBooks,
  useCreateBook,
  useLedger,
  useRestoreBook,
  type BookSummary,
} from "../lib/queries.js";

/**
 * **开始页 / 账本空间 —— 选择、创建与管理账本的地方。**
 *
 * ⚠️ **It is a first-level page with no bottom tab bar, and that is deliberate.** The owner:
 * *"开始页是特殊的一级页面，不需要模仿其他四个主页面的底部导航结构"* and *"开始页不增加底部 Tab 导航栏."*
 * The reason shows in the layout: this page is a **place you come from**, and once you are in a ledger
 * the bar appears. Putting it here too would offer navigation to somewhere the reader has not chosen
 * to be yet.
 *
 * ⚠️ **The wave is untouched.** `OceanBackdrop`, `useSpaceTransition`, `transitionPhysics` and the
 * first-run memory are all as they were — the owner's instruction for this task was explicit:
 * *"不要改动关于海浪的任何动画机制。关于动画部分，你需要改动的只有向上拉的提示词和箭头."*
 * The only thing that changed about the sea is **what sits on top of it** (the account avatar) and
 * **how the tip fades** — neither touches a curve, a colour, a height or a frequency.
 *
 * ⚠️ **What this page no longer carries.** It used to open with a full 分享这本账 module — permission,
 * lifetime, use cap, generate, manage, revoke — sitting between the list and the rest. The owner's
 * diagnosis: *"开始页承载了过多管理功能……导致页面结构过于复杂，空间利用不合理."* **All of it moved
 * behind the per-ledger gear**, which is where the rest of the management was already going.
 */
export function LedgerSpacePage(): React.JSX.Element {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [initial] = useState(() => (readSeenPresentation(user?.id) ? 1 : 0));
  const space = useSpaceTransition(initial);
  const contentRef = useRef<HTMLDivElement>(null);

  // The compact wordmark shares the real content edge, including centered layouts
  // and the width occupied by a classic scrollbar. The same p still drives its travel.
  useLayoutEffect(() => {
    const root = space.rootRef.current;
    const content = contentRef.current;
    const scroller = space.scrollRef.current;
    if (!root || !content || !scroller) return;
    let previous = "";
    const align = (): void => {
      const left = content.getBoundingClientRect().left - root.getBoundingClientRect().left
        + Number.parseFloat(getComputedStyle(content).paddingLeft);
      const value = `${left}px`;
      if (value !== previous) root.style.setProperty("--space-content-left", value);
      previous = value;
    };
    const observer = new ResizeObserver(align);
    observer.observe(content);
    observer.observe(scroller);
    align();
    return () => observer.disconnect();
  }, [space.rootRef, space.scrollRef]);


  /**
   * ⚠️ **The ordinary state is remembered as soon as it is reached**, not on unmount: the reader may
   * close the tab from the list, and **a welcome that returns because the tab was closed is the
   * "startup advertisement" the owner ruled out.**
   *
   * ⚠️ **He restated the requirement for this task** — *"不能因为本次 UI 调整导致每次进入开始页都重新
   * 播放完整展示态"* — and it is why the mechanism below is **kept exactly as it was**: the decision
   * is made once, in `useState`'s initialiser, from a per-account `localStorage` flag.
   */
  useEffect(() => {
    if (space.atList) markPresentationSeen(user?.id);
  }, [space.atList, user?.id]);

  const books = useBooks();
  /**
    * ⚠️ **Read only to mark which row is current.** The page needs to know; the gear panel must not
    * — see `BookManageSheet`. Keeping `useLedger()` here and passing the *book row* to the sheet is
    * what keeps those two facts apart.
    */
  const current = useLedger();
  const createBook = useCreateBook();
  const activateBook = useActivateBook();
  const restoreBook = useRestoreBook();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  /** ⚠️ **The ledger whose gear was tapped** — a value, never a lookup. See `BookManageSheet`. */
  const [managing, setManaging] = useState<BookSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const currentBookId = current.data?.book.id ?? null;
  const list = books.data?.books ?? [];

  async function enterLedger(bookId: string): Promise<void> {
    /**
     * ⚠️ **Clicking the ledger you are already in still enters it.** The owner: *"即使点击已经处于当前
     * 状态的账本，也可以直接进入明细."* So this is an early exit to the entries screen, not a no-op —
     * **otherwise the most obvious row on the page would appear to do nothing.**
     */
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
    <div ref={space.rootRef} className="ledger-space" style={{ ["--p" as string]: initial }}>
      {/**
        * ⚠️ **The account avatar is a *child of the ocean*, not a sibling.**
        *
        * It has to line up with the wordmark — *"纵轴方向上跟左边的 logo 对齐"* — and the wordmark is
        * positioned inside this box with an interpolation between the two states. **Putting the button
        * in the same box lets it use the same expression**, so the alignment holds at every point of
        * the drag instead of only at the two ends. See `.space-account` in `index.css`.
        *
        * ⚠️ **`interactive` is what makes it tappable.** The ocean is `pointer-events: none` and
        * `aria-hidden` by default — correct for a drawing, and silently fatal for a button.
        */}
      <OceanBackdrop interactive>
        <AccountButton enabled={space.atList} />
      </OceanBackdrop>

      {/**
        * ⚠️ **The account avatar, in the green band's top-right (1.10.08).**
        *
        * The owner's placement: *"在海浪收缩后的绿色品牌区域内，右上角新增一个圆形账户头像按钮……
        * 与现有 Libellum 品牌标题形成自然的左右布局."*
        *
        * ⚠️ **Its opacity is a function of `--p`, the same number the sea is drawn from.** He asked for
        * exactly that and warned against the alternative: *"请优先复用现有海浪过渡进度，避免独立计时器
        * 导致动画不同步."* A `setTimeout` or a second animation would drift from a dragged sea;
        * a `calc()` on `--p` cannot, because there is only one number.
        *
        * | `--p` | 头像 |
        * |---|---|
        * | 0（完全展开） | 不可见 —— *"海浪完全展开时：头像不可见，也不可点击"* |
        * | 0.7 | 仍为 0 |
        * | ~0.75 → 1 | 平滑淡入 —— *"向收缩态过渡时：头像逐渐显示"* |
        *
        * ⚠️ **It appears slightly earlier than the tip ramps in**, on purpose: the tip is a
        * full-screen brand element that should wait until the sea has finished, while the avatar is a
        * small corner control the reader may already be reaching for. **Both still come from `--p`**,
        * so neither can desync from the gesture.
        *
        * ⚠️ **No new height was added to the collapsed sea.** The avatar is positioned inside the
        * existing ocean band, which the owner required: *"不应为了添加头像而大幅增加收缩态海浪高度."*
        */}
      {/* Opacity and input eligibility both follow live progress in useSpaceTransition. */}
      <div className="space-cue-window">
        <button
          type="button"
          className="space-cue"
          onClick={() => space.goTo(1)}
          aria-label="展开账本列表"
        >
          <svg width="24" height="28" viewBox="0 0 24 28" fill="none" aria-hidden="true">
            <path d="M12 25V5m-7 7 7-7 7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>上滑进入我的账本</span>
        </button>
      </div>

      {/**
        * ⚠️ **The scrolling region is `inert` while the sea is out.** That is what stops a stray tap
        * or an arrow key from reaching content nobody can see yet — and it is the same mechanism the
        * hook already uses on the scroll element itself.
        */}
      <div ref={space.scrollRef} className="space-scroll" tabIndex={0} aria-label="账本列表">
        <div ref={contentRef} className="mx-auto w-full max-w-md px-6 space-content">
          {error === null ? null : (
            <p role="alert" className="mb-4 rounded-field bg-danger-soft px-4 py-3 text-body text-danger">
              {error}
            </p>
          )}

          {switching ? (
            <p role="status" className="mb-4 text-body text-muted">
              正在切换到那本账……
            </p>
          ) : null}

          {books.isPending ? (
            <div className="flex-1">
              <SkeletonRows rows={2} />
            </div>
          ) : null}

          {books.isSuccess ? (
            <div className="flex flex-1 flex-col">
              {/**
                * ⚠️ **「我的账本」plus a count, and no separate username line.** The owner removed it:
                * *"不再额外显示独立的用户名一行，因为账户身份已有专门的账户入口和账户页面."*
                * The count is the server's list length — **never written down** (`"账本总数应来自真实
                * 账本数据，不得写死"`).
                *
                * ⚠️ **It is a content heading, not a brand heading** — *"该标题属于内容区标题，不需要采用
                * 和顶部 Libellum 品牌文字同等的尺寸或强调程度."* So it is `text-base font-medium`, well
                * below the brand's `2.1rem`.
                */}
              <div className="mb-2.5 flex items-baseline justify-between gap-3">
                <h1 className="text-base font-medium text-ink">我的账本</h1>
                <span className="shrink-0 text-helper text-muted">共 {String(list.length)} 本</span>
              </div>

              {list.length === 0 ? (
                <EmptyState
                  onCreate={() => {
                    setCreating(true);
                  }}
                />
              ) : (
                /**
                  * ⚠️ **One container, rows separated by hairlines, no card per ledger.** The owner:
                  * *"采用一个统一的大列表容器。每本账本直接排列为一行……不要给每一本账本再套一张完整的
                  * 独立卡片."* This is the same container rule as the 协作 page — see `SectionFrame`.
                  */
                <ul className="overflow-hidden rounded-card border border-line bg-surface">
                  {list.map((book) => (
                    <li key={book.id} className="border-b border-line last:border-b-0">
                      <BookRow
                        book={book}
                        isCurrent={book.id === currentBookId}
                        busy={switching}
                        onEnter={() => void enterLedger(book.id)}
                        onManage={() => {
                          setManaging(book);
                        }}
                      />
                    </li>
                  ))}
                </ul>
              )}

              {list.length === 0 ? null : (
                <div className="mt-3">
                  {creating ? (
                    <NewBookForm
                      name={name}
                      onName={setName}
                      busy={createBook.isPending}
                      onSubmit={() => void submitCreate()}
                      onCancel={() => {
                        setCreating(false);
                        setName("");
                      }}
                    />
                  ) : (
                    /**
                      * ⚠️ **A light "new ledger" control, not a full-width solid green button.** The
                      * owner: *"不再使用占据整行、视觉权重特别高的大型绿色实心按钮……建议使用较轻量的按钮：
                      * 加号图标；绿色文字."* With ledgers already present this is a **secondary**
                      * action, and it should not out-shout the list.
                      */
                    <button
                      type="button"
                      onClick={() => {
                        setCreating(true);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-field px-3 py-2 text-body text-brand transition hover:bg-brand-soft"
                    >
                      <PlusIcon />
                      新建账本
                    </button>
                  )}
                </div>
              )}

              {books.data.disposed.length > 0 ? (
                <DisposedSection
                  disposed={books.data.disposed}
                  busy={restoreBook.isPending}
                  onRestore={(bookId) => {
                    setError(null);
                    void restoreBook.mutateAsync(bookId).catch((caught: unknown) => {
                      setError(errorMessage(caught));
                    });
                  }}
                />
              ) : null}

              <p className="mt-5 text-helper-relaxed text-muted">
                账本编号用于两个人核对"看的是不是同一本账"。它不能用来搜索账本——
                加入别人的账本只能通过邀请。
              </p>

              {/**
                * ⚠️ **The footer, and it is deliberately not a card.** The owner: *"不使用一张很大的功能
                * 卡片包裹 Footer。不要让 Footer 与账本列表、新建入口争夺视觉注意力."* It is small text at
                * the bottom of the scroll region, so with few ledgers it sits under them and with many it
                * simply travels further down.
                */}
              <ProjectFooter />
            </div>
          ) : null}
        </div>
      </div>

      {/**
        * ⚠️ **The sheet is rendered here but manages `managing`, which the gear set.** Nothing in this
        * page reads the current ledger to build it — see `BookManageSheet` for why that is the whole
        * point.
        */}
      {managing === null ? null : (
        <BookManageSheet
          book={managing}
          isCurrent={managing.id === currentBookId}
          onClose={() => {
            setManaging(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * **The account avatar.**
 *
 * ⚠️ **An `<a>` rather than a `<Link>`, and that is not a style choice.** The avatar lives inside the
 * animated root, which writes `--p` to the DOM every frame; navigating through the router would keep
 * this component mounted while the ledger list loads underneath — **and a half-transitioned sea over
 * the account screen is the kind of mixture the reload rule exists to prevent.** A real navigation
 * also lets the browser's back button return here, which is what the owner asked for:
 * *"从账户页面能够通过合理的现有入口返回账本空间."*
 */
function AccountButton({ enabled }: { readonly enabled: boolean }): React.JSX.Element {
  return (
    <a
      href="/me"
      /**
        * ⚠️ **Tappable only once the sea has finished retreating**, which is also the moment the
        * avatar is fully opaque. During the journey it is transparent, and **an invisible 44 px target
        * in the corner would swallow taps aimed at the sea** — the same rule the tip follows, decided
        * in the same place and for the same reason.
        *
        * ⚠️ **`enabled` is the settled state, not the animated value.** `--p` is written straight to
        * the DOM every frame and React is told only at the ends (see `useSpaceTransition`), so this is
        * deliberately coarse — and coarse is the safe direction: **a tap mid-drag is on the sea, not
        * on a button nobody can see yet.**
        */
      style={{ pointerEvents: enabled ? "auto" : "none" }}
      aria-label="账户"
      className="space-account"
    >
      {/**
        * ⚠️ **A portrait silhouette, in the muted grey, not the six-petal flower.** The owner asked
        * for the conventional account placeholder — *"一个灰色的默认头像半身像"* — and `DefaultAvatar`
        * (the project's own flower) stays where a person's own picture would go. See `AvatarIcon`.
        *
        * ⚠️ **No ring.** A white ring on the green band made a bright dot of the corner; the portrait's
        * own tinted disc is enough to lift it off the water.
        */}
      <AvatarIcon className="size-[26px] text-muted" />
    </a>
  );
}

/**
 * **One ledger in the list.**
 *
 * ⚠️ **Two tap targets, and they must not be confused with each other.** The owner separated them in
 * as many words: tapping the row **enters** the ledger, and tapping the gear **opens management for
 * that ledger without entering it** — *"点击齿轮不得自动切换当前账本."*
 *
 * ⚠️ **A `button` for the row rather than a `Link`.** Entering a ledger is not a route: it activates a
 * ledger on the server and then reloads, and a link would promise a URL that does not exist. It also
 * keeps the gear a **sibling** rather than something nested inside another interactive element —
 * nested controls are invalid HTML and screen readers announce one target where there are two.
 */
function BookRow({
  book,
  isCurrent,
  busy,
  onEnter,
  onManage,
}: {
  readonly book: BookSummary;
  readonly isCurrent: boolean;
  readonly busy: boolean;
  readonly onEnter: () => void;
  readonly onManage: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-stretch">
      <button
        type="button"
        disabled={busy}
        onClick={onEnter}
        className="flex min-w-0 flex-1 flex-col gap-0.5 px-5 py-3.5 text-left transition hover:bg-canvas disabled:opacity-45"
      >
        {/**
          * ⚠️ **The current ledger is marked twice: colour *and* the word 当前.** The owner:
          * *"不要只依赖颜色传递当前状态."* And **not a large green fill** — *"不要将整个当前账本行改成
          面积过大的绿色背景，以免破坏列表的轻盈感."*
          */}
        <span className="flex items-center gap-2">
          <span
            className={`truncate text-sm ${isCurrent ? "font-medium text-brand-dark" : "text-ink"}`}
          >
            {book.name}
          </span>
          {isCurrent ? (
            <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-micro text-brand-dark">
              当前
            </span>
          ) : null}
        </span>

        <span className="flex flex-wrap items-center gap-x-2 text-helper text-muted">
          <span className="font-mono">{book.bookNumber ?? "（未分配编号）"}</span>
          <span>·</span>
          <span>{String(book.memberCount)} 人</span>
        </span>
      </button>

      {/**
        * ⚠️ **The gear: small icon, generous target, aligned on every row.** The owner: *"点击区域足够大，
        但视觉图标保持小巧"* and *"所有账本的齿轮位置一致."* `w-12` with a 18px glyph gives a thumb
        something to hit without the icon becoming the loudest thing on the row.
        */}
      <button
        type="button"
        onClick={onManage}
        aria-label={`管理「${book.name}」`}
        className="flex min-h-11 w-12 shrink-0 items-center justify-center text-muted transition hover:bg-canvas hover:text-ink"
      >
        <GearIcon className="size-[18px]" />
      </button>
    </div>
  );
}

/** **No ledgers at all** — the one case where the create action *is* the main thing on screen. */
function EmptyState({ onCreate }: { readonly onCreate: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-4 rounded-card border border-line bg-surface px-5 py-6">
      {/**
        * ⚠️ **「尚无」 rather than 「还没有」, and `copy.test.ts` is what caught it.** This screen is on
        * that test's list, and the owner's register rule is that the interface reads as objective
        * description rather than as a person talking. **The rule was already written down; the test
        * exists so a newly written screen cannot quietly opt out of it.**
        */}
      <p className="text-body-relaxed text-muted">
        当前账号尚无账本。创建第一本之后即可开始记账，也可以邀请别人一起记。
      </p>
      <Button onClick={onCreate}>新建第一本账</Button>
    </div>
  );
}

/** **The name field, shown in place of the light create button.** */
function NewBookForm({
  name,
  onName,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly name: string;
  readonly onName: (value: string) => void;
  readonly busy: boolean;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <label className="flex flex-col gap-1.5 text-body text-muted">
        新账本的名称
        <input
          ref={ref}
          value={name}
          onChange={(event) => {
            onName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSubmit();
          }}
          /** ⚠️ The same 40 the server enforces — a longer name would be refused after typing it. */
          maxLength={40}
          placeholder="我的账本"
          className="rounded-field border border-line bg-canvas px-4 py-3 text-ink"
        />
      </label>

      <div className="flex gap-3">
        <Button fullWidth={false} disabled={busy} onClick={onSubmit}>
          {busy ? "正在创建……" : "创建并进入"}
        </Button>
        <Button variant="secondary" fullWidth={false} onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

/**
 * **已弃置 —— the way back.**
 *
 * ⚠️ **Kept on this page rather than moved into the gear panel.** A disposed ledger is not in the
 * list, so there is no row and no gear to hang it on — and **its whole purpose is to be findable
 * after you have stopped seeing it.** The owner's rule for the two concepts still holds here: this is
 * 弃置 (setting aside, reversible), never 删除.
 */
function DisposedSection({
  disposed,
  busy,
  onRestore,
}: {
  readonly disposed: readonly BookSummary[];
  readonly busy: boolean;
  readonly onRestore: (bookId: string) => void;
}): React.JSX.Element {
  return (
    <section className="mt-6 flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-ink">已弃置</h2>
        <span className="shrink-0 text-helper text-muted">共 {String(disposed.length)} 本</span>
      </div>

      <p className="text-helper-relaxed text-muted">
        这些账本的数据都还在，只是不再出现在列表里。恢复后立刻可以使用。
      </p>

      <ul className="overflow-hidden rounded-card border border-line bg-surface">
        {disposed.map((book) => (
          <li
            key={book.id}
            className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5 last:border-b-0"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-body text-ink">{book.name}</span>
              <span className="font-mono text-helper text-muted">
                {book.bookNumber ?? "（未分配编号）"}
              </span>
            </span>

            <Button
              variant="secondary"
              fullWidth={false}
              disabled={busy}
              onClick={() => {
                onRestore(book.id);
              }}
            >
              恢复
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * **The project and legal footer.**
 *
 * ⚠️ **Small, quiet, and not a card** — the owner: *"采用小字号、次要文字颜色与适当间距。不使用一张很大的
 * 功能卡片包裹 Footer."*
 *
 * ⚠️ **⚠️ All three are grey and all three are tappable** (owner, 2026-10-13): *"把他们仨放到屏幕的最底下。
 * 并且颜色都是灰色，只是点击可以跳转."*
 *
 * So 隐私政策 and 使用条款 stopped being plain text and became **links to real pages** — pages that,
 * for now, say the content is not written. **That is the honest version of the same rule** the owner
 * set earlier: *"不要编造已经具备法律效力的条款，也不要未经确认就宣称符合某项法规."* A page that
 * states what is still missing is not a fabricated policy; **a link that went nowhere, or a policy
 * that invented terms, would both be worse.**
 *
 * ⚠️ **One grey, no green**, and it is the muted token for all three. The old footer coloured 关于
 * brand-green, which is what made it the loudest thing in a footer the owner wants quiet.
 *
 * ⚠️ **`Link`, not `<a>`, and the `from` state matters.** A raw `<a href>` is a full page load: it
 * resets history, so 返回 on the About screen would fall back to 设置 — **which is the bounce the owner
 * reported.** Passing the origin through router state is what makes 返回 land on the start page.
 * See `useGoBack`.
 */
function ProjectFooter(): React.JSX.Element {
  const linkClass = "text-muted transition hover:text-ink";

  return (
    <footer className="mt-auto flex shrink-0 flex-col items-center gap-2 pt-8 text-xs">
      <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
        <Link to="/about" state={{ from: "/start" }} className={linkClass}>
          关于 Libevra
        </Link>
        <Link to="/legal/privacy" state={{ from: "/start" }} className={linkClass}>
          隐私政策
        </Link>
        <Link to="/legal/terms" state={{ from: "/start" }} className={linkClass}>
          使用条款
        </Link>
      </nav>

      <p className="text-center leading-relaxed text-muted">
        Libevra 是一个离线优先的记账工具，AGPL-3.0 开源。
        <span className="ml-1 font-mono">v{APP_VERSION}</span>
      </p>
    </footer>
  );
}
