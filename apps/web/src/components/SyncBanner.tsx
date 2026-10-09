import { useOnlineStatus } from "../lib/connectivity.js";

/**
 * The offline warning.
 *
 * It sits at the very top and stays there for as long as the browser reports no
 * connection, because the risk it describes is invisible otherwise: the screen
 * keeps showing the last numbers it fetched, and a total that is quietly out of
 * date looks exactly like a total that is correct.
 *
 * It says three things, in order: what is wrong, what it means for the numbers,
 * and what the user can expect.
 */
export function SyncBanner(): React.JSX.Element | null {
  const online = useOnlineStatus();

  if (online) return null;

  return (
    <div
      role="status"
      className="sticky top-0 z-30 bg-danger px-5 py-2.5 text-center text-xs leading-relaxed font-medium text-white"
    >
      当前处于离线状态：无法与服务器同步，页面上的金额可能不是最新的，新增记录也无法保存。
    </div>
  );
}
