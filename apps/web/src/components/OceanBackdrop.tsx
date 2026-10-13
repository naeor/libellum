/**
 * **The green sea at the top of the ledger space, and the tide-mark it contracts into.**
 *
 * ⚠️ **Each band now carries TWO curves, and that is a geometry fix rather than a flourish.**
 *
 * The owner reported that the contracted sea *"感觉是平的"* while the open one *"感觉很斜"*.
 * The cause is arithmetic: a band's left-right drop is `height × (1 − ratio)`, and contracting takes
 * its height from 83vh to 23vh — **so the same ratio gives a seventh of the slope.** One path cannot
 * have two ratios, so **the two states are two curves**, cross-faded inside the same band. Because
 * both share the band's fill and only its lower edge moves, the swap reads as the curve changing
 * shape — **not as two pictures changing place.**
 *
 * ⚠️ **The contracted curves are much steeper on purpose** (ratio ≈ 0.70 against ≈ 0.93) so the
 * *apparent* tilt stays comparable once the band is short. **Matching the ratio would have kept the
 * contracted sea flat forever**, because it is the drop-to-width angle a person reads, not the ratio.
 */

interface Band {
  /** The curve while the sea is open. Ratio ≈ 0.93 — a gentle tilt. */
  readonly dTall: string;
  /** The curve once contracted. Ratio ≈ 0.70 — steeper, so the tilt still reads at 8–23vh. */
  readonly dShort: string;
  readonly fill: string;
  /** Height as a share of the viewport at `--p = 0`. */
  readonly tall: number;
  /** Height at `--p = 1`. */
  readonly short: number;
  readonly period: number;
}

/**
 * ⚠️ **The spacing is the owner's second request**: *"中间的三个过渡海浪，每个都占屏幕的3%-8%左右,
 * 不会被挤得太窄或者过宽."*
 *
 * The four heights differ by **6 / 7 / 7 vh** when open and **5 / 5 / 5 vh** when contracted — so the
 * three visible strips between the bands are **the same width at both ends**, and neither state
 * squeezes one of them to a sliver or blows one out.
 *
 * ⚠️ Contracted heights are 8 / 13 / 18 / 23 rather than 8 / 9.3 / 10.7 / 12: at the old spacing the
 * strips were **1.3vh** — a hard line rather than layers.
 */
const BANDS: readonly Band[] = [
  { dTall: "M0,0 H100 V93 C84,96 68,91 50,94 C32,97 16,95 0,100 Z", dShort: "M0,0 H100 V70 C84,80 68,64 50,76 C32,88 16,78 0,100 Z", fill: "#3f7059", tall: 63, short: 8, period: 23 },
  { dTall: "M0,0 H100 V93 C82,96 66,91 48,94 C30,97 15,95 0,100 Z", dShort: "M0,0 H100 V72 C82,81 66,66 48,77 C30,88 15,79 0,100 Z", fill: "#4f8a6d", tall: 69, short: 13, period: 18.5 },
  { dTall: "M0,0 H100 V93 C80,96 64,91 46,94 C28,97 14,95 0,100 Z", dShort: "M0,0 H100 V73 C80,82 64,67 46,78 C28,89 14,80 0,100 Z", fill: "#6aa78a", tall: 76, short: 18, period: 15.5 },
  { dTall: "M0,0 H100 V93 C78,96 62,91 44,94 C26,97 12,95 0,100 Z", dShort: "M0,0 H100 V72 C78,81 62,67 44,77 C26,88 12,79 0,100 Z", fill: "#96c4ac", tall: 83, short: 23, period: 12.5 },
];

const TEXT_Z = 10;

export function OceanBackdrop(): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="relative w-full"
      style={{ height: "var(--sea-h)" }}
    >
      {BANDS.map((band, index) => (
        <svg
          key={band.fill}
          className="tide absolute inset-x-0 top-0 w-full"
          style={{
            height: "calc(" + band.tall + "vh + (var(--p, 0) * (" + band.short + "vh - " + band.tall + "vh)))",
            ["--tide-period" as string]: band.period + "s",
            animationDelay: index * -3.1 + "s",
            zIndex: BANDS.length - index,
            transformOrigin: "top",
          }}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {/**
            * ⚠️ **Two paths, cross-faded, same fill.** The lower edge is what a reader sees, so the
            * swap reads as the water flattening or steepening — **and because both paths are inside one
            * band, there is no moment where two seas are visible at once.**
            */}
          <path d={band.dTall} fill={band.fill} style={{ opacity: "calc(1 - var(--p, 0))" }} />
          <path d={band.dShort} fill={band.fill} style={{ opacity: "var(--p, 0)" }} />
        </svg>
      ))}

      {/**
        * ⚠️ **The brand block: centred while open, top-left once contracted, and now further down.**
        *
        * The owner's last note — *"把收缩状态下的logo往下再挪一挪，它现在离上面太近了"* — is why the
        * vertical interpolation ends at **14px rather than 5px**.
        */}
      <div
        className="absolute top-0 flex flex-col"
        style={{
          zIndex: TEXT_Z,
          left: "calc(50% * (1 - var(--p, 0)) + 9px * var(--p, 0))",
          transform: "translateX(calc(-50% * (1 - var(--p, 0))))",
          top: "calc(14px * var(--p, 0))",
          alignItems: "center",
          textAlign: "center",
          height: "calc(var(--sea-h) * 0.52 + env(safe-area-inset-top, 0px))",
          paddingTop: "env(safe-area-inset-top, 0px)",
          justifyContent: "center",
        }}
      >
        <p
          className="font-semibold tracking-[0.16em] text-white"
          style={{ fontSize: "calc(2.1rem - var(--p, 0) * 0.7rem)" }}
        >
          Libellum
        </p>
        <p
          className="mt-2 text-sm leading-relaxed text-white/80"
          style={{ opacity: "calc(1 - var(--p, 0) * 0.95)" }}
        >
          记一本账，安静而长久。
        </p>
      </div>
    </div>
  );
}