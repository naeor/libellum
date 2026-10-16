import { useAccountOffline } from "../lib/offline/connectivity.js";

/**
 * The offline warning.
 *
 * It sits at the very top and stays there for as long as the account is cut off, because the
 * risk it describes is invisible otherwise: the screen keeps showing the last numbers it
 * fetched, and a total that is quietly out of date looks exactly like a total that is
 * correct.
 *
 * ⚠️ **Two signals, one banner.** The owner asked for them to be merged: "当这个判决条件被触发
 * 时或者服务器认为我们不在线（二者任意一项被触发）就默认账号已经离线." So this no longer
 * reads `navigator.onLine` — it reads the shared state, which is offline when **either** the
 * browser says so **or** a request failed to get an answer, and online again only once the
 * browser agrees **and** a request has succeeded.
 *
 * ⚠️ **And it says which of the two it is**, because they lead somewhere different: one is a
 * connection the user can do something about, the other is a server that is not answering and
 * which they can only wait out. A single message saying "check your network" would send half
 * its readers to look at the wrong thing.
 *
 * It also says what the app is doing about it, which is what makes the warning tolerable
 * rather than alarming: the data on screen is real, it came from this device, and anything
 * recorded now is kept until it can be sent.
 */
export function SyncBanner(): React.JSX.Element | null {
  const { offline, reason } = useAccountOffline();

  if (!offline) return null;

  return (
    <div
      role="status"
      className="sticky top-0 z-30 bg-danger px-5 py-2.5 text-center text-helper-relaxed font-medium text-white"
    >
      {reason === "unreachable"
        ? "暂时无法连接服务器，正在显示本机记录。"
        : "当前离线，正在显示本机记录。"}{" "}
      网络恢复后会自动同步。
    </div>
  );
}
