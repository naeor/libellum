import type { SVGProps } from "react";

/**
 * Icons used from more than one screen.
 *
 * The project's older icons live beside the component that first needed them —
 * `CameraIcon` and `PlusIcon` in `BottomNav`, `InfoIcon` in `InfoHint`. That was fine
 * while each had one home. This file holds the ones that do not.
 *
 * Drawn the same way as the existing icons so a row of them looks like a row:
 * `currentColor`, `aria-hidden`, and a size the caller gives it.
 */

/**
 * A cogwheel, for "settings for this row".
 *
 * ⚠️ **The first version was a sun**, and the owner identified it immediately: "你画的
 * 图标实际上是小太阳，而非小齿轮——这显然不合适，小太阳不会被当成设置."
 *
 * He is right, and the reason is worth writing down, because the two are one shape
 * apart: **a disc with eight evenly spaced rays is a sun.** A gear is not a disc with
 * spikes — its teeth are **trapezoids joined to the rim**, and it has **a hole in the
 * middle**. Both of those are what make it read as machinery rather than as weather.
 *
 * So this path was computed rather than drawn by eye: eight trapezoids on a rim of
 * radius 6.2 reaching to 9.2, joined by arcs along the rim, with a hole at the centre.
 * At 16 px a hand-written squiggle loses the teeth; this keeps them, because they are
 * wide at the base and short.
 */
export function GearIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M17.78 9.75 L20.98 10.01 L20.98 13.99 L17.78 14.25 A6.2 6.2 0 0 1 17.67 14.50 L19.76 16.94 L16.94 19.76 L14.50 17.67 A6.2 6.2 0 0 1 14.25 17.78 L13.99 20.98 L10.01 20.98 L9.75 17.78 A6.2 6.2 0 0 1 9.50 17.67 L7.06 19.76 L4.24 16.94 L6.33 14.50 A6.2 6.2 0 0 1 6.22 14.25 L3.02 13.99 L3.02 10.01 L6.22 9.75 A6.2 6.2 0 0 1 6.33 9.50 L4.24 7.06 L7.06 4.24 L9.50 6.33 A6.2 6.2 0 0 1 9.75 6.22 L10.01 3.02 L13.99 3.02 L14.25 6.22 A6.2 6.2 0 0 1 14.50 6.33 L16.94 4.24 L19.76 7.06 L17.67 9.50 A6.2 6.2 0 0 1 17.78 9.75 Z" />
      {/* The hole — the other half of reading as a gear rather than a sun. */}
      <circle cx="12" cy="12" r="3.1" />
    </svg>
  );
}

/**
 * Three dots in a row, for "there is more behind here".
 *
 * ⚠️ **Filled circles, not an outline.** Every other icon in this file is stroked, and this
 * one is deliberately not: three small rings at 20 px read as a dotted line, where three
 * filled dots read as a menu — which is the convention on every platform the user has ever
 * held.
 *
 * Horizontal rather than vertical: a vertical ellipsis means the same thing, but on a phone
 * the horizontal one sits in a top-right corner without looking like a scrollbar.
 */
export function MoreIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <circle cx="5" cy="12" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="19" cy="12" r="1.9" />
    </svg>
  );
}
