import { useNavigate } from "react-router";

/**
 * The entry island.
 *
 * Three ways to record something, floating over the list: by hand, by camera,
 * by voice. It exists because the bottom tab bar can only hold so much, and
 * because two of the three ways are not "go to a page and fill in a form" —
 * they are "point the phone at the thing and be done".
 *
 * Currently a **fixed** control on the right edge. The owner's design has it
 * expand while the list is being scrolled and collapse when it stops, and lets
 * the user drag it to either wall; both are recorded in the backlog and
 * deliberately not built yet, because the three actions have to work before
 * their animation is worth anything.
 *
 * The bottom tab bar's add button stays for now. The owner asked for the island
 * to be added alongside it rather than replace it, until it is clear how the
 * island should behave on the other tabs — those four screens have not been
 * designed yet, and removing a working entry point to replace it with an
 * undecided one would be a step backwards.
 */
export function EntryIsland(): React.JSX.Element {
  const navigate = useNavigate();

  return (
    <div
      className="fixed top-1/2 right-3 z-30 flex -translate-y-1/2 flex-col gap-1 rounded-full bg-brand/92 p-1.5 shadow-lg backdrop-blur-sm"
      role="group"
      aria-label="记账方式"
    >
      <IslandButton
        label="语音记账"
        hint="即将开放"
        onClick={() => undefined}
        disabled
        icon={<MicrophoneIcon />}
      />
      <IslandButton
        label="手动记账"
        onClick={() => {
          void navigate("/add");
        }}
        icon={<PenIcon />}
      />
      <IslandButton
        label="拍照记账"
        hint="即将开放"
        onClick={() => undefined}
        disabled
        icon={<CameraIcon />}
      />
    </div>
  );
}

function IslandButton({
  label,
  hint,
  onClick,
  icon,
  disabled = false,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly onClick: () => void;
  readonly icon: React.ReactNode;
  readonly disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // 44px: the smallest target a thumb hits reliably. These are the only
      // controls on the screen that float over content, so a miss is costly.
      className={`flex size-11 items-center justify-center rounded-full text-white transition ${
        disabled ? "opacity-45" : "hover:bg-white/15 active:bg-white/25"
      }`}
      title={hint === undefined ? label : `${label}（${hint}）`}
      aria-label={hint === undefined ? label : `${label}，${hint}`}
    >
      {icon}
    </button>
  );
}

function MicrophoneIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-6" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
    </svg>
  );
}

function PenIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-6" aria-hidden="true">
      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" strokeLinejoin="round" />
      <path d="M14.5 6.5 17.5 9.5" strokeLinecap="round" />
    </svg>
  );
}

function CameraIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-6" aria-hidden="true">
      <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="3.4" />
    </svg>
  );
}
