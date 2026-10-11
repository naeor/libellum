import { useEffect, useState } from "react";

import { Button } from "../components/Button.js";
import { InnerPage } from "../components/Layouts.js";
import { clearAllMarks, readStoredMonths } from "../lib/offline/localLedger.js";

/**
 * The ledger's own "more" screen.
 *
 * ⚠️ **The owner asked for this, and it fixes something that had been in the wrong place**: "把清空带同步印记从
 * 下载管理-更多挪出来吧。明细页面不是还有一个'更多'键没用吗？让那个键点开之后，打开明细-更多页面."
 *
 * **He is right about both halves.** The button lived under 下载管理 — but **clearing a "not yet synced" mark is a
 * statement about entries, not about downloads**, and nobody looking for it would think to look there. And the
 * ledger's 更多 button had been disabled since it was drawn, saying "更多操作即将开放" — **an entry point that
 * exists and does nothing is worse than one that is not there**, which is the owner's own rule.
 */
export function LedgerMorePage(): React.JSX.Element {
  const [cleared, setCleared] = useState(false);
  const [counts, setCounts] = useState<{ readonly months: number; readonly entries: number } | null>(null);

  /**
   * ⚠️ **In an effect, not in the render body.** The first version called this during render, which would have
   * started a new read on **every** render — and the read itself sets state, so it would not have stopped. **A
   * side effect in a render body is not a slow screen, it is a loop.**
   */
  useEffect(() => {
    void (async () => {
      const months = await readStoredMonths();

      setCounts({
        months: Object.keys(months).length,
        entries: Object.values(months).reduce((total, list) => total + list.length, 0),
      });
    })();
  }, []);

  return (
    <InnerPage title="明细 · 更多">
      <div className="flex flex-col gap-5 px-6 py-5">
        <section className="flex flex-col gap-1">
          <h2 className="text-xs text-muted">这台设备</h2>
          <p className="text-sm text-ink">
            {counts === null
              ? "正在读取…"
              : `本机存着 ${String(counts.months)} 个月、${String(counts.entries)} 条账目。`}
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <Button
            onClick={() => {
              void (async () => {
                await clearAllMarks();
                setCleared(true);
              })();
            }}
          >
            {cleared ? "已清空待同步印记" : "清空「待同步」印记"}
          </Button>

          <p className="text-xs leading-relaxed text-muted">
            停止把这些账目当作「还没同步」「还没删除」或「等你要选」来提醒。
            不会发送任何请求，也不会删掉服务器或本机上的任何账目 —— 只是让它们不再带颜色。
            服务器上确实已经删掉的，本机下次取回列表时会照常消失。
          </p>
        </section>
      </div>
    </InnerPage>
  );
}
