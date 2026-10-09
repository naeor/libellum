import type { ReactNode } from "react";
import { Link } from "react-router";

interface IconProps {
  readonly className?: string;
}

function ListIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
      <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" />
    </svg>
  );
}

function ChartIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
      <path d="M5 19V11M12 19V5M19 19v-6" strokeLinecap="round" />
    </svg>
  );
}

function PeopleIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" strokeLinecap="round" />
      <path d="M16 6.2a3 3 0 0 1 0 5.6M17 19a5.5 5.5 0 0 0-2-4.3" strokeLinecap="round" />
    </svg>
  );
}

function PersonIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" strokeLinecap="round" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={className}>
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function MicrophoneIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
    </svg>
  );
}

function PenIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" strokeLinejoin="round" />
      <path d="M14.5 6.5 17.5 9.5" strokeLinecap="round" />
    </svg>
  );
}

export function CameraIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <path
        d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.4" />
    </svg>
  );
}

interface Tab {
  readonly to: string;
  readonly label: string;
  readonly icon: (props: IconProps) => React.JSX.Element;
  readonly primary?: boolean;
}

export const TABS: readonly Tab[] = [
  { to: "/", label: "明细", icon: ListIcon },
  { to: "/stats", label: "分析", icon: ChartIcon },
  { to: "/add", label: "记账", icon: PlusIcon, primary: true },
  { to: "/collaborators", label: "协作者", icon: PeopleIcon },
  { to: "/me", label: "账户", icon: PersonIcon },
];

interface EntryAction {
  readonly label: string;
  readonly icon: ReactNode;
  readonly available: boolean;
  readonly hint?: string;
  /** Where the card goes, when it goes anywhere. */
  readonly to?: string;
}

/**
 * The three ways to record something, in the order they appear.
 *
 * Voice and camera say they are not ready when pressed rather than being
 * hidden. A card that looks live and does nothing is worse than one that
 * admits it is not, and hiding them would make the row's shape change the day
 * they ship.
 */
const ENTRY_ACTIONS: readonly EntryAction[] = [
  { label: "语音", icon: <MicrophoneIcon className="size-6" />, available: false, hint: "即将开放" },
  { label: "手动", icon: <PenIcon className="size-6" />, available: true, to: "/add" },
  { label: "拍照", icon: <CameraIcon className="size-6" />, available: true, to: "/scan" },
];

/**
 * The bottom bar, whose centre button is a switch rather than a destination.
 *
 * Pressing it turns the `+` forty-five degrees into an `×` and unfolds three
 * cards above it. Pressing it again folds them away. The rotation is the whole
 * animation — a plus rotated forty-five degrees *is* a cross, so there is no
 * second icon to swap in and nothing to keep in sync.
 *
 * The cards sit above the bar rather than floating over the list. That is the
 * difference between this and the island it replaced: an overlay has to be
 * given room by shoving content aside, and this simply occupies space nothing
 * else wanted.
 */
export function BottomNav({
  active,
  onNavigate,
  expanded,
  onToggle,
}: {
  readonly active: string;
  readonly onNavigate: (to: string) => void;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): React.JSX.Element {
  return (
    // Not `fixed`: the frame that owns this bar is the full dynamic viewport
    // height and only scrolls its middle region, so the bar never ends up
    // underneath a browser toolbar.
    <nav
      aria-label="主导航"
      className="relative z-10 shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      {/*
        Kept mounted and animated, rather than added and removed: an element
        that appears instantly has nothing to animate, and the fade is what
        makes the row read as coming out of the button.
      */}
      <div
        aria-hidden={!expanded}
        className={`absolute inset-x-0 bottom-full transition-all duration-200 ease-out ${
          expanded ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"
        }`}
      >
        {/*
          pb-[26px]: the row sits a little lower than it first did. The cross
          button is raised 32px above the bar, so the cards' lower edge comes
          within a few pixels of its top — close, but the owner asked for the
          row to sit lower and the two do not actually touch.
        */}
        <ul className="mx-auto flex w-full max-w-md items-end justify-center gap-3 px-6 pb-[26px]">
          {ENTRY_ACTIONS.map((action) => {
            const shape =
              "flex w-[4.5rem] flex-col items-center gap-0.5 rounded-2xl bg-brand-soft py-2 text-brand-dark shadow-sm transition";

            // A real link, not a button that calls navigate(). If the router's
            // own navigation ever fails, an <a href> still works — the browser
            // does it — and it can be long-pressed and copied, which a button
            // cannot.
            if (action.to !== undefined) {
              return (
                <li key={action.label}>
                  <Link to={action.to} aria-label={`${action.label}记账`} className={`${shape} active:bg-brand-soft/70`}>
                    {action.icon}
                    <span className="text-[11px]">{action.label}</span>
                  </Link>
                </li>
              );
            }

            return (
              <li key={action.label}>
                <button
                  type="button"
                  disabled
                  tabIndex={expanded ? 0 : -1}
                  aria-label={`${action.label}记账，${action.hint ?? "即将开放"}`}
                  className={`${shape} opacity-60`}
                >
                  {action.icon}
                  <span className="text-[11px]">{action.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <ul className="mx-auto flex w-full max-w-md items-end justify-around px-2">
        {TABS.map((tab) => {
          const isActive = tab.to === active;
          const Icon = tab.icon;

          if (tab.primary === true) {
            return (
              <li key={tab.to} className="flex-1">
                <button
                  type="button"
                  onClick={onToggle}
                  aria-expanded={expanded}
                  aria-label={expanded ? "收起记账方式" : "展开记账方式"}
                  // Raised well above the bar and ringed in the bar's own
                  // colour, so it reads as the one deliberate action rather
                  // than a fifth destination.
                  className="mx-auto -mt-8 mb-2 flex size-16 items-center justify-center rounded-full bg-brand text-white shadow-lg ring-4 ring-surface transition hover:bg-brand-dark"
                >
                  <PlusIcon
                    className={`size-8 transition-transform duration-200 ease-out ${
                      expanded ? "rotate-45" : "rotate-0"
                    }`}
                  />
                </button>
              </li>
            );
          }

          return (
            <li key={tab.to} className="flex-1">
              <button
                type="button"
                onClick={() => {
                  onNavigate(tab.to);
                }}
                aria-current={isActive ? "page" : undefined}
                className={`flex w-full flex-col items-center gap-1 py-2.5 text-[11px] transition ${
                  isActive ? "text-brand-dark" : "text-muted"
                }`}
              >
                <Icon className="size-6" />
                {tab.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
