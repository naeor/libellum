import { useEffect, useState } from "react";

import { Button } from "./Button.js";
import { CopyButton } from "./CopyButton.js";
import { QrCodeView } from "./QrCodeView.js";
import { errorMessage } from "../lib/api.js";
import { useCreateShareLink, useRevokeShareLink, useShareLinks, type ShareLinkView } from "../lib/queries.js";

/**
 * **分享链接 —— 一本账的链接邀请。**
 *
 * ⚠️ **Moved here from `LedgerSpacePage` in 1.10.08**, where it was a full module sitting on the
 * start page. The owner's diagnosis: *"开始页承载了过多管理功能，特别是「分享这本账」区域，直接展示分享
 * 权限、有效期、人数限制、生成链接等详细设置，导致页面结构过于复杂."* **All of it moved behind the
 * per-ledger gear**, and this file is what that gear now opens.
 *
 * ⚠️ **`bookId` is required, and the share hooks take it.** The panel is opened *for a ledger the
 * reader may not be in*, so reading the current ledger's links would show one ledger's links under
 * another ledger's name — both halves of the screen plausible, which is the worst shape this bug
 * can take.
 */
export function ShareSection({ bookId }: { readonly bookId: string }): React.JSX.Element {
  /**
    * ⚠️ **Every share call is made against `bookId`, not against the current ledger.** The panel this
    * renders in is opened for the ledger whose gear was tapped, which is not necessarily the one the
    * reader is in — see the note at the top of the file.
    */
  const links = useShareLinks(bookId);
  const create = useCreateShareLink(bookId);
  const revoke = useRevokeShareLink(bookId);
  const [role, setRole] = useState<"editor" | "viewer">("viewer");
  /**
   * ⚠️ **Defaults are the permissive end of the owner's ranges** (7 days, 10 people), so a person
   * who does not care gets a usable link. The pickers exist because the ranges are his
   * specification — *"分享链接（1–7 天、1–10 人、可撤销）"* — and **a range that can only be used at
   * one end is not the range he asked for.**
   */
  const [days, setDays] = useState(7);
  const [maxUses, setMaxUses] = useState(10);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const all = links.data?.links ?? [];
  const live = all.filter((link) => link.active);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-body text-muted">分享这本账</h2>

      {error !== null ? (
        <p role="alert" className="rounded-field bg-danger-soft px-4 py-3 text-body text-danger">
          {error}
        </p>
      ) : null}

      <p className="text-helper-relaxed text-muted">
        拿到链接的人打开后，会先看到这是哪本账、他会被给什么权限，确认之后才会加入。
        链接可以随时撤销；撤销之后旧的立刻失效。
      </p>

      {freshToken === null ? (
        <div className="flex flex-col gap-4 rounded-card border border-line bg-surface px-5 py-4">
          <Picker
            label="给对方的权限"
            value={role}
            options={[
              { value: "viewer" as const, label: "仅查看" },
              { value: "editor" as const, label: "可编辑" },
            ]}
            onPick={setRole}
          />

          {/**
            * ⚠️ **The two ranges are stated, not just enforced.** Somebody choosing "3 天" should be
            * able to see that 7 is the maximum, otherwise the picker looks like it simply ran out.
            */}
          <Picker
            label="有效期（1–7 天）"
            value={days}
            options={[1, 3, 7].map((value) => ({ value, label: `${String(value)} 天` }))}
            onPick={setDays}
          />

          <Picker
            label="最多几人可以加入（1–10）"
            value={maxUses}
            options={[1, 3, 5, 10].map((value) => ({ value, label: `${String(value)} 人` }))}
            onPick={setMaxUses}
          />

          <Button
            fullWidth={false}
            disabled={create.isPending}
            onClick={() => {
              setError(null);
              void create
                .mutateAsync({ role, days, maxUses })
                .then((created) => {
                  setFreshToken(created.token);
                })
                .catch((caught: unknown) => {
                  setError(errorMessage(caught));
                });
            }}
          >
            {create.isPending ? "正在生成……" : "生成分享链接"}
          </Button>
        </div>
      ) : (
        <div className="rounded-card border border-brand bg-brand-soft/40 px-5 py-4">
          <p className="text-helper text-muted">这条链接只会显示这一次，请现在复制并保存：</p>
          <p className="mt-2 break-all rounded-field bg-surface px-3 py-2 font-mono text-helper text-ink">
            {`${window.location.origin}/join/${freshToken}`}
          </p>
          {/**
            * ⚠️ **The link and the symbol sit together, and both are shown.** The owner asked for the
            * QR code *"方便当面扫码加入"* — two people in the same room. **The text stays because the
            * other case is unchanged**: somebody on a call who needs to paste it.
            *
            * ⚠️ **Same string in both**, taken from `window.location.origin` at render time, so a code
            * scanned on a phone points at whatever address the person generating it is actually using —
            * **not at a hostname baked into the bundle**, which would be wrong on every LAN and every
            * self-hosted deployment.
            */}
          <div className="mt-3 flex justify-center">
            <QrCodeView
              text={`${window.location.origin}/join/${freshToken}`}
              label="这本账的加入二维码"
            />
          </div>

          <p className="mt-2 text-center text-helper text-muted">让对方用相机扫这个码</p>
          <div className="mt-3 flex gap-3">
            <Button
              fullWidth={false}
              onClick={() => {
                void navigator.clipboard
                  .writeText(`${window.location.origin}/join/${freshToken}`)
                  .catch(() => undefined);
              }}
            >
              复制链接
            </Button>
            <Button variant="secondary" fullWidth={false} onClick={() => { setFreshToken(null); }}>
              我已保存
            </Button>
          </div>
        </div>
      )}

      {/**
        * ⚠️ **Every link is listed, including the dead ones.** An earlier version filtered to the
        * active ones — which meant **`已撤销`、`已过期`、`名额已用完` could never appear**, because a
        * link in those states had already been filtered out. The states existed in the code and were
        * unreachable on screen, which is `教训.md` §8.11 in miniature.
        */}
      {all.length > 0 ? (
        <ul className="overflow-hidden rounded-card border border-line bg-surface">
          {all.map((link) => (
            <LinkRow
              key={link.id}
              link={link}
              busy={revoke.isPending}
              onRevoke={() => {
                setError(null);
                void revoke.mutateAsync(link.id).catch((caught: unknown) => {
                  setError(errorMessage(caught));
                });
              }}
            />
          ))}
        </ul>
      ) : null}

      {links.isSuccess && all.length === 0 ? (
        <p className="text-helper text-muted">这本账现在没有分享链接。</p>
      ) : null}

      {all.length > 0 ? (
        <p className="text-helper-relaxed text-muted">
          生效中 {String(live.length)} 条。撤销与过期的链接会留在列表里——
          它们记录着"谁曾经可以进来"，删掉就没有依据可查了。
        </p>
      ) : null}
    </section>
  );
}

/**
 * A row of mutually exclusive choices.
 *
 * ⚠️ **Deliberately not a `<select>`.** These are three-to-four options on a phone, and the whole
 * point of *"1–7 天、1–10 人"* is that the person sees the range at a glance — **a dropdown hides
 * exactly the thing the range is for.**
 */
function Picker<T extends string | number>({
  label,
  value,
  options,
  onPick,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onPick: (value: T) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-full text-helper text-muted sm:w-auto">{label}</span>

      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          onClick={() => {
            onPick(option.value);
          }}
          className={`rounded-field px-3 py-1.5 text-xs transition ${
            option.value === value ? "bg-brand text-white" : "bg-canvas text-muted hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function LinkRow({
  link,
  busy,
  onRevoke,
}: {
  readonly link: ShareLinkView;
  readonly busy: boolean;
  readonly onRevoke: () => void;
}): React.JSX.Element {
  const remaining = Math.max(0, link.maxUses - link.useCount);

  /**
   * ⚠️ **Why a link stopped working is shown, not left to be guessed.** The three reasons send the
   * owner to different actions — revoke another link, generate a fresh one, or raise the cap next
   * time — and **"this link no longer works" without a reason is a support question.**
   */
  const state = link.revokedAt !== null
    ? "已撤销"
    : remaining === 0
      ? "名额已用完"
      : new Date(link.expiresAt).getTime() <= Date.now()
        ? "已过期"
        : null;

  return (
    <li className="flex items-center justify-between gap-4 border-b border-line px-5 py-4 last:border-b-0">
      <span className="flex flex-col gap-0.5">
        <span className="flex items-center gap-2 text-body text-ink">
          {link.role === "editor" ? "可编辑" : "仅查看"}
          {state === null ? (
            <span className="rounded-full bg-brand-soft px-2 py-0.5 text-micro text-brand-dark">
              生效中
            </span>
          ) : (
            <span className="rounded-full bg-canvas px-2 py-0.5 text-micro text-muted">{state}</span>
          )}
        </span>

        <span className="text-helper text-muted">
          {String(link.days)} 天 · 已加入 {String(link.useCount)}/{String(link.maxUses)} 人
          {remaining > 0 ? ` · 还剩 ${String(remaining)} 个名额` : ""}
        </span>

        <span className="text-helper text-muted">
          {link.lastUsedAt === null
            ? `生成于 ${link.createdAt.slice(0, 10)}`
            : `最近一次使用 ${link.lastUsedAt.slice(0, 10)}`}
        </span>
      </span>

      {link.revokedAt === null ? (
        <button
          type="button"
          disabled={busy}
          onClick={onRevoke}
          className="shrink-0 text-helper text-muted transition hover:text-danger disabled:opacity-45"
        >
          撤销
        </button>
      ) : null}
    </li>
  );
}
