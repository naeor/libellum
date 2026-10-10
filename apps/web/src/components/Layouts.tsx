import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";

import { BottomNav, type EntryCards } from "./BottomNav.js";
import { SyncBanner } from "./SyncBanner.js";
import { useGoBack } from "../lib/connectivity.js";

/**
 * Whether the three recording cards are open, and who may close them.
 *
 * **The owner's design goal, in his words**: recording should be startable from
 * as many screens as possible. The three ways to record — voice, by hand, by
 * photograph — have nowhere else to live, so the centre button unfolds them
 * wherever the reader happens to be.
 *
 * This used to be local state inside each frame, which made every tab its own
 * island: the analysis screen could not close a menu the ledger had opened, and
 * nothing could close a menu on navigation. One piece of state for the whole app
 * is what makes "open anywhere, closed when you move on" expressible.
 *
 * The state lives in context rather than in the router, deliberately: it is
 * *interface* state, it should not survive a reload, and it should not appear in
 * a URL somebody can share.
 */
interface EntryMenuValue {
  readonly open: boolean;
  readonly toggle: () => void;
  readonly close: () => void;
}

const EntryMenuContext = createContext<EntryMenuValue>({
  open: false,
  toggle: () => undefined,
  close: () => undefined,
});

/** For a screen that wants to close the menu itself — the ledger, on scrolling. */
export function useEntryMenu(): EntryMenuValue {
  return useContext(EntryMenuContext);
}

/**
 * What happens to the menu, as a pure function.
 *
 * A pure function so the rule can be *tested* rather than described: the
 * behaviour lives in a `useEffect` that a test without a DOM cannot reach, and a
 * rule that is only asserted in a comment is a rule that drifts.
 *
 *  * **Pressing the button always unfolds the three options.** Never a jump to
 *    the manual form: somebody who wanted the camera would have had to open the
 *    menu anyway, so the jump only ever cost them a press.
 *  * **Arriving at any screen folds them**, so a page starts with its own
 *    content rather than with a menu somebody opened for a different one. The
 *    ledger is not an exception at the moment of arrival; it only differs in
 *    *when* it folds — see the third case.
 *  * **Scrolling down into the ledger's list folds them**, because the summary
 *    has just collapsed to give the entries room and an open menu would spend
 *    exactly what was won. This is a fold within a screen rather than on
 *    arrival, which is why it is a separate event.
 */
export type MenuEvent =
  | { readonly type: "toggle" }
  | { readonly type: "arrivedSomewhere" }
  | { readonly type: "scrolledIntoList" };

export function menuAfter(open: boolean, event: MenuEvent): boolean {
  switch (event.type) {
    case "toggle":
      return !open;
    case "arrivedSomewhere":
    case "scrolledIntoList":
      return false;
  }
}

/**
 * Holds the menu for every tab, and folds it when the reader moves on.
 */
export function AppShell({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);

  // The pathname *after* the first render. Comparing against it means the fold
  // cannot fire for the page the reader is already on when the app starts —
  // otherwise a reload of the ledger would arrive with its menu already shut.
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current !== pathname) {
      previous.current = pathname;
      setOpen((current) => menuAfter(current, { type: "arrivedSomewhere" }));
    }
  }, [pathname]);

  const value = useMemo<EntryMenuValue>(
    () => ({
      open,
      toggle: () => {
        setOpen((current) => menuAfter(current, { type: "toggle" }));
      },
      close: () => {
        setOpen((current) => menuAfter(current, { type: "scrolledIntoList" }));
      },
    }),
    [open],
  );

  return <EntryMenuContext.Provider value={value}>{children}</EntryMenuContext.Provider>;
}

/**
 * Frame for the five tab destinations.
 *
 * The height is the **dynamic** viewport height and only the middle region
 * scrolls, so the navigation bar is a flex sibling of the content rather than
 * something pinned to the bottom of the document. That matters on a phone:
 * with a document-scrolling layout, iOS Safari expands its own toolbar as soon
 * as you scroll up and the app's navigation disappears underneath it, so the
 * user has to scroll back down to reach the tabs. With the page itself never
 * scrolling, there is nothing for that toolbar to react to.
 *
 * **Every tab gets the three recording options.** That is the owner's design
 * goal rather than an oversight: recording should be startable from wherever the
 * reader is, and the camera and voice routes have no other home. What a tab does
 * *not* get is the menu left open behind it — see `AppShell`.
 */
export function TabPage({
  active,
  onNavigate,
  children,
  className = "",
  scrollRef,
  rootRef,
  rootClassName = "",
}: {
  readonly active: string;
  readonly onNavigate: (to: string) => void;
  readonly children: React.ReactNode;
  readonly className?: string;
  /**
   * Exposed so a screen can follow its own scroll position. Only the ledger
   * needs it — it is the one screen whose layout changes as the reader moves.
   */
  readonly scrollRef?: React.RefObject<HTMLDivElement | null>;
  /** The outermost element, for a screen that drives its own animation. */
  readonly rootRef?: React.RefObject<HTMLDivElement | null>;
  readonly rootClassName?: string;
}): React.JSX.Element {
  const menu = useEntryMenu();

  return (
    <div ref={rootRef} className={`flex h-dvh flex-col overflow-hidden ${rootClassName}`}>
      <SyncBanner />

      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain">
        {/* pb-24 leaves room for the raised entry button, which reaches up
            above the bar and would otherwise cover the last row of a list. */}
        <div className={`mx-auto flex w-full max-w-md flex-col pb-24 ${className}`}>{children}</div>
      </div>

      {/*
        Real space for the cards, not a floating layer over the list.
        The scroll region shrinks by this much while they are out, so nothing
        ever passes behind them — they are in the layout rather than on top of
        it. Animating the height keeps the list from jumping as they fold away.
      */}
      <div
        aria-hidden="true"
        className={`shrink-0 transition-[height] duration-200 ease-out ${
          menu.open ? "h-[100px]" : "h-0"
        }`}
      />

      <BottomNav
        active={active}
        onNavigate={onNavigate}
        cards={{ mode: "toggle", expanded: menu.open, active: false, onToggle: menu.toggle }}
      />
    </div>
  );
}
/**
 * Frame for screens reached *from* a tab: back control at the top, no bottom
 * bar, because a form is a place you leave, not a place you switch away from.
 *
 * Back always returns to the screen the user actually came from. The same
 * management screen can be opened from more than one place, so a fixed parent
 * would send somebody somewhere they had never been — which reads as a bug even
 * though nothing is broken. `backTo` is only the fallback for a deep link that
 * has no history behind it.
 */
export function InnerPage({
  title,
  subtitle,
  backTo = "/",
  onBack,
  actions,
  children,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly backTo?: string;
  /** Used when a screen must finish something before it leaves. */
  readonly onBack?: () => void;
  readonly actions?: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const goBack = useGoBack(backTo);
  const handleBack = onBack ?? goBack;

  return (
    <>
      <SyncBanner />
      <main className="mx-auto flex min-h-full w-full max-w-md flex-col gap-6 px-6 py-8">
        <div className="flex items-start justify-between gap-4">
          {/* Deliberately generous: this is the control a thumb reaches for on
              a phone, and a small target means missed taps. */}
          <button
            type="button"
            data-back-control
            onClick={handleBack}
            className="-mt-1 -ml-2 flex items-center gap-1.5 rounded-field px-2.5 py-2.5 text-base text-muted transition hover:bg-brand-soft hover:text-ink"
          >
            <span aria-hidden="true" className="text-lg leading-none">
              ←
            </span>
            返回
          </button>
          {actions}
        </div>

        <header>
          <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
          {subtitle ? <p className="mt-1.5 text-sm leading-relaxed text-muted">{subtitle}</p> : null}
        </header>

        {children}
      </main>
    </>
  );
}
