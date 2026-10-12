import { useState } from "react";

import { Button } from "./Button.js";
import { errorMessage } from "../lib/api.js";
import { useCollaborators, useMintReferralCode } from "../lib/queries.js";

/**
 * **账户级的邀请码 —— 属于账号，不属于任何一本账。**
 *
 * ⚠️ **This block lives on the account screen, and the owner moved it there on purpose**:
 *
 * > *"用于注册 Libellum 账号的普通或次级邀请码，与加入某一本账本的分享邀请不同。
 * >  前者属于**账号级功能**，适合放在**「账户」的相关设置**中，不需要占据当前账本的协作页面。"*
 *
 * ⚠️ **The two are easy to confuse and behave nothing alike.** A referral code creates a **new
 * account** — with its own ledger and **no access to any of mine** — and all it records is *who
 * invited them*. A share link joins **an existing account to one ledger**. Putting the first on the
 * ledger's collaboration screen invites the reader to think it does the second.
 *
 * ⚠️ **It was on `CollaboratorsPage` and was moved here in S9.5 P3.** The old placement is exactly
 * the mistake the owner's sentence rules out.
 */
export function ReferralCodeSection(): React.JSX.Element {
  const collaborators = useCollaborators();
  const referral = useMintReferralCode();

  const [open, setOpen] = useState(false);
  const [allowDirect, setAllowDirect] = useState(false);
  const [mintedCode, setMintedCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * ⚠️ **The remaining count comes from the server with the collaborator list.** A second tally here
   * would eventually disagree with the one the mint path enforces (`教训.md` §8.12) — and the screen
   * would be the one that was wrong.
   */
  const quota = collaborators.data?.referralQuota ?? null;
  const remaining = quota === null ? null : Math.max(0, quota.limit - quota.used);
  const exhausted = remaining !== null && remaining === 0;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm text-muted">
          邀请码
          {quota === null ? null : (
            <span className="ml-2 text-xs text-muted">
              终身 {String(quota.limit)} 个 · 已用 {String(quota.used)} 个 · 还剩 {String(remaining ?? 0)} 个
            </span>
          )}
        </h2>

        {open || exhausted ? null : (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
            className="text-xs text-brand transition hover:text-brand-dark"
          >
            生成邀请码
          </button>
        )}
      </div>

      {error !== null ? (
        <p role="alert" className="rounded-field bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {/**
        * ⚠️ **Exhausted is said out loud, not left as a missing button.** A person who used their
        * three codes and finds the button gone will assume the app is broken or that they forgot
        * something — **while a limit that is stated is simply the rule.**
        */}
      {exhausted ? (
        <p className="rounded-card border border-line bg-surface px-5 py-4 text-sm leading-relaxed text-muted">
          次级邀请码一共只能生成 {String(quota?.limit ?? 3)} 个，你已经用完了。
          这是终身额度，撤销或过期的邀请码不会退还名额。
        </p>
      ) : null}

      {mintedCode === null ? null : (
        <div className="rounded-card border border-brand bg-brand-soft/40 px-5 py-4">
          <p className="text-xs text-muted">把这个码给要注册的人：</p>
          <p className="mt-2 rounded-field bg-surface px-3 py-2 text-center font-mono text-lg tracking-widest text-ink">
            {mintedCode}
          </p>
          <div className="mt-3 flex gap-3">
            <Button
              fullWidth={false}
              onClick={() => {
                void navigator.clipboard.writeText(mintedCode).catch(() => undefined);
              }}
            >
              复制
            </Button>
            <Button
              variant="secondary"
              fullWidth={false}
              onClick={() => {
                setMintedCode(null);
                setOpen(false);
                setAllowDirect(false);
              }}
            >
              完成
            </Button>
          </div>
        </div>
      )}

      {open && mintedCode === null ? (
        <div className="rounded-card border border-line bg-surface p-5">
          <label className="flex items-start gap-3 text-sm text-ink">
            <input
              type="checkbox"
              checked={allowDirect}
              onChange={(event) => {
                setAllowDirect(event.target.checked);
              }}
              className="mt-1"
            />
            <span>
              让新注册的人可以直接把我加为协作者
              <span className="mt-1 block text-xs leading-relaxed text-muted">
                不勾选的话，他注册后不会看到关于你的提醒。勾选与否都不影响账目权限——
                想让他进某一本账，仍然要单独邀请，而且他也要同意。
              </span>
            </span>
          </label>

          <div className="mt-4 flex gap-3">
            <Button
              disabled={referral.isPending}
              onClick={() => {
                setError(null);
                void referral
                  .mutateAsync(allowDirect)
                  .then((minted) => {
                    setMintedCode(minted.code);
                  })
                  .catch((caught: unknown) => {
                    setError(errorMessage(caught));
                  });
              }}
            >
              {referral.isPending ? "正在生成……" : "生成"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
                setAllowDirect(false);
              }}
            >
              取消
            </Button>
          </div>
        </div>
      ) : null}

      <p className="text-xs leading-relaxed text-muted">
        用邀请码注册的人得到的是一个普通账号，与你的账本没有关系。
        通过邀请码注册的账号不能再生成邀请码——否则一次邀请会被变成无数次。
      </p>
    </section>
  );
}
