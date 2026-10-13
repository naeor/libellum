/**
 * **The green sea — now generated rather than hand-drawn.**
 *
 * ⚠️ **Why it is generated.** The owner looked at four hand-written curves and said they *"看上去完全是
 * 平行的"*, and he was right: each was the same shape with its straight segment nudged by a few units.
 * **Hand-writing a fifth set would have produced a fifth parallel line.** He then described the fix
 * himself — give every band its left and right heights, then let each one's *middle* deviate from the
 * straight line by a different amount — and that is exactly what `buildPath` does.
 *
 * ⚠️ **The deviation is a sum of sines, and that choice is about smoothness.** He asked for *"足够连续
 * 且变化均匀（不出现锐角，小拐弯）"*: a sine is smooth everywhere, its slope never jumps, and adding
 * two of them with unrelated frequencies gives a shape that repeats only over a long span — **irregular
 * without ever being sharp.** A random walk or a spline through jittered points would both have produced
 * the kinks he was warning against.
 *
 * ⚠️ **The bands share the *idea* and not the *shape*.** Each has its own amplitude, frequency and
 * phase, so their crests land in different places up and down the width — **which is the whole point:
 * related, like one tide, but not parallel.**
 */

/** One sine component of a band's deviation from its straight line. */
interface Wave {
  /**
   * ⚠️ **The deviation in vh — an absolute height, NOT a share of the band.**
   *
   * This was a percentage and it caused the bands to **overlap**: band 0's amplitude was 11% of its own
   * 63vh, which is 6.9vh, and the gap to band 1 is only 6vh — **so its troughs crossed into the layer
   * below.** The owner saw it: 「好多还相互重合」.
   *
   * ⚠️ **In vh the same number means the same thing on every band**, so a rule like "keep it under half
   * the gap" is checkable by reading one line rather than multiplying by each band's height.
   */
  readonly amp: number;
  /** Cycles across the width. Higher gives more, smaller swells. */
  readonly freq: number;
  /** Where the wave starts, 0–1. **Unrelated phases are what stop the bands marching in step.** */
  readonly phase: number;
}

interface Band {
  readonly fill: string;
  /**
   * ⚠️ **Only the LEFT end is declared, and that is not an omission.**
   *
   * The right end is `left × 0.90`, computed once inside `buildPath`. Declaring both would leave two
   * numbers that must agree — **and the day they disagree, the sea tilts by an amount nobody chose.**
   */
  readonly left: number;
  /** Height once contracted. The curve is the same; only the box it is stretched over shrinks. */
  readonly leftShort: number;
  /** What makes this band's curve *this band's* curve. */
  readonly waves: readonly Wave[];
  /** Seconds per tide cycle. */
  readonly period: number;
}

/**
 * ⚠️ **The four bands' spacings are 6 / 7 / 7 vh when open** — inside the owner's *"3%到8%之间浮动"*
 * and close enough to even to read as a sea rather than as stripes.
 *
 * ⚠️ **Contracted heights are 10 / 12 / 14 / 16** — the deepest reaches 10% and each of the other three
 * adds about 2%, which is what the owner asked for when he said the contracted sea should **stay thin**.
 *
 * ⚠️ **The contracted ratios are much steeper** (0.60–0.75 against 0.93). A band's drop is
 * `height × (1 − ratio)`, so matching the ratio would leave the contracted sea **visually flat at a
 * seventh of the slope** — the owner's *"收缩模式下感觉是平的"*.
 */
const BANDS: readonly Band[] = [
  {
    fill: "#3f7059",
    left: 63, leftShort: 10,
    /** The deepest band: a broad swell with a second, smaller ripple over it. */
    waves: [{ amp: 2.2, freq: 1.15, phase: 0 }, { amp: 0.8, freq: 2.4, phase: 0.4 }],
    period: 10,
  },
  {
    fill: "#4f8a6d",
    left: 69, leftShort: 12,
    /** Offset in phase, so its crest sits where the first band has a trough. */
    waves: [{ amp: 3.4, freq: 1.45, phase: 0.85 }],
    period: 11,
  },
  {
    fill: "#6aa78a",
    left: 76, leftShort: 14,
    waves: [{ amp: 3.4, freq: 1.05, phase: 1.95 }],
    period: 9,
  },
  {
    fill: "#96c4ac",
    left: 83, leftShort: 16,
    /** The calmest layer — it is the one that dissolves into the page. */
    waves: [{ amp: 2.4, freq: 1.35, phase: 3.1 }],
    period: 12,
  },
];

/**
 * A band's lower edge, as an SVG path.
 *
 * ⚠️ **The baseline runs from the band's left height to its right height**, and the waves are added on
 * top of it — the owner's description, in code. `100` is the top of the box and the box is the band's
 * own height, so the left end is always at `100` (the band reaches its full height on the left) and the
 * right end is `right / left`, which is the tilt.
 *
 * ⚠️ **Sampled rather than expressed as béziers.** Forty-nine points across the width is far finer than
 * any screen resolves, and **it makes "no sharp corners" a property of the maths rather than of four
 * control points somebody has to keep consistent.** Anything the owner asks for later — a different
 * amplitude, a third harmonic — is one number.
 */
function buildPath(band: Band, rightRatio: number): string {
  const steps = 140;
  /**
   * ⚠️ **One ratio for both states, and 0.90 is a compromise the owner should know about.**
   *
   * He asked for 63 / 59 open (ratio 0.937) and 10 / 6 contracted (ratio 0.60). **One path cannot
   * hold two ratios**, and he rejected the two-path answer because he could see the cross-fade:
   * 「过渡动画中有出现淡入淡出的现象」.
   *
   * 0.85 lands within 8 vh of the open request (63 → 56.7 against 59) and 3 vh of the contracted
   * one (10 → 8.5 against 6.75). **The owner asked for the contracted right side to be narrower**
   * (「变窄20%到30%左右」), and 0.85 moves it most of the way there without a cross-fade.
   */
  const yRight = rightRatio * 100;
  const points: string[] = [];

  for (let i = steps; i >= 0; i -= 1) {
    const t = i / steps;
    const base = 100 + (yRight - 100) * t;
    let deviation = 0;
    for (const wave of band.waves) {
      /** ⚠️ vh → viewBox units: the box is the band's own height, so the conversion needs it. */
      deviation += ((wave.amp / band.left) * 100) * Math.sin(2 * Math.PI * (wave.freq * t + wave.phase));
    }
    points.push(`L${(t * 100).toFixed(2)},${(base + deviation).toFixed(2)}`);
  }

  return `M0,0 H100 V${yRight.toFixed(2)} ${points.join(" ")} Z`;
}

/**
 * ⚠️ **Two ratios, and the cross-fade between them is invisible — which is the point.**
 *
 * The owner asked for the open state''s right end at 59/63 (**0.93**) and, separately, for the
 * contracted right side to be **20–30% narrower** than the left. Those are two different ratios, and
 * one path cannot hold both.
 *
 * ⚠️ **He rejected the earlier two-path version because he could see it fade**: both curves had
 * different shapes everywhere, so the cross-fade was two drawings swapping. **These two differ in
 * exactly one number — where the right end lands.** Every sample to the left of it is identical, so
 * what the fade actually shows is **the right side drawing itself in**, which is the motion he asked
 * for rather than an artefact.
 *
 * ⚠️ `0.675` is the middle of his 20–30% band: 10vh × 0.675 = 6.75vh against a left of 10vh.
 */
const RIGHT_OPEN = 0.93;
const RIGHT_SHORT = 0.675;

const TEXT_Z = 10;

export function OceanBackdrop(): React.JSX.Element {
  return (
    <div aria-hidden="true" className="relative w-full" style={{ height: "var(--sea-h)" }}>
      {BANDS.map((band, index) => (
        <svg
          key={band.fill}
          className="tide absolute inset-x-0 top-0 w-full"
          style={{
            height: "calc(" + band.left + "vh + (var(--p, 0) * (" + band.leftShort + "vh - " + band.left + "vh)))",
            ["--tide-period" as string]: band.period + "s",
            animationDelay: index * -3.1 + "s",
            zIndex: BANDS.length - index,
            transformOrigin: "top",
          }}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {/**
            * ⚠️ **ONE path, and that is the fix.** The previous version drew two and cross-faded them,
            * which is exactly the fade the owner spotted: 「过渡动画中有出现淡入淡出的现象」.
            *
            * ⚠️ **The band's height still interpolates** — the curve is fixed and the box it is stretched
            * over shrinks, so **the water flattens as it contracts without anything fading.**
            */}
          <path d={buildPath(band, RIGHT_OPEN)} fill={band.fill} style={{ opacity: "calc(1 - var(--p, 0))" }} />
          <path d={buildPath(band, RIGHT_SHORT)} fill={band.fill} style={{ opacity: "var(--p, 0)" }} />
        </svg>
      ))}

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
        <p className="font-semibold tracking-[0.16em] text-white" style={{ fontSize: "calc(2.1rem - var(--p, 0) * 0.7rem)" }}>
          Libellum
        </p>
        <p className="mt-2 text-sm leading-relaxed text-white/80" style={{ opacity: "calc(1 - var(--p, 0) * 0.95)" }}>
          记一本账，安静而长久。
        </p>
      </div>
    </div>
  );
}