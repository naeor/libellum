import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { ConfirmDialog } from "./ConfirmDialog.js";
import { errorMessage } from "../lib/api.js";
import { useDisposeBook, useLeaveBook, type BookSummary } from "../lib/queries.js";

/**
 * **每本账本的齿轮面板 —— 底部弹出的 Bottom Sheet.**
 *
 * ⚠️ **The owner's requirement, and the one line that matters most**:
 *
 * > *"**点击齿轮不得自动切换当前账本。** 例如用户当前正在使用账本 A，但点击账本 B 的齿轮，
 * >  那么弹出的面板必须管理账本 B，而不能误用当前账本 A. 所有后续操作必须准确携带目标账本 ID."*
 *
 * ⚠️ **So `book` is a value, not a lookup, and nothing here reads the current ledger.** The panel
 * receives the *whole* book row that was tapped — name, number, role, creator flag — which means
 * **there is no code path that could accidentally consult "the current one"**: it has never been
 * given it. Every action below carries `book.id` explicitly.
 *
 * ⚠️ **That is also why this is a separate component from the page.** The page knows which ledger is
 * current (it highlights the row); the panel must not, and putting it in its own file makes the
 * absence checkable rather than a promise.
 *
 * ⚠️ **Everything here is a courtesy, not a permission.** The route behind each item checks again —
 * `requireBookForWrite` for rename and invite, `createdBy` for dispose, membership for leave. **The
 * sheet hides what the server would refuse, and the server refuses regardless of what the sheet
 * shows.** Both, not either: a hidden button is not a control, and a visible one that always fails is
 * a broken app.
 */

/** One row in the sheet. */
interface SheetItem {
  readonly key: string;
  readonly label: string;
  readonly onSelect: () => void;
}

export function BookManageSheet({
  book,
  isCurrent,
  onClose,
}: {
  readonly book: BookSummary;
  /** ⚠️ Shown as a marker only. **It never changes what the panel operates on.** */
  readonly isCurrent: boolean;
  readonly onClose: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const dispose = useDisposeBook();
  const leave = useLeaveBook();

  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<null | "leave" | "dispose">(null);
  /** ⚠️ Live drag offset, so the sheet follows the finger rather than only reacting at the end. */
  const [dragY, setDragY] = useState(0);
  const startY = useRef<number | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    sheetRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    if (confirming === null) sheetRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [confirming]);

  /**
   * ⚠️ **`Escape` closes it.** A sheet that traps a keyboard user is worse than no sheet — and on
   * desktop this is the only way out that does not involve the mouse.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || confirming !== null) return;
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const buttons = [...(sheetRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, confirming]);

  /**
   * ⚠️ **The page behind is frozen while the sheet is open.** Without this, a drag that starts on the
   * sheet and leaves it scrolls the list underneath — which on this page is also a **gesture** (the
   * ocean's pull), so the reader would close the sheet and find the page half-retreated.
   *
   * ⚠️ **`overflow` on `body`, restored on unmount**, rather than a scroll-lock library: one property,
   * and the cleanup is what makes it safe to close in any order.
   */
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  function guarded(action: () => Promise<unknown>): void {
    setError(null);
    void action().catch((caught: unknown) => {
      setError(errorMessage(caught));
    });
  }

  /**
   * ⚠️ **Leaving the ledger you are *in* has to reload.** Leaving changes which ledger every later
   * request addresses and which slice of the offline copy is read, and **a screen showing one
   * ledger's header over another's entries is the failure the isolation exists to prevent.** A
   * reload cannot be half-done — so it is used here for the same stated reason as entering.
   *
   * ⚠️ **Leaving a ledger you are *not* in just refreshes the list**, because nothing about the
   * current session changed.
   */
  function leaveThisBook(): void {
    setError(null);
    void leave
      .mutateAsync(book.id)
      .then(() => {
        if (isCurrent) {
          window.location.assign("/");
          return;
        }
        onClose();
      })
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
        setConfirming(null);
      });
  }

  function disposeThisBook(): void {
    setError(null);
    void dispose
      .mutateAsync(book.id)
      .then(() => {
        /** ⚠️ Disposing the ledger you are in also has to move the session off it. */
        if (isCurrent) {
          window.location.assign("/");
          return;
        }
        onClose();
      })
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
        setConfirming(null);
      });
  }

  /** ⚠️ Close, then navigate — a sheet left open over the next screen is a ghost. */
  function go(to: string): void {
    onClose();
    navigate(to);
  }

  /**
   * ⚠️ **The menu is built from `book.role` and `book.isCreator`, which both come from the server.**
   *
   * | 关系 | 能做什么 |
   * |---|---|
   * | **viewer** | 看详情、看成员、看分享链接。**不能改名、不能邀请**（服务端也会拒） |
   * | **editor** | 上面全部 + 重命名 + 邀请 |
   * | **创建者** | 上面全部 + **弃置**。**没有「退出」**——创建者退出会让账本没人能管 |
   * | **非创建者成员** | 上面全部 + **退出** |
   *
   * ⚠️ **弃置 and 退出 are different things and are never merged.** The owner: *"不要将「弃置」与「退出」
   * 混为一谈."* **弃置** sets the ledger aside for everybody and only the creator may do it;
   * **退出** is one person stepping out of somebody else's ledger.
   */
  const canWrite = book.role === "owner" || book.role === "editor";

  const items: SheetItem[] = [
    {
      key: "info",
      label: "账本详情",

      onSelect: () => {
        go(`/start/book/${book.id}`);
      },
    },
    ...(canWrite
      ? [
          {
            key: "rename",
            label: "重命名",

            onSelect: () => {
              go(`/start/book/${book.id}?rename=1`);
            },
          },
        ]
      : []),
    {
      key: "members",
      label: "成员与邀请",

      onSelect: () => {
        go(`/start/book/${book.id}/members`);
      },
    },
    {
      key: "share",
      label: "分享链接",

      onSelect: () => {
        go(`/start/book/${book.id}/share`);
      },
    },
  ];

  return (
    <>
      {/**
        * ⚠️ **The backdrop closes on tap, and it is `aria-hidden`.** It is a dismissal affordance, not
        * content — and the sheet itself carries the same actions plus a visible 关闭 row, so nothing
        * is reachable *only* by tapping outside.
        */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-overlay-soft backdrop-in"
      />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={`管理「${book.name}」`}
        /**
          * ⚠️ **Swipe-down closes it, and the offset follows the finger.** The owner listed it as one
          * of the ways out (*"向下滑动"*), and **a sheet that only moves after release feels broken** —
          * so `translateY` is driven by the live drag, and a short drag or an upward one springs back.
          */
        onTouchStart={(event) => {
          startY.current = (event.target as HTMLElement).closest("[data-sheet-drag]") ? event.touches[0]?.clientY ?? null : null;
        }}
        onTouchMove={(event) => {
          if (startY.current === null) return;
          const dy = (event.touches[0]?.clientY ?? startY.current) - startY.current;
          /** ⚠️ Downward only: pulling *up* must not lift the sheet off the bottom edge. */
          setDragY(Math.max(0, dy));
        }}
        onTouchEnd={() => {
          if (dragY > 90) onClose();
          setDragY(0);
          startY.current = null;
        }}
        style={dragY === 0 ? undefined : { transform: `translateY(${String(dragY)}px)` }}
        className={`fixed inset-x-0 bottom-0 z-50 mx-auto w-full max-w-md max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain rounded-t-sheet border border-line bg-surface pb-[env(safe-area-inset-bottom,0px)] shadow-sheet ${
          dragY === 0 ? "sheet-in" : ""
        }`}
      >
        {/* ⚠️ The drag handle — the owner asked for it, and it is also what says "this slides". */}
        <div data-sheet-drag className="flex justify-center pt-3 pb-1">
          <span aria-hidden="true" className="h-1 w-10 rounded-full bg-line" />
        </div>

        {/**
          * ⚠️ **The header repeats which ledger this is, and that is a safety feature rather than
          * decoration.** The owner: *"这部分主要是为了让用户确认自己正在操作哪一本账本。尤其是在执行
          * 退出或弃置操作前，不能让用户误认目标."* So it carries the name **and the number**, which is
          * the one thing that distinguishes two ledgers somebody named identically.
          */}
        <div data-sheet-drag className="flex items-center justify-between gap-3 px-5 pt-2 pb-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-base font-medium text-ink">{book.name}</span>
            <span className="flex flex-wrap items-center gap-2 text-helper text-muted">
              <span className="font-mono">{book.bookNumber ?? "（未分配编号）"}</span>
              <span>·</span>
              <span>{String(book.memberCount)} 人</span>
              {isCurrent ? (
                /**
                  * ⚠️ **A word, not only a colour.** The owner's rule for the list applies here too:
                  * *"不要只依赖颜色传递当前状态."*
                  */
                <span className="rounded-full bg-brand-soft px-2 py-0.5 text-micro text-brand-dark">
                  当前
                </span>
              ) : null}
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="关闭管理面板"
            className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-canvas hover:text-ink"
          >
            <SheetIcon kind="close" />
          </button>
        </div>

        {error === null ? null : (
          <p role="alert" className="mx-5 mb-3 rounded-field bg-danger-soft px-4 py-3 text-body text-danger">
            {error}
          </p>
        )}

        <ul className="border-t border-line">
          {items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                onClick={item.onSelect}
                className="flex min-h-12 w-full items-center gap-3 border-b border-line px-5 py-3 text-left transition hover:bg-canvas"
              >
                <span className="text-muted"><SheetIcon kind={item.key} /></span>
                <span className="min-w-0 flex-1 text-body text-ink">{item.label}</span>
                <span className="text-muted"><SheetIcon kind="chevron" /></span>
              </button>
            </li>
          ))}
        </ul>

        {/**
          * ⚠️ **Danger sits below, separated, and only for the relationship that may do it.**
          *
          * ⚠️ **The creator sees 弃置 and not 退出**, and the server agrees (`creator_cannot_leave`):
          * removing the last writer would leave a ledger nobody can edit, invite into or dispose of.
          * A member who is not the creator sees 退出 and not 弃置 — *"两者遵守现有业务语义和权限边界."*
          */}
        <div className="flex flex-col border-t-4 border-canvas px-5 py-2">
          {book.isCreator ? (
            <button
              type="button"
              disabled={dispose.isPending}
              onClick={() => {
                setConfirming("dispose");
              }}
              className="flex min-h-12 items-center gap-3 rounded-field py-3 text-left text-body text-danger transition hover:bg-danger-soft disabled:opacity-45"
            >
              <SheetIcon kind="archive" />
              弃置这本账
            </button>
          ) : (
            <button
              type="button"
              disabled={leave.isPending}
              onClick={() => {
                setConfirming("leave");
              }}
              className="flex min-h-12 items-center gap-3 rounded-field py-3 text-left text-body text-danger transition hover:bg-danger-soft disabled:opacity-45"
            >
              <SheetIcon kind="leave" />
              退出账本
            </button>
          )}
        </div>
      </div>

      {/**
        * ⚠️ **Both confirmations name the ledger.** The owner: *"确认内容必须明确账本名称，并说明退出后的
        * 影响."* — and it is the sheet's own reason for showing the name at the top, repeated at the
        * moment it matters most.
        */}
      <ConfirmDialog
        open={confirming === "leave"}
        title={`退出「${book.name}」？`}
        description="退出后，你将无法访问此账本，账本也不再显示在你的列表中。"
        consequences={[
          "不再拥有这本账的访问权限",
          "你记过的账目与历史都会保留",
          "你加入的其他账本不受影响",
        ]}
        confirmLabel="退出账本"
        busy={leave.isPending}
        onCancel={() => {
          setConfirming(null);
        }}
        onConfirm={leaveThisBook}
      />

      <ConfirmDialog
        open={confirming === "dispose"}
        title={`弃置「${book.name}」？`}
        description="弃置后，所有成员都将看不到此账本。数据会保留，创建者可恢复。"
        consequences={[
          "对这本账的所有成员都不再显示",
          "账目、成员、留言全部保留，不是删除",
          "你作为创建者随时可以恢复",
        ]}
        confirmLabel="弃置这本账"
        busy={dispose.isPending}
        onCancel={() => {
          setConfirming(null);
        }}
        onConfirm={disposeThisBook}
      />
    </>
  );
}

/** One quiet line-icon vocabulary for the compact management actions. */
function SheetIcon({ kind }: { readonly kind: string }): React.JSX.Element {
  const paths: Record<string, string> = {
    info: "M12 11v6m0-10v.01",
    rename: "m4 16-1 5 5-1L20 8l-4-4Z M14 6l4 4",
    members: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    share: "m10 13 4-4m-6 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
    chevron: "m9 6 6 6-6 6",
    close: "m6 6 12 12M18 6 6 18",
    archive: "M4 8v12h16V8M3 4h18v4H3Zm6 8h6",
    leave: "M10 4H4v16h6m5-12 4 4-4 4m-7-4h11",
  };
  return <svg className="size-[18px] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "info" ? <circle cx="12" cy="12" r="9" /> : null}
    {kind === "members" ? <circle cx="9" cy="7" r="4" /> : null}
    <path d={paths[kind]} />
  </svg>;
}
