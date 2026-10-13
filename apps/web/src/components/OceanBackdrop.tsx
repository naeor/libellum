/**
 * **The green sea at the top of the ledger space — and the tide-mark it contracts into.**
 *
 * ⚠️ **Rewritten twice, and the second rewrite came from screenshots.** The owner sent two: one where
 * the sea was a vast green block covering the title, another where it had shrunk to a small square in
 * the **top-left corner**. Both had the same root cause, and it was not colour or opacity:
 *
 * > **The sea's wrapper was a flex child whose only content was `absolute` — so it had no width.**
 *
 * The height was `vh`, which does not depend on width, so **the box stayed tall while its width
 * collapsed** — a narrow green column in one state and a wide one in another. Every visual parameter
 * was being tuned on top of a broken box.
 *
 * ⚠️ **The composition is now the owner's own numbers**, from the screenshot feedback:
 *
 * > *"最深色波面占页面可视高度约 40%–45%，接近半屏；下方各层继续延伸，最浅一层的下边界到达页面高度约 80%."*
 *
 * So the four bands are **42 / 55 / 68 / 80 vh** at the presentation state, all anchored to the top,
 * and **14 vh** together at the information state.
 *
 * ⚠️ **Each band's *lower* edge is the curve — the upper edge is the top of the page.**
 * The previous version had it the other way round (a curve at the top, filled downward) and gave each
 * band its own `top`, which produced **a flat slab with one wavy edge** rather than layers. The owner
 * named that fault exactly: *"不能用一个大绿色矩形加一条曲线代替整个构图."*
 */

interface Band {
  /** The shape, in a 0–100 box. **A straight top edge and a curved bottom edge.** */
  readonly d: string;
  readonly fill: string;
  /** Height as a share of the viewport, at `--p = 0`. */
  readonly tall: number;
  /** Height at `--p = 1` — the tide-mark. */
  readonly short: number;
  /** The tide's own drift, in percentage points of the band's own height. */
  readonly tide: number;
  /** Seconds per tide cycle. Different for every band, or they drift in lockstep. */
  readonly period: number;
}

/**
 * ⚠️ **Darkest on top, four steps down to near-white, and the lightest stops only a few percent away
 * from the page.** The owner: *"最上方是最深的绿色波面，向下依次出现较浅绿色、浅绿色、极浅绿色，最后过渡到
 * 白色内容区."* Because the last band is nearly the page colour, **the sea does not end in a line —
 * it dissolves into the content below it.**
 *
 * ⚠️ **The lower edges are irregular on purpose.** Even, equal scallops are what makes a wave look
 * machine-drawn; the four control-point sets differ, and none swings more than about ten units,
 * because the owner asked for *"自然、不完全规则"* without *"过于夸张的尖峰"*.
 */
const BANDS: readonly Band[] = [
  { d: "M0,0 H100 V87 C78,93 60,85 42,89 C24,93 10,87 0,91 Z", fill: "#3f7059", tall: 42, short: 5, tide: 1.1, period: 21 },
  { d: "M0,0 H100 V89 C76,95 58,87 40,91 C22,95 8,89 0,93 Z", fill: "#4f8a6d", tall: 55, short: 8, tide: 1.3, period: 17.5 },
  { d: "M0,0 H100 V91 C80,96 62,89 44,93 C26,97 10,91 0,94 Z", fill: "#6aa78a", tall: 68, short: 11, tide: 1.5, period: 14.5 },
  { d: "M0,0 H100 V93 C74,98 56,91 38,95 C20,99 8,93 0,96 Z", fill: "#96c4ac", tall: 80, short: 14, tide: 1.7, period: 12 },
];

/**
 * ⚠️ **The tallest band is the lightest one, and that is the composition rather than a mistake.**
 * The deep band stops at 42 vh; **everything below it belongs to the shallower bands**, which is what
 * turns four rectangles into a sea with depth. Painting them the other way round is what produced
 * *"一个巨大的绿色色块"*.
 */
const SEA_TALL = 80;
const SEA_SHORT = 14;

export function OceanBackdrop(): React.JSX.Element {
  return (
    /**
     * ⚠️ **`w-full` is not decoration — it is the fix.** This element is a block inside a wrapper that
     * has no other content, so **without a width declaration it collapses**, and a collapsed box is
     * what the screenshots showed: a green square in the corner.
     *
     * ⚠️ **The height is written once here and read by the bands**, so they cannot disagree about how
     * tall the sea is — which is what keeps four bands reading as one body of water.
     */
    <div
      aria-hidden="true"
      className="relative w-full"
      style={{
        ["--sea-h" as string]: "calc(" + SEA_TALL + "vh + (var(--p, 0) * (" + SEA_SHORT + "vh - " + SEA_TALL + "vh)))",
        height: "var(--sea-h)",
      }}
    >
      {BANDS.map((band, index) => (
        <svg
          key={band.d}
          /**
           * ⚠️ **Every band starts at the top of the page.** Only its height differs, and because the
           * deepest band is drawn last-but-on-top, what shows is **each band's own lower edge** —
           * four overlapping curves rather than four stacked blocks.
           */
          className="tide absolute inset-x-0 top-0 w-full"
          style={{
            height: "calc(" + band.tall + "vh + (var(--p, 0) * (" + band.short + "vh - " + band.tall + "vh)))",
            ["--tide-amp" as string]: String(band.tide),
            ["--tide-period" as string]: band.period + "s",
            /** ⚠️ A negative delay starts each band at a different point, so four never line up. */
            animationDelay: index * -2.3 + "s",
            /** ⚠️ Shallower bands sit behind deeper ones. */
            zIndex: BANDS.length - index,
          }}
          viewBox="0 0 100 100"
          /**
           * ⚠️ **`none` lets the box's aspect ratio stretch the curve**, so a band 42 vh tall and the
           * same band 5 vh tall share one path and **the wave flattens in proportion as the sea
           * contracts** — the owner's *"波面曲线可以随状态变化而自然变平缓"*, for free.
           */
          preserveAspectRatio="none"
        >
          <path d={band.d} fill={band.fill} />
        </svg>
      ))}

      {/**
        * ⚠️ **The brand text sits inside the deepest band and clears the notch.**
        *
        * The owner: *"Libellum 品牌名称和现有标语位于最上方深色波面内部，清晰可读，避开设备安全区域."*
        * So the block is anchored to the top of the sea, **padded by the safe-area inset**, and kept
        * within the upper part of the deepest band where white-on-`#3f7059` is comfortable.
        *
        * ⚠️ **It shrinks rather than cross-fading**, because *"不要毫无联系地消失，再在另一个位置重新出现"*
        * — the same element stays in the same place at a smaller size. Only the tagline fades: at a
        * 5 vh deep band there is genuinely nowhere for it to sit.
        */}
      <div
        className="absolute inset-x-0 top-0 flex flex-col items-center justify-center px-8 text-center"
        style={{
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