// @effect-diagnostics nodeBuiltinImport:off -- Stata and SAS leave their results in host files.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  AnalysisDiagnostic,
  AnalysisRunContext,
  AnalysisRunOutcome,
} from "@scientfactory/analysis";

import { pathModule } from "../compute/RuntimeDiscovery.ts";

interface FileState {
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAt: bigint;
  readonly changedAt: bigint;
}

/** What each place held before the run. */
export type BatchLogBaseline = ReadonlyMap<string, FileState | null>;

/** A tool that prints almost nothing and writes its results to files Run reads afterwards. */
export interface BatchLogs {
  readonly args: (executable: string, context: AnalysisRunContext) => ReadonlyArray<string>;
  readonly places: (context: AnalysisRunContext) => ReadonlyArray<string>;
  readonly conclude: (
    context: AnalysisRunContext,
    exitCode: number | null,
    before: BatchLogBaseline,
  ) => Promise<AnalysisRunOutcome>;
}

async function stateOf(path: string): Promise<FileState | null> {
  try {
    const stats = await NodeFSP.stat(path, { bigint: true });
    return stats.isFile()
      ? { inode: stats.ino, size: stats.size, modifiedAt: stats.mtimeNs, changedAt: stats.ctimeNs }
      : null;
  } catch {
    return null;
  }
}

export async function batchLogBaseline(paths: ReadonlyArray<string>): Promise<BatchLogBaseline> {
  return new Map(
    await Promise.all(paths.map(async (path) => [path, await stateOf(path)] as const)),
  );
}

/** Written by this run: absent before or changed since, so an earlier run's file is never shown. */
async function fresh(path: string, before: BatchLogBaseline): Promise<boolean> {
  const now = await stateOf(path);
  const then = before.get(path) ?? null;
  return (
    now !== null &&
    (then === null ||
      then.inode !== now.inode ||
      then.size !== now.size ||
      then.modifiedAt !== now.modifiedAt ||
      then.changedAt !== now.changedAt)
  );
}

/** Leaves room under the run's 4 MiB output limit for what the tool printed. */
const BATCH_LOG_BUDGET = { head: 2 * 1024 * 1024, tail: 1024 * 1024 };

function decode(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Stata before 14, and SAS in its default Windows session encoding, write Windows-1252.
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.replace(/^﻿/u, "").replaceAll("\r\n", "\n").replaceAll("\f", "");
}

/** The whole file, or its start and end around a line saying how much is left out. */
export async function readBatchLog(
  path: string,
  budget = BATCH_LOG_BUDGET,
): Promise<{ readonly text: string; readonly tail: string }> {
  const handle = await NodeFSP.open(path, "r");
  try {
    const { size } = await handle.stat();
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };
    if (size <= budget.head + budget.tail) {
      const text = decode(await read(0, size));
      return { text, tail: text };
    }
    // Whole lines only, so no character is cut in two.
    const start = await read(0, budget.head);
    const head = start.subarray(0, start.lastIndexOf(0x0a) + 1);
    const end = await read(size - budget.tail, budget.tail);
    let from = end.indexOf(0x0a) + 1;
    if (from === 0) while (from < end.length && (end[from]! & 0xc0) === 0x80) from += 1;
    const tail = end.subarray(from);
    const skipped = (size - head.length - tail.length) / (1024 * 1024);
    const name = NodePath.basename(path);
    const tailText = decode(tail);
    return {
      text: `${decode(head)}\n… ${skipped.toFixed(skipped >= 10 ? 0 : 1)} MB more of ${name} …\n\n${tailText}`,
      tail: tailText,
    };
  } finally {
    await handle.close();
  }
}

function projectRelative(
  path: ReturnType<typeof pathModule>,
  cwd: string,
  file: string,
): string | null {
  const relative = path.relative(cwd, file);
  return relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)
    ? null
    : relative.split(path.sep).join("/");
}

const stemOf = (path: ReturnType<typeof pathModule>, file: string) =>
  path.basename(file).replace(/\.[^.]+$/u, "");

const runtimeError = (
  index: number,
  prefix: string,
  code: string | null,
  message: string,
  relativePath: string,
  line: number | null,
): AnalysisDiagnostic => ({
  diagnosticId: `${prefix}-error-${index + 1}`,
  severity: "error",
  source: "runtime",
  code,
  message: message.slice(0, 16 * 1024),
  relativePath,
  line,
  column: null,
  frames: [],
  related: [],
});

const STATA_RETURN_CODE = /^r\((\d+)\);\s*$/u;
const STATA_TRAILER = /^(?:\s*|end of do-file\s*|r\(\d+\);\s*)$/u;

/** Batch Stata exits 0 after an error; a log that ends in r(#); is the real signal. */
export function stataError(
  log: string,
): { readonly code: number; readonly message: string; readonly command: string | null } | null {
  const lines = log.split("\n");
  let end = lines.length;
  while (end > 0 && /^\s*$|^end of do-file\s*$/u.test(lines[end - 1]!)) end -= 1;
  const last = STATA_RETURN_CODE.exec(lines[end - 1] ?? "");
  if (last === null) return null;
  let at = end - 1;
  while (at >= 0 && STATA_TRAILER.test(lines[at]!)) at -= 1;
  const message: string[] = [];
  while (at >= 0 && !/^[.>] /u.test(lines[at]!) && message.length < 20) {
    message.unshift(lines[at]!);
    at -= 1;
  }
  const command = /^\. (.+)$/u.exec(lines[at] ?? "")?.[1]?.trim() ?? null;
  return { code: Number(last[1]), message: message.join("\n").trim(), command };
}

/** The line a command came from, when the do-file has it exactly once. */
function lineOf(source: string, command: string | null): number | null {
  if (command === null) return null;
  const lines = source
    .split(/\r?\n/u)
    .flatMap((line, index) => (line.trim() === command ? [index + 1] : []));
  return lines.length === 1 ? lines[0]! : null;
}

/** A `stata` link to the window program is still the window program. */
function realName(executable: string): string {
  const real = (() => {
    try {
      return NodeFS.realpathSync(executable);
    } catch {
      return executable;
    }
  })();
  return real
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)!
    .replace(/\.exe$/iu, "");
}

function stata(platform: NodeJS.Platform): BatchLogs {
  const path = pathModule(platform);
  const places = (context: AnalysisRunContext) => {
    const name = `${stemOf(path, context.absoluteSourcePath)}.log`;
    // Stata writes the log in the folder it starts in; some reports put it beside the do-file.
    return [
      ...new Set([
        path.join(context.source.cwd, name),
        path.join(path.dirname(context.absoluteSourcePath), name),
      ]),
    ];
  };
  return {
    places,
    // Console Stata exits after -b. The window programs, StataMP on a Mac and every Windows Stata,
    // wait for a click after -b or /b, so they take -e or /e. Off Windows, Stata reads the words
    // after its options as one command, so a path with a space is quoted.
    args: (executable, context) => {
      const file = context.absoluteSourcePath;
      if (platform === "win32") return ["/q", "/e", "do", file];
      const batch = /^stata(?:-(?:mp|se|be|ic))?$/u.test(realName(executable)) ? "-b" : "-e";
      return ["-q", batch, "do", /\s/u.test(file) ? `"${file}"` : file];
    },
    conclude: async (context, exitCode, before) => {
      const candidates = places(context);
      const written = await Promise.all(candidates.map((place) => fresh(place, before)));
      const log = candidates.find((_, index) => written[index]);
      if (log === undefined) {
        return {
          output: [],
          failureMessage:
            exitCode === 0
              ? `Stata did not write ${path.basename(candidates[0]!)} in ${context.source.cwd}, so there is nothing to show. Stata needs to be able to write there.`
              : `Stata exited with code ${exitCode}.`,
          diagnostics: [],
          writtenFiles: [],
        };
      }
      const { text, tail } = await readBatchLog(log);
      const relative = projectRelative(path, context.source.cwd, log);
      const writtenFiles = relative === null ? [] : [relative];
      const error = stataError(tail);
      if (error === null && exitCode === 0) {
        const result = text
          .replace(/^\s*\. do [^\n]*\n\n?/u, "")
          .replace(/\n*end of do-file\s*$/u, "\n");
        return {
          output: [{ stream: "stdout", text: result }],
          failureMessage: null,
          diagnostics: [],
          writtenFiles,
        };
      }
      if (error === null) {
        return {
          output: [{ stream: "stdout", text }],
          failureMessage: `Stata exited with code ${exitCode}.`,
          diagnostics: [],
          writtenFiles,
        };
      }
      const source = await NodeFSP.readFile(context.absoluteSourcePath, "utf8").catch(() => "");
      const code = `r(${error.code})`;
      const message = error.message || `Stata stopped with error ${code}.`;
      return {
        output: [{ stream: "stdout", text }],
        failureMessage: `${message.split("\n")[0]} (${code})`,
        diagnostics: [
          runtimeError(
            0,
            "stata",
            code,
            message,
            context.source.relativePath,
            lineOf(source, error.command),
          ),
        ],
        writtenFiles,
      };
    },
  };
}

/** SAS's ERROR: or WARNING: lines, each with the indented lines that continue it. */
export function sasMessages(
  log: string,
  kind: "ERROR" | "WARNING",
): ReadonlyArray<{ readonly code: string | null; readonly message: string }> {
  const start = new RegExp(`^${kind}(?: (\\d+-\\d+))?:\\s?(.*)$`, "u");
  const found: Array<{ code: string | null; message: string }> = [];
  let current: { code: string | null; lines: string[] } | null = null;
  for (const line of log.split("\n")) {
    const match = start.exec(line);
    // Under a source line SAS marks the spot with underscores and a code number, also indented.
    if (
      current !== null &&
      match === null &&
      /^\s{2,}\S/u.test(line) &&
      !/^[\s\d_]+$/u.test(line)
    ) {
      current.lines.push(line.trim());
      continue;
    }
    if (current !== null) found.push({ code: current.code, message: current.lines.join(" ") });
    current = match === null ? null : { code: match[1] ?? null, lines: [match[2]!.trim()] };
  }
  if (current !== null) found.push({ code: current.code, message: current.lines.join(" ") });
  return found;
}

const SAS_STOPPED: Readonly<Record<number, string>> = {
  3: "The program stopped at an ABORT statement.",
  4: "The program stopped at an ABORT RETURN statement.",
  5: "The program stopped at an ABORT ABEND statement.",
  6: "SAS could not start.",
};

function sas(platform: NodeJS.Platform): BatchLogs {
  const path = pathModule(platform);
  // Named outright: SAS documents its default folder only on UNIX.
  const files = (context: AnalysisRunContext) => {
    const stem = stemOf(path, context.absoluteSourcePath);
    return {
      log: path.join(context.source.cwd, `${stem}.log`),
      listing: path.join(context.source.cwd, `${stem}.lst`),
    };
  };
  return {
    places: (context) => Object.values(files(context)),
    args: (_executable, context) => {
      const { log, listing } = files(context);
      return ["-sysin", context.absoluteSourcePath, "-log", log, "-print", listing];
    },
    conclude: async (context, exitCode, before) => {
      const places = files(context);
      const readFresh = async (place: string) =>
        (await fresh(place, before)) ? (await readBatchLog(place)).text : null;
      const listing = await readFresh(places.listing);
      const log = await readFresh(places.log);
      const writtenFiles = [
        ...(listing === null ? [] : [places.listing]),
        ...(log === null ? [] : [places.log]),
      ].flatMap((place) => projectRelative(path, context.source.cwd, place) ?? []);
      // 0 ran cleanly and 1 ran with warnings: both are results.
      if (exitCode === 0 || exitCode === 1) {
        const result = listing?.trim() ? listing : (log ?? "");
        const warnings = exitCode === 1 && log !== null ? sasMessages(log, "WARNING") : [];
        return {
          output: [
            ...(result === "" ? [] : [{ stream: "stdout" as const, text: result }]),
            ...warnings.map((warning) => ({
              stream: "stderr" as const,
              text: `WARNING: ${warning.message}\n`,
            })),
          ],
          failureMessage: null,
          diagnostics: [],
          writtenFiles,
        };
      }
      const errors = log === null ? [] : sasMessages(log, "ERROR");
      return {
        output: [log, listing].flatMap((text) =>
          text === null ? [] : [{ stream: "stdout" as const, text }],
        ),
        failureMessage:
          errors[0]?.message ||
          (exitCode === null ? undefined : SAS_STOPPED[exitCode]) ||
          `SAS exited with code ${exitCode}.`,
        diagnostics: errors
          .slice(0, 20)
          .map((error, index) =>
            runtimeError(
              index,
              "sas",
              error.code,
              error.message || "SAS reported an error.",
              context.source.relativePath,
              null,
            ),
          ),
        writtenFiles,
      };
    },
  };
}

/** The run-table languages whose results are files, by language. */
export function batchLogsFor(languageId: string, platform: NodeJS.Platform): BatchLogs | undefined {
  return languageId === "stata"
    ? stata(platform)
    : languageId === "sas"
      ? sas(platform)
      : undefined;
}
