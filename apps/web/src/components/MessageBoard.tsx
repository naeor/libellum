import { useState } from "react";

import { errorMessage } from "../lib/api.js";
import { useBookMessages, useSendBookMessage } from "../lib/queries.js";

/**
 * **这本账的留言板 —— 围绕账目的公共讨论，不是聊天。**
 *
 * ⚠️ **The owner's framing decides the shape**: *"我希望它更接近一个**围绕账本的公共讨论空间**"*,
 * with a list of things he explicitly does **not** want — *"消息撤回、表情包、语音聊天、在线状态、
 * 已读回执"*. So there is **no bubble styling, no avatars, no typing indicator, no read state**:
 * a message is a name, a time and a sentence.
 *
 * ⚠️ **Nothing here says "私聊".** The board is the same for everybody in the ledger — that is the
 * property that makes it a discussion about the books. **A layout that looked like a chat app would
 * promise a private channel it does not have.**
 */
export function MessageBoard(): React.JSX.Element {
  const messages = useBookMessages();
  const send = useSendBookMessage();

  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(): void {
    const body = draft.trim();
    if (body === "") return;

    setError(null);
    void send
      .mutateAsync(body)
      .then(() => {
        setDraft("");
      })
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
      });
  }

  if (messages.isPending) return <p className="text-sm text-muted">正在读取留言……</p>;
  if (messages.isError) return <p className="text-sm text-muted">留言读取失败。</p>;

  const { messages: list } = messages.data;

  return (
    <div className="flex flex-col gap-3">
      {error !== null ? (
        <p role="alert" className="rounded-field bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {/**
        * ⚠️ **Empty is stated, not blank.** The owner's own example of what this is for is a question
        * somebody asks out loud — *"昨天买菜的 86 元是不是还没有记？"* — so the empty state says what
        * the board is for rather than being a void.
        */}
      {list.length === 0 ? (
        <p className="rounded-card border border-line bg-surface px-5 py-4 text-sm leading-relaxed text-muted">
          这本账还没有留言。这里可以讨论和这本账有关的事，比如「昨天买菜的 86 元是不是还没有记？」。
        </p>
      ) : (
        <ul className="overflow-hidden rounded-card border border-line bg-surface">
          {list.map((message) => (
            <li
              key={message.id}
              className="flex flex-col gap-0.5 border-b border-line px-5 py-3 last:border-b-0"
            >
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="text-xs text-muted">{message.senderName}</span>
                <span className="text-xs text-muted">{formatWhen(message.createdAt)}</span>
              </span>
              {/**
                * ⚠️ **`break-words`, because a message is arbitrary text.** Without it **one long
                * pasted string scrolls the whole page sideways on a phone** — and the person who
                * pasted it will not connect the two.
                */}
              <span className="break-words text-sm text-ink">{message.body}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-2 text-xs text-muted">
          说点什么
          <textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            /**
             * ⚠️ **The same 500 the server enforces.** A client that allowed more would let somebody
             * type a paragraph and only then be refused — **and the text would be gone.**
             */
            maxLength={500}
            rows={2}
            placeholder="这笔房租我已经付过了。"
            className="rounded-field border border-line bg-canvas px-4 py-3 text-sm text-ink"
          />
        </label>

        <button
          type="button"
          disabled={send.isPending || draft.trim() === ""}
          onClick={submit}
          className="self-start rounded-field bg-brand px-4 py-2 text-sm text-white transition hover:bg-brand-dark disabled:opacity-45"
        >
          {send.isPending ? "正在发送……" : "发送"}
        </button>
      </div>
    </div>
  );
}

/**
 * The instant, in the reader's own words.
 *
 * ⚠️ **Coarser than the history's version on purpose** — a board reads as a conversation, and
 * *"今天 14:32"* is what somebody wants; seconds would be noise. **A message from last month says the
 * date, because "12 天前" is arithmetic the reader should not have to do.**
 */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  const now = new Date();

  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

  if (sameDay(at, now)) return `今天 ${time}`;
  if (sameDay(at, yesterday)) return `昨天 ${time}`;

  return `${String(at.getMonth() + 1)} 月 ${String(at.getDate())} 日 ${time}`;
}
