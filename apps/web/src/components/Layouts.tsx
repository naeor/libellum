import { useState } from "react";

import { BottomNav } from "./BottomNav.js";
import { SyncBanner } from "./SyncBanner.js";
import { useGoBack } from "../lib/connectivity.js";

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
 */
export function TabPage({
  active,
  onNavigate,
  children,
  className = "",
}: {
  readonly active: string;
  readonly onNavigate: (to: string) => void;
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  /**
   * Whether the three recording cards above the bar are showing.
   *
   * Held here rather than inside the bar so the scrolling region can make room
   * for them. That is the whole advantage of cards above the bar over a control
   * floating over the list: nothing has to be shoved aside at the last moment,
   * because the space is reserved before anything is drawn.
   *
   * Open by default, so recording something is one tap from the moment the app
   * loads. Whether it should stay open on later visits is a preference and
   * belongs in settings — recorded in the backlog.
   */
  const [entryOpen, setEntryOpen] = useState(true);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <SyncBanner />

      <div className="flex-1 overflow-y-auto overscroll-contain">
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
          entryOpen ? "h-32" : "h-0"
        }`}
      />

      <BottomNav
        active={active}
        onNavigate={onNavigate}
        expanded={entryOpen}
        onToggle={() => {
          setEntryOpen((open) => !open);
        }}
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
