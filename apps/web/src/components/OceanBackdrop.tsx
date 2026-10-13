/**
 * **The green sea, in both of its states.**
 *
 * ⚠️ **This file was rewritten after the owner rejected the first version**, and the rejection is
 * worth stating before the code: *"目前实现的主要问题是：展示态更像很多安卓手机的开屏页，它覆盖在真正的
 * 首页上方，用户上滑后，展示页逐渐变淡、消失，露出下面的正式页面。这不是我想要的效果。"*
 *
 * What was wrong, concretely:
 *
 *  1. **The sea sat at the bottom of the screen.** He asked for the opposite — *"最深色的绿色波面位于最
 *     上层，构成页面上方的主要视觉区域"*: dark at the top, lightening downward, into white.
 *  2. **It left the screen entirely.** `translateY(-100%)` meant the water *departed*, and that is
 *     exactly what made it read as a splash screen closing. He asked for it to **contract**:
 *     *"海浪不能完全消失……收束成常规态顶部的一小段波浪装饰."*
 *  3. **The brand text floated on the water** instead of being composed into it.
 *
 * ⚠️ **So the mechanism is now height, not travel.** Each band's `top` and `height` are `calc()`
 * interpolations on the one `--p` the page writes:
 *
 *  * `--p = 0` — the sea fills most of the screen, darkest at the top.
 *  * `--p = 1` — the sea is a shallow band at the very top: **the same curves, compressed.**
 *
 * ⚠️ **Nothing here is translated off-screen and there is no cross-fade.** The owner ruled the fade
 * out in one sentence: *"这段动画的核心是几何形态和布局的连续变化，而不是透明度变化。可以使用少量透明度辅助
 * 细节过渡，但不能让整体淡入淡出成为主要动画机制."*
 *
 * ⚠️ **The compression is what flattens the curves, and that is a property rather than a trick.**
 * `preserveAspectRatio="none"` means a band 24vh tall and the same band 3.4vh tall share one path —
 * **the wave flattens in proportion as it contracts**, which is precisely *"波面曲线可以随状态变化而
 * 自然变平缓."*
 */

/** The four bands, darkest first — the composition the owner described. */
interface Band {
  /** The curve, in a 0–100 × 100 box; the SVG is stretched to the band's box. */
  readonly d: string;
  readonly fill: string;
  /** Height at `--p = 0`, in vh. The deepest band is the largest: it is the subject. */
  readonly tall: number;
  /** Height at `--p = 1`, in vh — the tide-mark at the top of the ordinary state. */
  readonly short: number;
  /** The tide's own drift, in percentage points of the band's own height. */
  readonly tide: number;
  /** Seconds per tide cycle. Different for every band, or they drift in lockstep. */
  readonly period: number;
}

/**
 * ⚠️ **The palette steps from the brand green down to near-white, darkest on top.**
 *
 * The owner's direction: *"最深色的绿色波面位于最上层……越往下，绿色逐渐变浅，最终过渡到页面下方的白色或
 * 近白色内容区域."* The lightest band sits only a few percent away from the page, **so the sea does
 * not end in a line — it dissolves into the content area**, and the ledger card below reads as
 * belonging to the same page rather than to a different one.
 *
 * ⚠️ **The curves are irregular on purpose.** Even, equal bumps are what makes a wave look drawn by
 * a machine; the control points below differ per band, and *"避免机械重复的正弦波，也不要出现过于夸张的
 * 尖峰"* is why none of them swings more than about sixteen units in a hundred.
 */
const BANDS: readonly Band[] = [
  { d: "M0,10 C14,4 30,16 47,9 C64,2 82,13 100,6 L100,100 L0,100 Z", fill: "#3f7059", tall: 24, short: 3.4, tide: 1.1, period: 21 },
  { d: "M0,14 C18,7 34,20 52,12 C70,4 86,15 100,9 L100,100 L0,100 Z", fill: "#4f8a6d", tall: 20, short: 3, tide: 1.3, period: 17.5 },
  { d: "M0,18 C16,10 32,23 50,15 C68,7 84,18 100,12 L100,100 L0,100 Z", fill: "#6aa78a", tall: 18, short: 2.6, tide: 1.5, period: 14.5 },
  { d: "M0,22 C20,14 36,26 54,18 C72,10 88,20 100,15 L100,100 L0,100 Z", fill: "#96c4ac", tall: 16, short: 2.2, tide: 1.7, period: 12 },
];

/**
 * Where each band's top edge sits, as a share of the sea's current height.
 *
 * ⚠️ **The bands overlap on purpose.** Butt-jointing them would put a hard horizontal seam between
 * two greens — **four stripes instead of one sea.** Overlapping means what shows is each band's
 * *curve*, with the one behind it continuing underneath.
 */
const TOPS = [0, 20, 38, 54];

/**
 * How tall the whole sea is at each end, in vh.
 *
 * ⚠️ **`72` is chosen so the ordinary state is visible while the presentation state shows.** The
 * owner: *"展示态不应该完全遮挡常规态的内容……应当保留一部分白色或近白色区域，并让用户能够提前看到一些
 * 属于账本空间的实际内容."* What is left below is the top of the first **real** ledger card — not a
 * decorative stand-in, which is a distinction he made twice.
 *
 * ⚠️ **`13` at the other end is a judgement about usefulness rather than beauty.** He asked for
 * *"一道小小的绿色潮痕"* and warned: *"不要让它占据过大的垂直空间，影响用户快速选择账本."* Thirteen
 * percent is about a status bar plus a comfortable margin — **present as brand, never in the way.**
 */
const SEA_TALL = 72;
const SEA_SHORT = 13;

export function OceanBackdrop(): React.JSX.Element {
  return (
    /**
     * ⚠️ **The container writes the sea's height, and every band reads it.**
     *
     * One declaration, four consumers: **the bands cannot disagree about how tall the sea is**, which
     * is what keeps them reading as one body of water rather than four shapes that happen to move.
     */
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0"
      style={{
        /**
         * ⚠️ **Written twice on purpose: once as the height, once as a variable.**
         *
         * The height is what the bands live inside; `--sea-h` is what the text layer reads to know
         * where the sea's middle is. **Without the variable the text layer silently kept the 72vh
         * fallback**, so at the ordinary state the name would have sat at the middle of a sea that is
         * no longer there — **the kind of bug that looks like a stray label rather than a mistake.**
         */
        ["--sea-h" as string]: "calc(" + SEA_TALL + "vh + (var(--p, 0) * (" + SEA_SHORT + "vh - " + SEA_TALL + "vh)))",
        height: "var(--sea-h)",
      }}
    >
      {BANDS.map((band, index) => (
        <svg
          key={band.d}
          /**
           * ⚠️ **`top` is a share of the *current* height, not a fixed `vh`.** A fixed top would leave
           * the second band at 20vh while the sea shrank to 13vh — **it would fall out of the bottom
           * of the composition rather than following the first band up.**
           */
          className="tide absolute inset-x-0"
          style={{
            top: "calc(" + (TOPS[index] ?? 0) + "% )",
            height: "calc(" + (100 - (TOPS[index] ?? 0)) + "% )",
            ["--tide-amp" as string]: String(band.tide),
            ["--tide-period" as string]: band.period + "s",
            /** ⚠️ A negative delay starts each band at a different point, so four never line up. */
            animationDelay: index * -2.3 + "s",
            /** ⚠️ Later bands sit behind earlier ones, so their curves stack rather than hide. */
            zIndex: BANDS.length - index,
          }}
          viewBox="0 0 100 100"
          /**
           * ⚠️ **`none`, and it is doing real work now**: the band's box gets shorter as the sea
           * contracts, so **the curve flattens in proportion** — the owner's *"波面曲线可以随状态变化而
           * 自然变平缓"*, without a second path or an animation.
           */
          preserveAspectRatio="none"
        >
          <path d={band.d} fill={band.fill} />
        </svg>
      ))}

      {/**
        * ⚠️ **The brand text lives inside the sea, in its darkest part.**
        *
        * The owner: *"品牌文字应该成为海浪构图的一部分，而不是漂浮在独立白色卡片上"*, and he asked the
        * dark area to give it *"足够的文字对比度和视觉空间"*. So it is anchored to the top half of the
        * sea, where the two darkest bands are — **white on `#3f7059` is comfortable for large text.**
        *
        * ⚠️ **It contracts instead of cross-fading.** At `--p = 1` the name is smaller and sits in the
        * tide-mark; **it is the same element in the same place at a different size**, which is what
        * *"不要毫无联系地消失，再在另一个位置重新出现"* asks for. Only the tagline fades, and it is
        * the part that has nowhere to go at 13vh.
        */}
      <div
        className="absolute inset-x-0 top-0 flex flex-col items-center justify-center overflow-hidden px-8 text-center"
        style={{ height: "calc(var(--sea-h) * 0.56)" }}
      >
        <p
          className="font-semibold tracking-[0.16em] text-white"
          style={{ fontSize: "calc(2.1rem - var(--p, 0) * 0.85rem)" }}
        >
          Libellum
        </p>
        <p
          className="mt-2 text-sm leading-relaxed text-white/80"
          /** ⚠️ Opacity as a detail only — the tagline has nowhere to sit at 13vh. */
          style={{ opacity: "calc(1 - var(--p, 0) * 0.95)" }}
        >
          记一本账，安静而长久。
        </p>
      </div>
    </div>
  );
}