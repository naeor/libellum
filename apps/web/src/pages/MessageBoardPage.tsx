import { MessageBoardFull } from "../components/MessageBoard.js";
import { SkeletonRows } from "../components/States.js";
import { useLedger } from "../lib/queries.js";

/**
 * **完整留言对话 —— 全屏，不是弹窗也不是半屏抽屉。**
 *
 * ⚠️ **The owner chose full screen explicitly**:
 *
 * > *"点击「展开」后，进入独立的全屏留言界面，而不是弹窗或半屏抽屉。"*
 *
 * ⚠️ **And it is a route rather than local state, which is what makes the phone's back gesture and
 * the browser's back button both close it** — a sheet would have to reimplement those, and would get
 * one of them wrong on somebody's device.
 *
 * ⚠️ **It reads the same `useBookMessages` the card does, and sends through the same
 * `useMessageComposer`** — *"两种界面应共享同一套发送、读取和权限逻辑"* and *"不应因为切换小窗口和
 * 完整界面而丢失已经成功发送的消息."* There is no second store here; the draft lives in the message
 * module precisely so that moving between the two views cannot lose it.
 *
 * ⚠️ **Returning goes back to `/ledger`, and does not change which ledger this is.** Nothing on this
 * page can: the ledger comes from the request header and from `currentBook`, both set elsewhere — so
 * *"返回时恢复原来的协作页面，不意外切换账本"* is a property of not touching them.
 */
export function MessageBoardPage(): React.JSX.Element {
  const ledger = useLedger();

  /**
   * ⚠️ **The name waits for the ledger rather than showing a placeholder heading**, because the
   * header says which ledger's board this is — and a wrong or empty name there is exactly the "which
   * ledger am I in" confusion the whole isolation design exists to prevent.
   */
  if (ledger.isPending) {
    return (
      <div className="mx-auto w-full max-w-md px-6 py-8">
        <SkeletonRows rows={4} />
      </div>
    );
  }

  if (ledger.isError) {
    /**
     * ⚠️ **Said plainly, with a way back.** Sending the reader to a board that cannot name its ledger
     * would risk them writing a sentence into the wrong one.
     */
    return (
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 px-6 py-8">
        <p className="rounded-card border border-line bg-surface px-5 py-4 text-body-relaxed text-muted">
          暂时无法载入账本信息，请返回账本页面重试。
        </p>
        <a href="/ledger" className="text-body text-brand transition hover:text-brand-dark">
          ‹ 返回账本
        </a>
      </div>
    );
  }

  return <MessageBoardFull bookName={ledger.data.book.name} />;
}
