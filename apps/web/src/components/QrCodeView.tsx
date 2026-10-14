import { useMemo } from "react";

import { encodeQr } from "../lib/qr.js";

/**
 * **A share link, as something a phone can point at.**
 *
 * ⚠️ **The owner asked for this in his own words**: *"将分享链接显示为二维码，方便当面扫码加入."*
 * The use case is two people in the same room — **the link is already copyable, and copying a link to
 * somebody standing next to you is the slow way.**
 *
 * ⚠️ **SVG rather than a canvas or an image.** It scales to whatever the layout gives it, prints
 * without blurring, costs no request, and **carries no data URL that a screenshot of the page could
 * leak** — the symbol is drawn from the same string the code block below it shows.
 *
 * ⚠️ **A white plate behind the modules, always.** A QR code on a coloured background is a code a
 * camera has to guess at, and **the app's green is exactly the kind of background that fails.**
 */
export function QrCodeView({
  text,
  size = 176,
  label,
}: {
  readonly text: string;
  readonly size?: number;
  readonly label: string;
}): React.JSX.Element {
  /**
   * ⚠️ **Failure is shown, not swallowed.** `encodeQr` throws when the text does not fit, and the
   * honest answer is to say so — **a QR area that renders nothing looks like a bug, and a symbol
   * that carries half a URL looks like success.**
   */
  const code = useMemo(() => {
    try {
      return { ok: true as const, value: encodeQr(text) };
    } catch (caught: unknown) {
      return { ok: false as const, message: caught instanceof Error ? caught.message : "无法生成二维码。" };
    }
  }, [text]);

  if (!code.ok) {
    return <p className="rounded-field bg-danger-soft px-4 py-3 text-body text-danger">{code.message}</p>;
  }

  const { size: modules, modules: grid } = code.value;
  /** Four modules of quiet zone on every side, which the standard requires for reliable reading. */
  const quiet = 4;
  const extent = modules + quiet * 2;

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(extent)} ${String(extent)}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="rounded-field bg-white"
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path
        fill="#000000"
        d={grid
          .flatMap((row, y) =>
            row.map((dark, x) => (dark ? `M${String(x + quiet)} ${String(y + quiet)}h1v1h-1z` : "")),
          )
          .join("")}
      />
    </svg>
  );
}
