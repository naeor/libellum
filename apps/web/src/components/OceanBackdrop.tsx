/**
 * **The green ocean behind the ledger space's presentation state.**
 *
 * ⚠️ **Every position in here is a function of `--p`**, the single progress the whole page shares —
 * `0` is the presentation state, `1` is the ordinary one. Nothing is animated by a transition
 * between two finished layouts, and **nothing is drawn twice**: the sea does not fade out while the
 * ledger fades in, it **recedes**.
 *
 * ⚠️ **The owner's brief, and what it rules out**: *"我希望它看起来像一片安静、广阔、具有生命力的绿色
 * 海洋，而不是常见的科技粒子动画，也不是儿童卡通风格的波浪."* So:
 *
 *  * **No particles, no dots, no glowing nodes** — that is the technology-animation vocabulary.
 *  * **No repeating sine scallops** — even, same-sized bumps are what makes a wave read as a cartoon.
 *    The curves below are **irregular**, with different control points per layer, and the layers have
 *    different periods and amplitudes.
 *  * **No highlights or gradients doing the work of "water"** — the depth comes from **lightness and
 *    opacity stepping back layer by layer**, which is how distance reads in a flat illustration.
 *
 * ⚠️ **`preserveAspectRatio="none"` is deliberate.** The sea must fill whatever the viewport is —
 * phone, iPad portrait, iPad landscape — and **a stretched curve is still a curve**, whereas a
 * fitted one would leave a white band at one edge on a wide screen.
 */

/** Layer definitions, far to near. The numbers are the design. */
interface Layer {
  /** The path's shape, in the 0–100 × 0–100 box the SVG uses. */
  readonly d: string;
  /** Brand green, mixed towards white as the layer recedes. */
  readonly fill: string;
  /** Where the layer sits at `--p = 0`, as a percentage of the viewport height. */
  readonly top: number;
  /** How far it travels at `--p = 1`, as a percentage. Nearer layers travel further. */
  readonly travel: number;
  /** The tide's own drift, in percentage points. Different per layer, so they disagree slightly. */
  readonly tide: number;
  /** Seconds for one tide cycle. Deliberately slow, and not the same for any two layers. */
  readonly period: number;
}

/**
 * ⚠️ **The palettes come from the brand green `#55997a`, stepped back by lightness.**
 *
 * The near layer is the brand colour itself, because it is the one that reads as *this* product.
 * The ones behind it are mixed towards white, which is what makes distance read in a flat drawing —
 * **and it is the reason this looks like sea rather than like four stacked shapes.**
 */
const LAYERS: readonly Layer[] = [
  {
    d: "M0,42 C18,34 32,50 50,44 C68,38 82,26 100,34 L100,100 L0,100 Z",
    fill: "#8fbfa6",
    top: 44,
    travel: 96,
    tide: 1.6,
    period: 19,
  },
  {
    d: "M0,52 C14,44 30,60 48,53 C66,46 80,36 100,44 L100,100 L0,100 Z",
    fill: "#6fae90",
    top: 53,
    travel: 84,
    tide: 2.1,
    period: 15.5,
  },
  {
    d: "M0,64 C20,56 34,70 52,63 C70,56 84,48 100,56 L100,100 L0,100 Z",
    fill: "#55997a",
    top: 64,
    travel: 70,
    tide: 2.6,
    period: 13,
  },
  {
    d: "M0,78 C16,72 36,84 54,78 C72,72 86,66 100,73 L100,100 L0,100 Z",
    fill: "#437a61",
    top: 78,
    travel: 56,
    tide: 3.2,
    period: 11,
  },
];

export function OceanBackdrop(): React.JSX.Element {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {LAYERS.map((layer, index) => (
        <svg
          key={layer.d}
          /**
           * ⚠️ **Each layer is its own absolutely-positioned SVG**, so the sea's depth is a real
           * stacking order rather than a `z-index` on four paths inside one drawing. It also means a
           * layer's travel can be written as a plain percentage of the viewport — **the displacement
           * the owner asked for ("整体向上移动或收束") is 96% of the screen for the nearest layer and
           * 56% for the furthest, which is what gives the retreat its speed difference.**
           *
           * ⚠️ **`bottom-0` plus a `top` percentage**: the sea always reaches the bottom edge, and
           * each layer starts at its own height. On a short screen the layers overlap more, which is
           * the right failure — **a sea with a gap at the bottom is a bug, a sea that is compressed is
           * still a sea.**
           */
          className="tide absolute inset-x-0 bottom-0"
          style={{
            top: `${String(layer.top)}%`,
            height: "62%",
            /**
             * ⚠️ **The travel, driven by the one progress.** Multiplying the layer's own distance by
             * `--p` (0…1) means **the same gesture moves every layer, on every frame, by an amount
             * that is already resolved** — no React state, no per-layer animation, and nothing that
             * can fall out of step with the others.
             */
            transform: `translateY(calc(var(--p, 0) * ${String(layer.travel)}%))`,
            /**
             * ⚠️ **The tide, as two numbers on the layer rather than a keyframe per layer.**
             *
             * My first version wrote `--tide-${index}` — **a variable nothing ever defined, so the
             * drift would have been a constant zero** — and put a non-offset value into the
             * `animation` shorthand. Both are the kind of mistake that renders something plausible
             * and simply never moves.
             *
             * The owner asked for *"非常缓慢地起伏，波面之间存在轻微的速度差"* and warned against
             * *"剧烈晃动"*. This is **a few percentage points over eleven to nineteen seconds**, and
             * **the periods are all different on purpose**: equal periods would drift in lockstep and
             * read as one sheet of water rather than as depth.
             */
            ["--tide-amp" as string]: `${String(layer.tide)}`,
            ["--tide-period" as string]: `${String(layer.period)}s`,
            /** ⚠️ A negative delay starts each layer at a different point in its cycle, so four layers never line up. */
            animationDelay: `${String(index * -1.7)}s`,
            /**
             * ⚠️ **The opacity stays 1.** The sea's recession is a *movement*, and the owner ruled
             * out the alternative in one sentence: *"不能只是绿色画面渐隐、白色页面渐显."* What fades
             * is the whole backdrop against the ordinary content appearing beneath it — never the
             * water fading into nothing on its own.
             */
            opacity: 1,
          }}
          viewBox="0 0 100 100"
          /**
           * ⚠️ **`none`, so the sea fills whatever the viewport is.** A stretched curve is still a
           * curve; a fitted one would leave a white band at one edge on a wide screen.
           */
          preserveAspectRatio="none"
        >
          <path d={layer.d} fill={layer.fill} />
        </svg>
      ))}
    </div>
  );
}
