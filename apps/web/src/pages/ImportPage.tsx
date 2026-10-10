import type { ImportReport } from "@libellum/shared";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { Button } from "../components/Button.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { InnerPage } from "../components/Layouts.js";
import { errorMessage } from "../lib/api.js";
import { fetchTemplate, useImportEntries } from "../lib/queries.js";
import { deliverFile } from "../lib/share.js";

/**
 * Import historical entries from a CSV.
 *
 * The shape of this screen follows from one decision made on the server: an
 * import either writes **every** valid row or **none** of them. So there is no
 * partial state to report and no "23 of 40 rows imported" to explain — the
 * outcome is a report the user reads, and then either they fix the file or the
 * entries are there.
 *
 * Two things the owner asked for and the server now guarantees, surfaced here
 * rather than left in a log: a rejected file names **which line** and **which
 * column**, and a file that has already been imported is recognised instead of
 * being imported twice.
 */

type Step =
  | { readonly name: "choose" }
  | { readonly name: "confirm"; readonly file: File }
  | { readonly name: "report"; readonly report: ImportReport };

export function ImportPage(): React.JSX.Element {
  const navigate = useNavigate();
  const importEntries = useImportEntries();
  const fileInput = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>({ name: "choose" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function downloadTemplate(): Promise<void> {
    setError(null);
    try {
      const file = await fetchTemplate();
      await deliverFile(file.fileName, file.mimeType, file.bytes);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function run(file: File): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const report = await importEntries.mutateAsync(file);
      setStep({ name: "report", report });
    } catch (caught) {
      setError(errorMessage(caught));
      setStep({ name: "choose" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <InnerPage
      title="导入历史账"
      subtitle="用导出的文件或模板填写，逐行校验通过后才会写入。任何一行有问题，整批都不会写入。"
      backTo="/export"
    >
      {error === null ? null : <Alert>{error}</Alert>}

      {step.name === "choose" ? (
        <section className="flex flex-col gap-4">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            aria-label="选择 CSV 文件"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Reset so choosing the same file twice still fires a change —
              // otherwise a corrected file re-picked after a failure looks like
              // nothing happened.
              event.target.value = "";
              if (file !== undefined) setStep({ name: "confirm", file });
            }}
          />

          <Button
            onClick={() => {
              fileInput.current?.click();
            }}
            disabled={busy}
          >
            选择 CSV 文件
          </Button>

          <Button variant="secondary" onClick={() => void downloadTemplate()}>
            下载模板
          </Button>

          <div className="rounded-field bg-brand-soft px-4 py-3 text-xs leading-relaxed text-brand-dark">
            <p className="font-medium">关于判重</p>
            <p className="mt-1">
              文件里带的「流水编号」如果这个账本已经有了，那一行会被跳过，并在报告里写出来。
              同一个文件再导入一次不会产生重复记录。
            </p>
            <p className="mt-2">
              没有这几列的外部文件也能导入，但那时无法判重，可能产生重复。
            </p>
          </div>

          <Button
            variant="ghost"
            onClick={() => {
              void navigate("/export");
            }}
          >
            ← 返回导出
          </Button>
        </section>
      ) : null}

      {step.name === "report" ? (
        <Report
          report={step.report}
          onDone={() => {
            setStep({ name: "choose" });
            void navigate("/");
          }}
          onAgain={() => {
            setStep({ name: "choose" });
          }}
        />
      ) : null}

      {/* The confirmation the owner asked for: say how many rows, and what will
          happen, before anything is written. */}
      <ConfirmDialog
        open={step.name === "confirm"}
        title="确认导入"
        description="会先校验整个文件，通过后才写入这本账。"
        confirmLabel={busy ? "正在导入…" : "开始导入"}
        cancelLabel="取消"
        // Not `danger`: importing adds records. A red confirm button would say
        // "this deletes something", which is the opposite of what it does.
        tone="default"
        busy={busy}
        onCancel={() => {
          setStep({ name: "choose" });
        }}
        onConfirm={() => {
          if (step.name === "confirm") void run(step.file);
        }}
        consequences={[
          `文件：${step.name === "confirm" ? step.file.name : ""}`,
          "逐行校验通过后才会写入；任何一行有问题，整批都不会写入。",
          "已经在账本里的记录会被跳过，不会重复。",
        ]}
      />
    </InnerPage>
  );
}

/**
 * What happened, in the order a person needs it.
 *
 * A rejected file gets every problem listed — not the first one — because fixing
 * a spreadsheet one error per attempt is miserable. The line numbers are the
 * file's own, so they can be found by opening it.
 */
function Report({
  report,
  onDone,
  onAgain,
}: {
  readonly report: ImportReport;
  readonly onDone: () => void;
  readonly onAgain: () => void;
}): React.JSX.Element {
  if (!report.ok) {
    return (
      <section className="flex flex-col gap-4">
        <Alert>
          没有写入任何数据：文件里有 {String(report.errors.length)} 处问题，全部改好之后再导入一次。
        </Alert>

        <ul className="overflow-hidden rounded-field border border-line bg-surface">
          {report.errors.slice(0, 50).map((problem) => (
            <li
              key={`${String(problem.line)}-${problem.column ?? ""}`}
              className="flex gap-3 border-b border-line px-4 py-3 text-sm last:border-b-0"
            >
              <span className="shrink-0 font-mono text-xs text-muted">第 {problem.line} 行</span>
              <span className="text-ink">
                {problem.column === null ? "" : `${problem.column}：`}
                {problem.message}
              </span>
            </li>
          ))}
        </ul>

        {report.errors.length > 50 ? (
          <p className="text-xs text-muted">
            只显示了前 50 处，还有 {String(report.errors.length - 50)} 处。
          </p>
        ) : null}

        <Button onClick={onAgain}>换一个文件</Button>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <Alert tone="success">
        已导入 {String(report.importedCount)} 条记录。
        {report.skippedCount > 0 ? `另有 ${String(report.skippedCount)} 条已经存在，已跳过。` : ""}
      </Alert>

      <dl className="overflow-hidden rounded-field border border-line bg-surface">
        <Row label="文件里的数据行" value={`${String(report.rowCount)} 条`} />
        <Row label="写入" value={`${String(report.importedCount)} 条`} />
        <Row label="跳过（已存在）" value={`${String(report.skippedCount)} 条`} />
        {report.fileRef === undefined ? null : (
          <Row label="导入编号" value={report.fileRef} mono />
        )}
        {report.exportedFileRef === null || report.exportedFileRef === undefined ? null : (
          <Row label="来自这次导出" value={report.exportedFileRef} mono />
        )}
      </dl>

      <p className="text-xs leading-relaxed text-muted">
        导入编号是这次导入的标识，写进了这批每一笔记录里，日后可以据此追溯它们是从哪个文件来的。
      </p>

      <Button onClick={onDone}>回到明细</Button>
      <Button variant="secondary" onClick={onAgain}>
        再导入一个文件
      </Button>
    </section>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={`text-sm text-ink ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
