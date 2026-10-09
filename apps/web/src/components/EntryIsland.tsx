import { useNavigate } from "react-router";

export type IslandOrientation = "horizontal" | "vertical";

/**
 * The entry island: three ways to record something, in one control.
 *
 * It has two shapes and three sizes, and they are all the same component:
 *
 *  * **horizontal** — three white circles on a green base, sitting inside the
 *    green summary at the foot of the ledger screen
 *  * **vertical** — the same three circles stacked in a capsule fixed to the
 *    left edge, for when the summary has scrolled away
 *  * **collapsed** — a single translucent circle with a `+`, shown only while
 *    the list is moving so it does not compete with the content
 *
 * Collapsed is a *state of the island*, not a fourth way to record anything:
 * pressing it reopens the three choices rather than opening the pen. That was
 * the owner's explicit requirement, and it is the right call — a control that
 * means "record by hand" when compressed and "choose how to record" otherwise
 * would be a different control wearing the same icon.
 *
 * Voice and camera are marked unavailable rather than hidden, and they say so
 * when pressed. A button that looks ready and does nothing is worse than one
 * that admits it is not.
 */
export function EntryIsland({
  orientation,
  collapsed = false,
  onExpand,
}: {
  readonly orientation: IslandOrientation;
  readonly collapsed?: boolean;
  readonly onExpand?: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();

  const actions = {
    voice: { label: "语音记账", available: false, hint: "即将开放" },
    manual: { label: "手动记账", available: true },
    camera: { label: "拍照记账", available: false, hint: "即将开放" },
  } as const;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onExpand}
        aria-label="展开记账方式"
        className="flex size-14 items-center justify-center rounded-full bg-brand/85 text-white shadow-md backdrop-blur-[2px] transition active:scale-95"
      >
        <PlusIcon />
      </button>
    );
  }

  const buttons = (
    <>
      <IslandButton
        {...actions.voice}
        onClick={(): void => undefined}
        disabled
      />
      <IslandButton
        {...actions.manual}
        onClick={(): void => {
          void navigate("/add");
        }}
      />
      <IslandButton
        {...actions.camera}
        onClick={(): void => undefined}
        disabled
      />
    </>
  );

  if (orientation === "horizontal") {
    return (
      // No background of its own: the wrapper in the summary supplies it, so
      // the base can match the green exactly and merge with it where they
      // overlap. A capsule with its own tint would read as a card resting on
      // the summary rather than a part of it.
      <div className="flex items-center gap-3" role="group" aria-label="记账方式">
        {buttons}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col items-center gap-2.5 rounded-full bg-brand/95 px-2 py-3 shadow-sm"
      role="group"
      aria-label="记账方式"
    >
      {buttons}
    </div>
  );
}

function IslandButton({
  label,
  hint,
  available,
  onClick,
  disabled = false,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly available: boolean;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}): React.JSX.Element {
  const description = available ? label : `${label}，${hint ?? "即将开放"}`;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={description}
      aria-label={description}
      // 44px: the smallest target a thumb hits reliably. These float over
      // content, so a miss costs more than it would in a list.
      className={`flex size-11 items-center justify-center rounded-full bg-white text-brand transition ${
        disabled ? "opacity-55" : "active:scale-95"
      }`}
    >
      {label.startsWith("语音") ? <MicrophoneIcon /> : null}
      {label.startsWith("手动") ? <PenIcon /> : null}
      {label.startsWith("拍照") ? <CameraIcon /> : null}
    </button>
  );
}

export function PlusIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="size-7" aria-hidden="true">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
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
      <path
        d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.4" />
    </svg>
  );
}
