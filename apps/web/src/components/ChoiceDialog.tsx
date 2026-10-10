import { useEffect, useRef } from "react";

/**
 * A dialog that offers a small number of named ways forward.
 *
 * Separate from `ConfirmDialog` because that one asks a yes/no question, and
 * this one asks a "which of these" question. Forcing three choices into a
 * primary/cancel pair would mean inventing a default nobody asked for.
 *
 * **The owner's rule, and the reason this exists**: when recognition fails,
 * *do not decide for the user*. The first version of that fix sent them straight
 * to the manual form, which silently removed the two options they might have
 * preferred — trying again, or going back and choosing a different picture. What
 * a failure needs is the choices, not a decision made on the user's behalf.
 *
 * Three properties worth stating:
 *
 *  * **Every option is a button, stacked.** Side by side they would be narrow
 *    enough on a phone to mis-tap, and these options differ in what happens
 *    next — a mis-tap costs a screen, not a colour.
 *  * **Dismissal is one of the options**, not an extra affordance. A dialog with
 *    a close button *and* a "cancel" option presents the same choice twice and
 *    invites the question of whether they differ.
 *  * **Escape and the backdrop do the dismissing thing**, which is the option
 *    marked `dismissive` — so a keyboard or a stray tap behaves like the choice
 *    that means "leave this alone".
 */
export interface Choice<Id extends string> {
  readonly id: Id;
  readonly label: string;
  /** One line under the label, for the option whose consequence is not obvious. */
  readonly hint?: string;
  /** Rendered in the theme colour; at most one should be primary. */
  readonly primary?: boolean;
  /** What Escape and a backdrop tap do. Exactly one option should be dismissive. */
  readonly dismissive?: boolean;
}

export function ChoiceDialog<Id extends string>({
  open,
  title,
  description,
  choices,
  onChoose,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly choices: readonly Choice<Id>[];
  readonly onChoose: (id: Id) => void;
}): React.JSX.Element | null {
  const firstRef = useRef<HTMLButtonElement>(null);
  const dismiss = choices.find((choice) => choice.dismissive === true);

  useEffect(() => {
    if (!open) return;

    // Focus the first option rather than the dismissive one: unlike a
    // destructive confirmation, nothing here can lose data, and the first option
    // is the one most people want. A dialog nobody can drive from the keyboard
    // is a dialog that traps them.
    firstRef.current?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && dismiss !== undefined) {
        event.preventDefault();
        onChoose(dismiss.id);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, dismiss, onChoose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 px-5 backdrop-blur-[2px]"
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        if (dismiss !== undefined) onChoose(dismiss.id);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="choice-title"
        aria-describedby="choice-description"
        className="w-full max-w-sm rounded-card border border-line bg-surface p-6 shadow-lg"
      >
        <h2 id="choice-title" className="text-base font-semibold text-ink">
          {title}
        </h2>
        <p id="choice-description" className="mt-2 text-sm leading-relaxed text-muted">
          {description}
        </p>

        <div className="mt-6 flex flex-col gap-2.5">
          {choices.map((choice, index) => (
            <button
              key={choice.id}
              ref={index === 0 ? firstRef : undefined}
              type="button"
              onClick={() => {
                onChoose(choice.id);
              }}
              className={`w-full rounded-field px-4 py-3 text-left transition ${
                choice.primary === true
                  ? "bg-brand text-white hover:bg-brand-dark"
                  : "bg-brand-soft text-brand-dark hover:bg-brand-soft/70"
              }`}
            >
              <span className="block text-[15px] font-medium">{choice.label}</span>
              {choice.hint === undefined ? null : (
                <span
                  className={`mt-0.5 block text-xs ${
                    choice.primary === true ? "text-white/80" : "text-brand-dark/75"
                  }`}
                >
                  {choice.hint}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
