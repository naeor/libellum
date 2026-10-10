import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "../components/Button.js";
import { ChoiceDialog, type Choice } from "../components/ChoiceDialog.js";
import { InnerPage } from "../components/Layouts.js";
import { CopyButton } from "../components/CopyButton.js";
import { cacheFootprint, describeKey, type CacheFootprint } from "../lib/offline/downloadManager.js";
import { clearOfflineLog, readOfflineLog, type LogEntry } from "../lib/offline/diagnostics.js";
import { formatBytes, storageBreakdown, type StorageBreakdown } from "../lib/offline/persistence.js";
import { resetEverything } from "../lib/offline/reset.js";
import { databaseReport, type DatabaseReport } from "../lib/offline/dbstatus.js";
import { readTrace, traceLine, readValue } from "../lib/offline/storage.js";

/**
 * The diagnostics screen, behind a "more" button.
 *
 * ⚠️ **The owner asked for it to move, and gave the reason with the request**: the download
 * log and the storage breakdown had been on the download manager's home screen, where they
 * are noise for anybody who is not chasing a problem. "把下载记录和存储明细……都不显示在下载
 * 管理主页。主页右上角新增一个更多按钮（三个点图标）."
 *
 * **And he asked for one thing more, which is the important part**: "还有一个按钮提供一键复制
 * 到剪贴板，底下写上小字提示用户如果碰到bug可以复制这些内容并提交给开发者."
 *
 * That turns the screen from something to *read* into something to *send*. Every round of
 * this offline work has been slowed down by the same gap — the person holding the phone
 * could see the problem and the developer could not — and a button that puts the whole state
 * on the clipboard is the shortest path between them.
 */
export function DownloadMorePage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [log, setLog] = useState<readonly LogEntry[]>([]);
  const [footprint, setFootprint] = useState<CacheFootprint | null>(null);
  const [storage, setStorage] = useState<StorageBreakdown | null>(null);
  const [queries, setQueries] = useState<readonly string[]>([]);
  const [trace, setTrace] = useState<readonly string[]>([]);
  const [db, setDb] = useState<DatabaseReport | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const [entries, measured, breakdown, database] = await Promise.all([
        readOfflineLog(),
        cacheFootprint(queryClient),
        storageBreakdown(),
        databaseReport(),
      ]);

      setDb(database);

      setLog(entries);
      setFootprint(measured);
      setStorage(breakdown);

      /**
       * The stored keys, listed so the clipboard text can be read without this app.
       *
       * `describeKey` prints the **field count** as well as the values, because "four fields
       * or three" is exactly what distinguishes a leftover entry from a live one — and it
       * is invisible if only the values are shown.
       */
      const raw = await readValue<{ clientState?: { queries?: readonly { queryKey?: unknown }[] } }>(
        "query-cache",
      );

      setQueries((raw?.clientState?.queries ?? []).map((query) => describeKey(query.queryKey)));

      /**
       * ⚠️ **The storage layer's own trace, every line of it.**
       *
       * It records each open, read and write with the key and what came back — including *why*
       * a read failed, which is the one thing an empty ledger cannot tell you. The owner asked
       * for the diagnostics to be as rich as possible and said the length does not matter,
       * since he copies the whole thing anyway.
       */
      setTrace(readTrace().map((line) => traceLine(line)));
    } finally {
      setLoading(false);
    }
  }, [queryClient]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Everything a developer would need, as plain text. */
  const report = [
    "Libellum · 离线诊断",
    /**
     * ⚠️ **The build first, and it is not decoration.**
     *
     * Three rounds were spent diagnosing code that had not reached the device. A report that
     * does not say which build produced it cannot be trusted to be about the current one — and
     * the giveaway was subtle: an identical timestamp to the previous report.
     */
    `构建：${__BUILD_STAMP__}`,
    `时间：${new Date().toISOString()}`,
    `页面：${window.location.href}`,
    "",
    "== 占用构成 ==",
    storage === null
      ? "(未读取)"
      : [
          `总计：${formatBytes(storage.totalBytes)}`,
          `账本数据：${formatBytes(storage.queryCacheBytes)}`,
          `应用本体：${formatBytes(storage.shellCacheBytes)}`,
          `运行记录：${formatBytes(storage.diagnosticsBytes)}`,
          `浏览器其它：${formatBytes(storage.otherBytes)}`,
        ].join("\n"),
    "",
    "== 缓存条目 ==",
    footprint === null
      ? "(未读取)"
      : `共 ${String(footprint.queryCount)} 条，其中 ${String(footprint.liveQueryCount)} 条当前版本会读`,
    ...(footprint?.heaviest ?? []).map(
      (entry) => `  ${entry.label} — ${formatBytes(entry.bytes)}`,
    ),
    "",
    `== 存储追踪（${String(trace.length)} 条，最旧在前） ==`,
    ...trace,
    "",
    `== 全部存储键（${String(queries.length)} 条） ==`,
    ...queries,
    "",
    `== 运行记录（${String(log.length)} 条，最新在前） ==`,
    ...log.map((entry) => `${new Date(entry.at).toISOString()} ${entry.what}${entry.detail === undefined ? "" : ` — ${entry.detail}`}`),
    "",
  ].join("\n");

  /**
   * The version somebody can paste into a chat window.
   *
   * ⚠️ **Deliberately short, and it keeps only what identifies the situation**: which build,
   * which page, what is stored, whether the database opened. The trace and the log are what makes
   * the full report long, and they are only needed once the short one has narrowed it down.
   */
  const shortReport = [
    `Libellum · 离线诊断（简版）`,
    `构建：${__BUILD_STAMP__}`,
    `页面：${window.location.href}`,
    `网络：${navigator.onLine ? "在线" : "离线"}`,
    `缓存条目：${String(footprint?.queryCount ?? 0)} 条（${String(footprint?.liveQueryCount ?? 0)} 条有效）`,
    `缓存大小：${String(footprint?.cacheBytes ?? 0)} 字节`,
    `数据库：${db === null ? "(未读取)" : db.opened ? `可打开，${String(db.keyCount)} 个键：${db.keys.join(",")}` : `打不开 — ${db.error ?? "未知"}`}`,
    `缓存内容：${db === null ? "(未读取)" : `${db.cacheKind}，${String(db.cacheBytes)} 字节，${db.cacheParses ? `可解析 ${String(db.cacheQueryCount)} 条` : "不可解析"}`}`,
    `占用：总计 ${formatBytes(storage?.totalBytes ?? 0)} / 账本 ${formatBytes(storage?.queryCacheBytes ?? 0)}`,
    `运行记录：${String(log.length)} 条`,
  ].join("\n");

  return (
    <InnerPage
      title="下载管理 · 更多"
      subtitle="下载记录与存储明细。"
      backTo="/downloads"
      /*
        ⚠️ **The back control replaces rather than pushes.**
        
        The owner found a loop: signing out from this screen bounced between it and the download
        manager. Part of the cause is history that grows every time a screen is entered from a
        button rather than from the back stack — so entering here from the manager and pressing
        返回 should return to the manager, not add a third entry that has to be unwound.
      */
      onBack={() => void navigate("/downloads", { replace: true })}
    >
      <section className="flex flex-col gap-3">
        {/*
          ⚠️ **The shared button, because this one silently did nothing.**
          
          The owner asked for the same behaviour here as on the version screen, and reported that
          this one "还是没有生效" — the click handler had been written separately, its outcome was
          never read, the label never changed, and no fallback was ever offered. **A feature
          implemented twice is a feature that works in one of the two places**, and which one is
          decided by luck.
          
          ⚠️ **And the fallback is inside the button now, always rendered.** Two rounds were spent
          detecting when the clipboard would fail; the tablet then answered differently on two
          screens running identical code. **A fallback that has to predict a failure can be wrong;
          one that is always present cannot** — and text on screen can be screenshotted.
        */}
        <CopyButton
          text={shortReport}
          label="复制简版诊断"
          rows={5}
          hint="短的，方便直接发在聊天里。"
        />

        {/*
          ⚠️ **Two lengths, because the owner found the limit the hard way**: "他复制这个剪贴版，
          但是因为太长了，所以没法在微信发出来；而我看到粘贴之后什么都没有，就以为他是没粘贴上."

          **A report that cannot be sent is a report that does not exist** — and the failure looked
          exactly like a broken clipboard, which is why it was diagnosed as one twice. The short
          version fits in a message; the full one is for when somebody asks for it.
        */}
        <CopyButton
          text={report}
          label="复制完整诊断"
          rows={12}
          hint="完整的，包含存储追踪与全部运行记录。"
        />

        <p className="text-xs leading-relaxed text-muted">
          服务器上的账目不受影响；这里只是本机的副本。
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <Button
          variant="danger"
          onClick={() => {
            setConfirmReset(true);
          }}
        >
          清除本应用的全部本地数据
        </Button>

        <p className="text-xs leading-relaxed text-muted">
          会删掉本机上的账本副本、应用缓存和离线记录，然后重新加载。
          服务器上的数据不受影响，联网后可以重新下载。
        </p>
      </section>

      <ChoiceDialog
        open={confirmReset}
        title="清除本机全部数据？"
        description="服务器上的账目不会被删除。清除后需要重新下载才能离线查看。"
        choices={RESET_CHOICES}
        onChoose={(choice) => {
          setConfirmReset(false);
          if (choice !== "reset") return;

          void resetEverything().finally(() => {
            window.location.reload();
          });
        }}
      />

      {storage === null ? null : (
        <section className="flex flex-col gap-1.5 rounded-card border border-line bg-surface px-4 py-3 text-sm">
          <h2 className="text-xs text-muted">占用构成</h2>
          <p className="text-ink">总计 {formatBytes(storage.totalBytes)}</p>
          <ul className="flex flex-col gap-0.5 text-[11px] text-muted">
            <li>账本数据 {formatBytes(storage.queryCacheBytes)}</li>
            <li>应用本体（HTML / JS / CSS）{formatBytes(storage.shellCacheBytes)}</li>
            <li>运行记录 {formatBytes(storage.diagnosticsBytes)}</li>
            <li>浏览器其它 {formatBytes(storage.otherBytes)}</li>
          </ul>
          {/*
            ⚠️ **The honest note about the remainder.**

            "浏览器其它" is the biggest number on the screen and it is **not ours to clear**:
            `storage.estimate()` counts the whole origin, including data Chrome may hold
            before writing it to disk. Saying what it is stops the ledger taking the blame,
            and stops a "free up space" button being expected where none can exist.
          */}
          <p className="text-[11px] leading-relaxed text-muted">
            「浏览器其它」由浏览器自己记账，可能包含还没写到磁盘的数据，应用无法直接清除。
          </p>
        </section>
      )}

      {footprint === null ? null : (
        <section className="flex flex-col gap-1.5 rounded-card border border-line bg-surface px-4 py-3 text-sm">
          <h2 className="text-xs text-muted">缓存条目</h2>
          <p className="text-ink">
            共 {footprint.queryCount} 条，其中 {footprint.liveQueryCount} 条当前版本会读取
          </p>
          <ul className="flex flex-col gap-0.5 text-[11px] text-muted">
            {footprint.heaviest.map((entry) => (
              <li key={entry.label} className="flex justify-between gap-3">
                <span className="min-w-0 truncate font-mono">{entry.label}</span>
                <span className="shrink-0">{formatBytes(entry.bytes)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs text-muted">运行记录（{log.length} 条）</h2>
          <button
            type="button"
            onClick={() => {
              void clearOfflineLog().then(() => load());
            }}
            className="text-[11px] text-muted underline"
          >
            清空
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-muted">正在读取…</p>
        ) : log.length === 0 ? (
          <p className="text-sm text-muted">还没有记录。</p>
        ) : (
          <ul className="flex flex-col gap-1 rounded-card border border-line bg-surface px-4 py-3">
            {log.map((entry, index) => (
              <li
                key={`${String(entry.at)}-${String(index)}`}
                className="text-[11px] leading-relaxed"
              >
                <span className="font-mono text-muted">{new Date(entry.at).toLocaleTimeString()}</span>{" "}
                <span className="text-ink">{entry.what}</span>
                {entry.detail === undefined ? null : (
                  <span className="text-muted"> — {entry.detail}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </InnerPage>
  );
}

/**
 * What to offer before wiping the device's copy.
 *
 * 清除并重新加载 names both halves of what happens, because the reload is not incidental —
 * the app cannot run with its own cache removed. 先不清理 is the dismissive option, since
 * closing the dialog is the same as doing nothing.
 */
const RESET_CHOICES: readonly Choice<"reset" | "cancel">[] = [
  { id: "reset", label: "清除并重新加载", hint: "需要联网重新下载", primary: true },
  { id: "cancel", label: "先不清理", dismissive: true },
];
