/**
 * Bottom navigation — 明细 · 分析 · 记账 · 协作者 · 我的.
 *
 * The entry button sits in the middle, larger and in the accent colour,
 * because recording an entry is the one thing this app exists for; every other
 * destination is somewhere you go to look at something.
 *
 * Icons are inline SVG rather than a component library: five icons do not
 * justify a dependency, and stroke-only paths match the flat look.
 */

interface IconProps {
  readonly className?: string;
}

function ListIcon({ className = "" }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
    </svg>
  );
}

function ChartIcon({ className = "" }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <path d="M5 19V10M12 19V5M19 19v-6" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon({ className = "" }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={className}>
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function PeopleIcon({ className = "" }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" strokeLinecap="round" />
      <path d="M16 6.5a3 3 0 0 1 0 5.6M17.5 19c0-2-.6-3.6-1.6-4.7" strokeLinecap="round" />
    </svg>
  );
}

function PersonIcon({ className = "" }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5.5 19.5c0-3.3 2.9-5.6 6.5-5.6s6.5 2.3 6.5 5.6" strokeLinecap="round" />
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
  { to: "/me", label: "我的", icon: PersonIcon },
];

export function BottomNav({
  active,
  onNavigate,
}: {
  readonly active: string;
  readonly onNavigate: (to: string) => void;
}): React.JSX.Element {
  return (
    <nav
      aria-label="主导航"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto flex w-full max-w-md items-end justify-around px-2">
        {TABS.map((tab) => {
          const isActive = tab.to === active;
          const Icon = tab.icon;

          if (tab.primary === true) {
            return (
              <li key={tab.to} className="flex-1">
                <button
                  type="button"
                  onClick={() => {
                    onNavigate(tab.to);
                  }}
                  aria-label={tab.label}
                  className="mx-auto -mt-6 flex size-14 flex-col items-center justify-center rounded-full bg-brand text-white shadow-lg transition hover:bg-brand-dark"
                >
                  <Icon className="size-7" />
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
