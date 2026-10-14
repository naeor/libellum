import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { CopyButton } from "../components/CopyButton.js";
import { InnerPage } from "../components/Layouts.js";
import { useAccountOffline } from "../lib/offline/connectivity.js";
import { cacheFootprint, type CacheFootprint } from "../lib/offline/downloadManager.js";
import { readOfflineLog } from "../lib/offline/diagnostics.js";
import { APP_VERSION, buildStamp, buildStampLocal } from "../lib/version.js";

/**
 * The version screen.
 *
 * ⚠️ **The owner asked for this after three rounds of diagnosing a build he was not running**:
 * "在账户中加入软件更新部分，点进去之后会进入软件更新页面，会显示当前的版本号以及所有你认为
 * 必要的数据等等."
 *
 * **The screen exists to answer one question before any debugging starts: what am I actually
 * running, and is the device holding the same thing the code says it should?** Every number on
 * it is there because a specific round of this project was slowed down by not having it:
 *
 *  * **the version** — which release this is meant to be;
 *  * **the build stamp, in local time with its zone** — when it was actually built, because
 *    reading a UTC value as local time is how "nine minutes old" got reported as "last night",
 *    and reading a local time without its zone is how `16:18` got compared against `07:18`;
 *  * **whether a service worker is in control** — the mechanism that can serve old code, and the
 *    one that took three rounds to suspect;
 *  * **what is stored, and how much of it** — because "offline shows nothing" and "offline has
 *    nothing" look the same until you count.
 */
export function SoftwareUpdatePage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { offline, reason } = useAccountOffline();

  const [footprint, setFootprint] = useState<CacheFootprint | null>(null);
  const [logCount, setLogCount] = useState(0);
  const [workerState, setWorkerState] = useState<string>("读取中…");

  const load = useCallback(async () => {
    const [measured, log] = await Promise.all([cacheFootprint(queryClient), readOfflineLog()]);

    setFootprint(measured);
    setLogCount(log.length);

    /**
     * ⚠️ **Named explicitly, including "none".**
     *
     * A service worker in control can serve the copy of the app on the device. That is what it is
     * for offline, and it is also how a device keeps running code the developer has already
     * replaced — so whether one is in charge belongs on the version screen rather than in a
     * developer tool.
     */
    try {
      const registrations = (await navigator.serviceWorker?.getRegistrations()) ?? [];
      const controlling = navigator.serviceWorker?.controller !== null;

      setWorkerState(
        registrations.length === 0
          ? "没有注册（开发模式）"
          : `${String(registrations.length)} 个注册${controlling ? "，正在控制本页" : "，未控制本页"}`,
      );
    } catch {
      setWorkerState("无法读取");
    }
  }, [queryClient]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = [
    `Libevra ${APP_VERSION}`,
    `构建时间（本机）：${buildStampLocal()}`,
    `构建时间（UTC）：${buildStamp()}`,
    `Service Worker：${workerState}`,
    `网络：${offline ? `离线（${reason === "unreachable" ? "服务器没有答复" : "浏览器报告离线"}）` : "在线"}`,
    `缓存条目：${String(footprint?.queryCount ?? 0)} 条，其中 ${String(footprint?.liveQueryCount ?? 0)} 条当前版本会读`,
    `缓存大小：${String(footprint?.cacheBytes ?? 0)} 字节`,
    `运行记录：${String(logCount)} 条`,
    `页面：${window.location.href}`,
    `时间：${new Date().toISOString()}`,
  ].join("\n");

  return (
    <InnerPage title="软件更新" subtitle="这台设备正在运行的版本，以及它保存了什么。" backTo="/me">
      {/*
        ⚠️ **The copy button sits under the description and above the version number, as asked:**
        "把它放到'这台设备正在运行的版本，以及它保存了什么'那行描述性文字下面居中放置，也就是在
        1.08.01的版本号之前放置."

        It was in the header's action slot, which is where a *navigation* control belongs. Copying
        is not navigation — it is something you do *to* the information on the page, so it belongs
        with that information, before it rather than after.

        ⚠️ **And it brings its own text box.** Two rounds were spent trying to detect when the
        clipboard would fail; the tablet then answered differently on two screens running identical
        code. **A fallback that has to predict the failure can be wrong; one that is always there
        cannot** — and text on screen can be screenshotted, which works on every device.
      */}
      <CopyButton text={summary} label="复制版本信息" rows={10} />

      <section className="flex flex-col gap-2 rounded-card border border-line bg-surface px-4 py-3">
        <p className="text-2xl font-semibold tracking-tight text-ink">{APP_VERSION}</p>

        <dl className="flex flex-col gap-1 text-micro text-muted">
          <div className="flex justify-between gap-3">
            <dt>构建时间</dt>
            <dd className="text-right font-mono text-ink">{buildStampLocal()}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>构建标记</dt>
            <dd className="text-right font-mono">{buildStamp()}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Service Worker</dt>
            <dd className="text-right">{workerState}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>网络</dt>
            <dd className="text-right">
              {offline
                ? `离线（${reason === "unreachable" ? "服务器没有答复" : "浏览器报告离线"}）`
                : "在线"}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>本机缓存条目</dt>
            <dd className="text-right">
              {footprint === null
                ? "读取中…"
                : `${String(footprint.queryCount)} 条（${String(footprint.liveQueryCount)} 条有效）`}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>运行记录</dt>
            <dd className="text-right">{logCount} 条</dd>
          </div>
        </dl>
      </section>

      {/*
        ⚠️ **The text is always on screen, not only as a fallback.**

        His tablet refuses the clipboard — "似乎是我的pad的问题" — so anything that can only be
        copied is unreachable on that device. The text is here, selected on touch, and can be
        screenshotted; the button is a convenience rather than the only way through.
      */}
    </InnerPage>
  );
}
