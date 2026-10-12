import { useState } from "react";

import { NotificationBell } from "../components/Notifications.js";
import { Button } from "../components/Button.js";
import { InnerPage } from "../components/Layouts.js";
import { SkeletonRows } from "../components/States.js";
import { errorMessage } from "../lib/api.js";
import {
  useCollaborators,
  useInviteToBook,
  useLookupAccount,
  useRequestCollaborator,
  type CollaboratorView,
} from "../lib/queries.js";

/**
 * 协作者 —— the account-level list, with the current ledger's people on top.
 *
 * ⚠️ **This replaced a placeholder page that had been in the bottom navigation since before the
 * feature existed.** It said "该功能尚未开放" — honest, but the owner has now been looking at that
 * tab for months with nothing behind it, and the shape of the page was already drawn: a bell at the
 * top, a list of people, and a way to add one.
 *
 * ⚠️ **The list is account-level, but the current ledger's people come first.** The owner's own
 * example: A shares ledger 1 with B and ledger 2 with C, so A's collaborators are {B, C} — one list,
 * both of them. Yet the person he is looking at the ledger with is the one he is most likely to
 * mean, so they are pinned to the top and marked. **That is why this screen works with no ledger at
 * all**: the list does not depend on one, it only prefers one.
 */
export function CollaboratorsPage(): React.JSX.Element {
  const collaborators = useCollaborators();
  const lookup = useLookupAccount();
  const request = useRequestCollaborator();
  const invite = useInviteToBook();

  const [adding, setAdding] = useState(false);
  const [accountNumber, setAccountNumber] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  /** ⚠️ Separate from `sentTo`: asking somebody to be a collaborator and inviting them into a
   * ledger are two different messages, and one confirmation must not be shown for the other. */
  const [invited, setInvited] = useState<string | null>(null);

  const found = lookup.data;


  function reset(): void {
    setAdding(false);
    setAccountNumber("");
    setMessage("");
    setError(null);
    setSentTo(null);
    lookup.reset();
  }

  return (
    <InnerPage
      title="协作者"
      subtitle="邀请他人一同管理账目。协作者身份本身不授予账目权限——权限由每本账的成员身份决定。"
      backTo="/"
    >
      <div className="flex flex-col gap-6">
        {/**
         * ⚠️ **The bell sits at the top of this page**, which is where the owner asked for it, and its
         * red dot is the only thing on this screen that demands attention unprompted.
         */}
        <NotificationBell />

        {error !== null ? (
          <p role="alert" className="rounded-field bg-danger-soft px-4 py-3 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm text-muted">
              我的协作者{collaborators.isSuccess ? `（${String(collaborators.data.collaborators.length)}）` : ""}
            </h2>

            {adding ? null : (
              <button
                type="button"
                onClick={() => {
                  setAdding(true);
                }}
                className="text-xs text-brand transition hover:text-brand-dark"
              >
                添加协作者
              </button>
            )}
          </div>

          {adding ? (
            <div className="rounded-card border border-line bg-surface p-5">
              <label className="flex flex-col gap-2 text-sm text-muted">
                对方的账号编号（8 位数字）
                <input
                  value={accountNumber}
                  onChange={(event) => {
                    setAccountNumber(event.target.value);
                    setSentTo(null);
                  }}
                  inputMode="numeric"
                  maxLength={8}
                  placeholder="10000001"
                  className="rounded-field border border-line bg-canvas px-4 py-3 font-mono text-ink"
                />
              </label>

              <p className="mt-2 text-xs leading-relaxed text-muted">
                让对方在他的「账户」页面读到编号给你。只能用完整的八位编号查找——
                这是为了避免有人一个数字一个数字地翻出所有账号。
              </p>

              {found === undefined ? null : (
                <div className="mt-4 rounded-field border border-line bg-canvas px-4 py-3">
                  <p className="text-sm text-ink">
                    {found.displayName}（{found.username}）
                  </p>

                  {found.isCollaborator ? (
                    <p className="mt-1 text-xs text-muted">你们已经是协作者了。</p>
                  ) : found.hasPendingRequest ? (
                    <p className="mt-1 text-xs text-muted">你已经发过申请，正在等对方处理。</p>
                  ) : (
                    <>
                      <label className="mt-3 flex flex-col gap-2 text-xs text-muted">
                        附一句话（可选，最多 200 字）
                        <input
                          value={message}
                          onChange={(event) => {
                            setMessage(event.target.value);
                          }}
                          maxLength={200}
                          placeholder="我是……"
                          className="rounded-field border border-line bg-surface px-3 py-2 text-ink"
                        />
                      </label>

                      <button
                        type="button"
                        disabled={request.isPending}
                        onClick={() => {
                          setError(null);
                          void request
                            .mutateAsync({
                              accountNumber: found.accountNumber,
                              ...(message.trim() === "" ? {} : { message: message.trim() }),
                            })
                            .then(() => {
                              setSentTo(found.displayName);
                            })
                            .catch((caught: unknown) => {
                              setError(errorMessage(caught));
                            });
                        }}
                        className="mt-3 w-full rounded-field bg-brand px-4 py-3 text-sm text-white transition hover:bg-brand-dark disabled:opacity-45"
                      >
                        {request.isPending ? "正在发送……" : "发送申请"}
                      </button>
                    </>
                  )}
                </div>
              )}

              {sentTo !== null ? (
                <p role="status" className="mt-3 rounded-field bg-brand-soft px-4 py-3 text-sm text-brand-dark">
                  申请已发给 {sentTo}。对方同意后，他才会出现在你的协作者列表里。
                </p>
              ) : null}

              <div className="mt-4 flex gap-3">
                <button
                  type="button"
                  disabled={lookup.isPending || accountNumber.trim().length !== 8}
                  onClick={() => {
                    setError(null);
                    setSentTo(null);
                    void lookup.mutateAsync(accountNumber.trim()).catch((caught: unknown) => {
                      setError(errorMessage(caught));
                    });
                  }}
                  className="flex-1 rounded-field bg-brand px-4 py-3 text-sm text-white transition hover:bg-brand-dark disabled:opacity-45"
                >
                  {lookup.isPending ? "正在查找……" : "查找"}
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="flex-1 rounded-field bg-canvas px-4 py-3 text-sm text-muted transition hover:text-ink"
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}

          {collaborators.isPending ? <SkeletonRows rows={2} /> : null}

          {collaborators.isSuccess && collaborators.data.collaborators.length === 0 ? (
            <p className="rounded-card border border-line bg-surface px-5 py-4 text-sm leading-relaxed text-muted">
              这个列表是空的。添加之后，你就可以邀请他加入某一本账。
            </p>
          ) : null}

          {collaborators.isSuccess && collaborators.data.collaborators.length > 0 ? (
            <ul className="overflow-hidden rounded-card border border-line bg-surface">
              {collaborators.data.collaborators.map((person) => (
                <li key={person.userId} className="border-b border-line last:border-b-0">
                  <CollaboratorRow
                    person={person}
                    hasCurrentBook={collaborators.data.currentBookId !== null}
                    onInvite={(role) => {
                      setError(null);
                      void invite
                        .mutateAsync({ accountNumber: person.accountNumber, role })
                        .then(() => {
                          setInvited(person.displayName);
                        })
                        .catch((caught: unknown) => {
                          setError(errorMessage(caught));
                        });
                    }}
                    busy={invite.isPending}
                  />
                </li>
              ))}
            </ul>
          ) : null}

          {invited !== null ? (
            <p role="status" className="rounded-field bg-brand-soft px-4 py-3 text-sm text-brand-dark">
              已邀请 {invited} 加入当前账本。对方在铃铛里同意之后才会真正加入。
            </p>
          ) : null}

          <p className="text-xs leading-relaxed text-muted">
            协作者是账号级的：你和同一个人在多本账里协作，他也只出现一次。
            当前账本里的协作者会排在最前面。
          </p>
        </section>

      </div>
    </InnerPage>
  );
}

function CollaboratorRow({
  person,
  hasCurrentBook,
  busy,
  onInvite,
}: {
  readonly person: CollaboratorView;
  /** ⚠️ With no ledger in hand there is nothing to invite anybody into, so the button is absent. */
  readonly hasCurrentBook: boolean;
  readonly busy: boolean;
  readonly onInvite: (role: "editor" | "viewer") => void;
}): React.JSX.Element {
  const [choosing, setChoosing] = useState(false);

  return (
    <div
      className={`flex flex-col gap-3 px-5 py-4 ${
        person.inCurrentBook ? "bg-brand-soft/40" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-2 text-sm text-ink">
            {person.displayName}
            {person.inCurrentBook ? (
              <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] text-brand-dark">
                当前账本
              </span>
            ) : null}
            {person.currentBookRole === "viewer" ? (
              <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] text-muted">仅查看</span>
            ) : null}
          </span>

          <span className="font-mono text-xs text-muted">
            {person.accountNumber} · {person.username}
          </span>
        </span>

        {!person.inCurrentBook && hasCurrentBook && !choosing ? (
          <button
            type="button"
            onClick={() => {
              setChoosing(true);
            }}
            className="shrink-0 text-xs text-brand transition hover:text-brand-dark"
          >
            邀请进当前账本
          </button>
        ) : null}
      </div>

      {choosing ? (
        <div className="flex flex-wrap items-center gap-3 rounded-field border border-line bg-canvas px-4 py-3">
          <span className="text-xs text-muted">给他什么权限？</span>

          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setChoosing(false);
              onInvite("editor");
            }}
            className="rounded-field bg-brand px-3 py-1.5 text-xs text-white transition hover:bg-brand-dark disabled:opacity-45"
          >
            可编辑
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setChoosing(false);
              onInvite("viewer");
            }}
            className="rounded-field bg-surface px-3 py-1.5 text-xs text-muted transition hover:text-ink disabled:opacity-45"
          >
            仅查看
          </button>

          <button
            type="button"
            onClick={() => {
              setChoosing(false);
            }}
            className="text-xs text-muted transition hover:text-ink"
          >
            取消
          </button>
        </div>
      ) : null}
    </div>
  );
}
