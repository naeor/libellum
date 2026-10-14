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

/** Small outlined gear, with explicit dimensions independent of SVG defaults. */
export function GearIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="m9 3-.6 2.1-1.7 1L4.6 6l-2 3.5 1.5 1.6v1.8l-1.5 1.6 2 3.5 2.1-.1 1.7 1L9 21h4l.6-2.1 1.7-1 2.1.1 2-3.5-1.5-1.6v-1.8l1.5-1.6-2-3.5-2.1.1-1.7-1L13 3Z" transform="translate(1)" />
    <circle cx="12" cy="12" r="3" />
  </svg>;
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

/**
 * A plus, for "make another one".
 *
 * ⚠️ **This is the second `PlusIcon` in the project and they are different drawings.**
 * `BottomNav` has one at 24 px with `strokeWidth` heavy enough for the raised centre button —
 * it is part of that button's look, not a general icon. **Moving it here would have been the
 * wrong repair**: the recording button needs its own weight, and changing it to share with a
 * text-sized plus would have altered the bar to serve a list.
 *
 * ⚠️ **So the duplication is deliberate, and the comment at the top of this file is what
 * covers it** — *"The project's older icons live beside the component that first needed them
 * …… That was fine while each had one home."* The start page's 新建账本 is the second home,
 * which is the condition that file names for moving in here.
 *
 * Sized to sit beside `text-sm` text without changing the line height.
 */
export function PlusIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
      className="size-4"
      {...props}
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/**
 * **The account avatar: a portrait silhouette, which is the convention everybody already knows.**
 *
 * ⚠️ **The owner asked for exactly this** (2026-10-13): *"图标是那种一个灰色的默认头像半身像那样的样子.
 * 你可以上网搜一下."* A search confirms it is the standard placeholder — a bust in a circle, drawn flat —
 * as used by essentially every account system
 * ([example](https://clipart-library.com/clipart/avatar-cliparts-17.htm)).
 *
 * ⚠️ **⚠️ This replaces `DefaultAvatar` *in this position*, and it is not a redrawing of it.** That
 * component is a **six-petal flower** — the project's own mark, and a deliberate placeholder for a
 * user-chosen picture. **The owner is not asking for the flower to change**; he is asking for the green
 * band's corner control to read as *an account*, which a flower does not. **Both now exist, each with
 * one home**: the flower where somebody's own avatar would go, this where the app must say "this is you".
 *
 * ⚠️ **Grey by construction, not by a literal.** The silhouette is `currentColor`, so it takes the
 * colour of whatever holds it, and the corner button sets that to the muted token. **`colors.test.ts`
 * forbids hex literals outside the token files**, and this is the better shape anyway: a grey written
 * down once is a grey that cannot follow the theme.
 *
 * ⚠️ **The disc is tinted from the same colour rather than white.** The button sits on the green band,
 * where a white disc would be a bright dot competing with the wordmark — the opposite of the
 * "柔和、安静" this screen is meant to have.
 */
export function AvatarIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      {/* The disc the portrait sits in. */}
      <circle cx="12" cy="12" r="12" fill="currentColor" opacity={0.16} />
      {/*
        ⚠️ **Head and shoulders, filled as one silhouette, and they overlap on purpose.** Drawing them
        as two outlines leaves a gap at the neck, and at 22 px the whole point of the convention is that
        the shape is recognised instantly rather than studied.
      */}
      <g fill="currentColor">
        <circle cx="12" cy="9.7" r="4" />
        <path d="M12 15.2c-4.1 0-7.1 2.5-7.8 6A12 12 0 0 0 12 24a12 12 0 0 0 7.8-2.8c-.7-3.5-3.7-6-7.8-6Z" />
      </g>
    </svg>
  );
}
