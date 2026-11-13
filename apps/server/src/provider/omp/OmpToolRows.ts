/**
 * Scient Agent's shell, file and web-search tools shown as the typed rows Codex and Claude
 * produce: a command with its output and exit code, a file change with its diff, a search
 * with its sources. Every other tool stays a generic row, and so does any call with images.
 */
import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";

import type { NativeToolRow } from "../../orchestration-v2/Adapters/NativeSessionAdapterV2.ts";

/** A settled call keeps what the timeline fetches on demand; more is never shown. */
const MAX_TEXT_BYTES = 256 * 1024;
/** Each running frame is stored, so it keeps only as much as a generic row does. */
const MAX_RUNNING_TEXT_BYTES = 4096;
const MAX_SEARCH_RESULTS = 20;
const MAX_SNIPPET_LENGTH = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const nonEmpty = (value: unknown): string | undefined => {
  const text = string(value)?.trim();
  return text ? text : undefined;
};

const head = (value: string, max = MAX_TEXT_BYTES) =>
  Buffer.byteLength(value) <= max
    ? value
    : `${Buffer.from(value)
        .subarray(0, max)
        .toString("utf8")
        .replace(/\uFFFD$/u, "")}\n…`;

/** A command's latest output matters most, so a clipped output keeps its end. */
const tail = (value: string, max: number) => {
  const bytes = Buffer.from(value);
  return bytes.byteLength <= max
    ? value
    : `…\n${bytes
        .subarray(bytes.byteLength - max)
        .toString("utf8")
        .replace(/^\uFFFD/u, "")}`;
};

interface ToolCall {
  readonly input: unknown;
  /** The latest result frame: partial while running, final once settled. */
  readonly data: unknown;
  /** The call's text output so far, as the adapter read it from any frame. */
  readonly output: string | undefined;
  readonly status: "running" | "completed" | "failed";
}

const details = (data: unknown) =>
  isRecord(data) && isRecord(data.details) ? data.details : undefined;

interface FileSnapshot {
  readonly path: string;
  readonly oldPath?: string;
  readonly oldText?: string;
  readonly newText?: string;
}

const fileSnapshot = (value: unknown): FileSnapshot | undefined => {
  if (!isRecord(value)) return undefined;
  const path = nonEmpty(value.path);
  if (path === undefined) return undefined;
  const oldPath = nonEmpty(value.sourcePath);
  const oldText = string(value.oldText);
  const newText = string(value.newText);
  return {
    path,
    ...(oldPath === undefined ? {} : { oldPath }),
    ...(oldText === undefined ? {} : { oldText }),
    ...(newText === undefined ? {} : { newText }),
  };
};

/** A unified diff from the agent's before/after snapshots; its own diff text is not one. */
const snapshotPatch = (file: FileSnapshot): string | undefined => {
  if (file.oldText === undefined && file.newText === undefined) return undefined;
  const patch = structuredPatch(
    file.oldText === undefined ? "/dev/null" : (file.oldPath ?? file.path),
    file.newText === undefined ? "/dev/null" : file.path,
    file.oldText ?? "",
    file.newText ?? "",
  );
  return patch.hunks.length === 0 ? undefined : formatPatch(patch, FILE_HEADERS_ONLY);
};

const commandRow = (call: ToolCall, redact: (text: string) => string): NativeToolRow => {
  const { input, data, output, status } = call;
  const exitCode = details(data)?.exitCode;
  const max = status === "running" ? MAX_RUNNING_TEXT_BYTES : MAX_TEXT_BYTES;
  return {
    type: "command_execution",
    input: head(redact(string(isRecord(input) ? input.command : undefined) ?? ""), max),
    ...(output === undefined ? {} : { output: tail(redact(output), max) }),
    // The agent records an exit code only when it is not zero.
    ...(typeof exitCode === "number" && Number.isInteger(exitCode)
      ? { exitCode }
      : status === "completed"
        ? { exitCode: 0 }
        : {}),
  };
};

const editRow = (call: ToolCall, redact: (text: string) => string): NativeToolRow | undefined => {
  const { input, data, output, status } = call;
  const result = details(data);
  const files = (
    Array.isArray(result?.perFileResults) ? result.perFileResults : result ? [result] : []
  ).flatMap((file) => fileSnapshot(file) ?? []);
  const fileName = files[0]?.path ?? nonEmpty(isRecord(input) ? input.path : undefined);
  if (fileName === undefined) return undefined;
  const patches = files.flatMap((file) => snapshotPatch(file) ?? []);
  const failure = status === "failed" ? nonEmpty(output) : undefined;
  const diffStr = patches.length > 0 ? patches.join("") : failure;
  return {
    type: "file_change",
    fileName: redact(fileName),
    ...(diffStr === undefined ? {} : { diffStr: head(redact(diffStr)) }),
    ...(files.length > 1
      ? {
          changes: files.map((file) => ({
            operation: "edit",
            path: redact(file.path),
            ...(file.oldPath === undefined ? {} : { oldPath: redact(file.oldPath) }),
          })),
        }
      : {}),
  };
};

const writeRow = (call: ToolCall, redact: (text: string) => string): NativeToolRow | undefined => {
  const { input, data, output, status } = call;
  const fileName =
    nonEmpty(details(data)?.resolvedPath) ?? nonEmpty(isRecord(input) ? input.path : undefined);
  if (fileName === undefined) return undefined;
  const content = string(isRecord(input) ? input.content : undefined);
  const max = status === "running" ? MAX_RUNNING_TEXT_BYTES : MAX_TEXT_BYTES;
  const failure = status === "failed" ? nonEmpty(output) : undefined;
  return {
    type: "file_change",
    fileName: redact(fileName),
    // The agent does not report what a write replaced, so the row shows the new content.
    ...(content === undefined ? {} : { newStr: head(redact(content), max) }),
    ...(failure === undefined ? {} : { diffStr: head(redact(failure)) }),
  };
};

const searchRow = (call: ToolCall, redact: (text: string) => string): NativeToolRow => {
  const { input, data } = call;
  const query = nonEmpty(isRecord(input) ? input.query : undefined);
  const response = details(data)?.response;
  const sources = isRecord(response) && Array.isArray(response.sources) ? response.sources : [];
  const results = sources.slice(0, MAX_SEARCH_RESULTS).flatMap((source) => {
    if (!isRecord(source)) return [];
    const url = nonEmpty(source.url);
    const title = nonEmpty(source.title);
    const snippet = nonEmpty(source.snippet);
    if (url === undefined && title === undefined) return [];
    return [
      {
        ...(title === undefined ? {} : { title: redact(title) }),
        ...(url === undefined ? {} : { url: redact(url) }),
        ...(snippet === undefined
          ? {}
          : { snippet: redact(Array.from(snippet).slice(0, MAX_SNIPPET_LENGTH).join("")) }),
      },
    ];
  });
  return {
    type: "web_search",
    ...(query === undefined ? {} : { patterns: [redact(query)] }),
    ...(results.length === 0 ? {} : { results }),
  };
};

/**
 * Typed rows for one Scient Agent session. Later frames of a call may omit its arguments
 * or output, so the latest of each is kept, unbounded, until the call settles.
 */
export class OmpToolRows {
  private readonly calls = new Map<string, { input?: unknown; output?: string | undefined }>();
  private readonly redact: (text: string) => string;

  constructor(redact: (text: string) => string) {
    this.redact = redact;
  }

  row(
    toolCallId: string,
    name: string,
    frame: {
      readonly input: unknown;
      readonly data: unknown;
      readonly output: string | undefined;
      readonly status: "running" | "completed" | "failed";
    },
  ): NativeToolRow | undefined {
    const known = this.calls.get(toolCallId) ?? {};
    const call: ToolCall = {
      input: frame.input ?? known.input,
      data: frame.data,
      output: frame.output ?? known.output,
      status: frame.status,
    };
    if (frame.status === "running")
      this.calls.set(toolCallId, { input: call.input, output: call.output });
    else this.calls.delete(toolCallId);
    switch (name) {
      case "bash":
        return commandRow(call, this.redact);
      case "edit":
        return editRow(call, this.redact);
      case "write":
        return writeRow(call, this.redact);
      case "web_search":
        return searchRow(call, this.redact);
      default:
        return undefined;
    }
  }

  clear() {
    this.calls.clear();
  }
}
