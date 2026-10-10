import type { SVGProps } from "react";

/**
 * Icons that are used from more than one screen.
 *
 * The project's existing icons live beside the component that first needed them —
 * `CameraIcon` and `PlusIcon` in `BottomNav`, `InfoIcon` in `InfoHint`. That was
 * fine while each had one home. The gear on the download manager does not: it is a
 * control on a list, and the list is about to be joined by others.
 *
 * So this file holds the shared ones, drawn the same way as the existing icons so a
 * row of them looks like a row: `currentColor`, `aria-hidden`, and a size the caller
 * gives it.
 */

/** A cogwheel, for "settings for this row". */
export function GearIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/*
        Drawn as a circle with eight teeth rather than as a filled path: at 16px a
        filled cog turns into a blob, where an outlined one still reads as a gear.
        Eight rather than twelve because the teeth have to survive the same 16px.
      */}
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.6v2.2M12 19.2v2.2M4.35 4.35l1.55 1.55M18.1 18.1l1.55 1.55M2.6 12h2.2M19.2 12h2.2M4.35 19.65l1.55-1.55M18.1 5.9l1.55-1.55" />
    </svg>
  );
}
