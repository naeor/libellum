import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Alert } from "../components/Alert.js";
import { Button } from "../components/Button.js";
import { InnerPage } from "../components/Layouts.js";
import { copyText, type CopyOutcome } from "../lib/clipboard.js";
import { useAccountOffline } from "../lib/offline/connectivity.js";
import { cacheFootprint, type CacheFootprint } from "../lib/offline/downloadManager.js";
import { readOfflineLog } from "../lib/offline/diagnostics.js";
import { buildStamp, buildStampLocal, APP_VERSION } from "../lib/version.js";

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
 *  * **the build stamp, in local time** — when it was actually built, because reading a UTC
 *    value as local time is exactly how "nine minutes old" was reported as "last night";
 *  * **whether a service worker is in control** — the mechanism that can serve old code, and
 *    the one that took three rounds to suspect;
 *  * **what is stored, and how much of it** — because "offline shows nothing" and "offline has
 *    nothing" look the same until you count.
 */
export function SoftwareUpdatePage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { offline, reason } = useAccountOffline();

  const [footprint, setFootprint] = useState<CacheFootprint | null>(null);
  const [logCount, setLogCount] = useState(0);
  const [workerState, setWorkerState] = useState<string>("读取中…");
  const [copyOutcome, setCopyOutcome] = useState<CopyOutcome | null>(null);

  const load = useCallback(async () => {
    const [measured, log] = await Promise.all([cacheFootprint(queryClient), readOfflineLog()]);

    setFootprint(measured);
    setLogCount(log.length);

    /**
     * ⚠️ **Named explicitly, including "none".**
     *
     * A service worker in control can serve the copy of the app on the device. That is what it
     * is for offline, and it is also how a device keeps running code the developer has already
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

  const storedMonths = footprint === null ? 0 : footprint.queryCount;

  const summary = [
    `Libellum ${APP_VERSION}`,
    `构建时间（本机）：${buildStampLocal()}`,
    `构建时间（UTC）：${buildStamp()}`,
    `Service Worker：${workerState}`,
    `网络：${offline ? `离线（${reason === "unreachable" ? "服务器没有答复" : "浏览器报告离线"}）` : "在线"}`,
    `缓存条目：${String(storedMonths)} 条，其中 ${String(footprint?.liveQueryCount ?? 0)} 条当前版本会读`,
    `缓存大小：${String(footprint?.cacheBytes ?? 0)} 字节`,
    `运行记录：${String(logCount)} 条`,
    `页面：${window.location.href}`,
    `时间：${new Date().toISOString()}`,
  ].join("\n");

  return (
    <InnerPage
      title="软件更新"
      subtitle="这台设备正在运行的版本，以及它保存了什么。"
      backTo="/me"
      actions={
        <Button
          onClick={() => {
            void copyText(summary).then(setCopyOutcome);
          }}
        >
          复制
        </Button>
      }
    >
      <section className="flex flex-col gap-2 rounded-card border border-line bg-surface px-4 py-3">
        <p className="text-2xl font-semibold tracking-tight text-ink">{APP_VERSION}</p>

        <dl className="flex flex-col gap-1 text-[11px] text-muted">
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
        ⚠️ **The manual copy, always available on this screen.**

        The owner's tablet refuses the clipboard entirely — "这次更新之后复制还是没法粘贴下来，
        似乎是我的pad的问题" — so a button that only copies is a button that does nothing there.
        The text is on screen, selected on touch, and can be screenshotted.
      */}
      <section className="flex flex-col gap-2">
        <h2 className="text-xs text-muted">版本信息（可长按选择复制）</h2>
        <textarea
          readOnly
          value={summary}
          rows={9}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          className="w-full rounded-field border border-line bg-surface px-3 py-2 font-mono text-[10px] text-ink"
        />
      </section>

      {copyOutcome === "copied" ? <Alert tone="info">已复制。</Alert> : null}
      {copyOutcome === "manual" ? (
        <Alert tone="info">这个浏览器不允许自动复制，请长按上面的内容选择「复制」。</Alert>
      ) : null}
    </InnerPage>
  );
}
