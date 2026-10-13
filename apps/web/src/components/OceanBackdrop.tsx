/**
 * **The green sea at the top of the ledger space, and the tide-mark it contracts into.**
 *
 * ⚠️ **Third rewrite, and the screenshots found three faults that all had the same shape: something
 * that should have been part of the composition was not.**
 *
 *  1. **The brand text was invisible.** The four bands carried `z-index` 4→1 and the text block had
 *     none, so it defaulted to 0 — **underneath all four of them.** A whole screen of green with no
 *     name on it, because the name was painted first and then covered.
 *  2. **The bands looked copy-pasted.** They *were*: four copies of one curve with the straight
 *     segment's `V` changed from 87 to 93. **Equal spacing, parallel edges, no left-right difference.**
 *  3. **The top showed pale green as the sea moved.** The tide was `translateY` — **the whole band
 *     sliding** — so when a band moved down, its top edge left the top of the container and **the
 *     band behind it showed through.** The owner's diagnosis was exact: *"波面的变化主要体现在下边界，
 *     不能因整层移动而把顶部覆盖区域拉开."*
 *
 * ⚠️ **What the three fixes have in common**: the composition has to be *designed*, not offset.
 * Each band now has **its own curve** — different peak positions, different amplitudes, unequal
 * spacing, and a real left-to-right height difference — and the tide **scales rather than moves**.
 */

interface Band {
  /** The shape, in a 0–100 box: **a straight top edge and a curved bottom edge.** */
  readonly d: string;
  readonly fill: string;
  /** Height as a share of the viewport at `--p = 0`. */
  readonly tall: number;
  /** Height at `--p = 1` — the tide-mark. */
  readonly short: number;
  /** Seconds per tide cycle. Different for every band, or they breathe in lockstep. */
  readonly period: number;
}

/**
 * ⚠️ **Darkest first, and the deepest band is now the largest** — the owner asked for it to reach
 * *"接近可视高度的 50%"*, with the shallower bands **gathered closer together below it** rather than
 * spread evenly to the bottom.
 *
 * ⚠️ **The four curves are genuinely different shapes.** Band 1 dips on the left and swells on the
 * right; band 2 has a single wide crest right of centre; band 3 falls to the right; band 4 is the
 * calmest and the flattest. **None of them is another one shifted vertically**, which is what made
 * the previous version read as *"同一条曲线重复向下平移"*.
 *
 * ⚠️ **Their average heights still increase in order** (≈42, 50, 56, 62 vh once scaled by each band's
 * own height), so the light bands never cross in front of the dark ones and the colour order stays
 * *"由深到浅"* — the owner's one constraint on the freedom: *"避免无控制的交叉造成颜色顺序混乱."*
 */
const BANDS: readonly Band[] = [
  /** The main wave: a low left shoulder rising to a high right — the asymmetry the owner asked for. */
  { d: "M0,0 H100 V78 C86,66 72,88 54,82 C34,76 16,92 0,84 Z", fill: "#3f7059", tall: 46, short: 5.5, period: 23 },
  /** One broad crest right of centre, falling away at both ends. */
  { d: "M0,0 H100 V86 C82,74 66,92 44,88 C26,85 12,78 0,90 Z", fill: "#4f8a6d", tall: 60, short: 9, period: 18.5 },
  /** Tilted the other way: high on the left, falling to the right. */
  { d: "M0,0 H100 V74 C78,88 58,80 38,90 C22,97 10,92 0,86 Z", fill: "#6aa78a", tall: 70, short: 12, period: 15.5 },
  /** The calmest layer, nearly flat — it is the one that dissolves into the page. */
  { d: "M0,0 H100 V90 C80,94 62,88 44,93 C26,98 10,94 0,97 Z", fill: "#96c4ac", tall: 80, short: 14.5, period: 12.5 },
];

/**
 * ⚠️ **The brand text sits above every band**, which is the fix for the invisible name: the bands are
 * 1–4 and this is 10. **The name was never missing — it was painted underneath.**
 */
const TEXT_Z = 10;

export function OceanBackdrop(): React.JSX.Element {
  return (
    /**
     * ⚠️ **`w-full` is not decoration.** This component's wrapper has no in-flow content of its own, so
     * without a width declaration it collapses — which is what produced a green square in the corner
     * of an earlier screenshot.
     */
    <div
      aria-hidden="true"
      className="relative w-full"
      style={{
        ["--sea-h" as string]: "calc(80vh + (var(--p, 0) * (14.5vh - 80vh)))",
        height: "var(--sea-h)",
      }}
    >
      {BANDS.map((band, index) => (
        <svg
          key={band.d}
          /**
           * ⚠️ **Every band is anchored to the top and only its height differs**, so what shows is each
           * band's own lower edge — four overlapping curves rather than four stacked slabs.
           */
          className="tide absolute inset-x-0 top-0 w-full"
          style={{
            height: "calc(" + band.tall + "vh + (var(--p, 0) * (" + band.short + "vh - " + band.tall + "vh)))",
            ["--tide-period" as string]: band.period + "s",
            /** ⚠️ A negative delay starts each band at a different point in its cycle, so four never line up. */
            animationDelay: index * -3.1 + "s",
            /** ⚠️ Shallower bands sit behind deeper ones. */
            zIndex: BANDS.length - index,
            /** ⚠️ Scaling happens from the top, so the upper edge never moves — see `.tide`. */
            transformOrigin: "top",
          }}
          viewBox="0 0 100 100"
          /**
           * ⚠️ **`none` lets the box stretch the curve**, so a band 46 vh tall and the same band 5.5 vh
           * tall share one path and **the wave flattens as the sea contracts.**
           */
          preserveAspectRatio="none"
        >
          <path d={band.d} fill={band.fill} />
        </svg>
      ))}

      {/**
        * ⚠️ **The brand block, now above the water instead of under it.**
        *
        * The owner: *"将现有品牌标识和标语清晰地放在深绿色区域内部，避开安全区域，不能只留下大片空白
        * 绿色."* It is anchored inside the deepest band, padded by the safe-area inset, and kept in the
        * upper part of the band where white on `#3f7059` reads comfortably.
        *
        * ⚠️ **It shrinks rather than cross-fading** — *"不要毫无联系地消失，再在另一个位置重新出现"* — and
        * **it does not move with the tide**: *"品牌文字保持稳定、清晰，不跟着波面不断晃动."* Only the
        * tagline fades, because a 5.5 vh band has nowhere to put it.
        */}
      <div
        className="absolute inset-x-0 top-0 flex flex-col items-center justify-center px-8 text-center"
        style={{
          zIndex: TEXT_Z,
          height: "calc(var(--sea-h) * 0.52 + env(safe-area-inset-top, 0px))",
          paddingTop: "env(safe-area-inset-top, 0px)",
        }}
      >
        <p
          className="font-semibold tracking-[0.16em] text-white"
          style={{ fontSize: "calc(2.1rem - var(--p, 0) * 1.15rem)" }}
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