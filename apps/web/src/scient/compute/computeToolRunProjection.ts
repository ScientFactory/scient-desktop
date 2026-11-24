import type { ComputeExecutionRecord, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { resolveT3McpToolName } from "@t3tools/shared/t3McpToolPresentation";

const COMPUTE_RUN_TOOLS = new Set([
  "scient_compute_run",
  "scient_compute_run_file",
  "scient_compute_output",
]);

export function isComputeRunTool(name: string | null | undefined): boolean {
  return name != null && resolveT3McpToolName(name, COMPUTE_RUN_TOOLS) !== null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unwrapComputeResult(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string") {
    if (value.length > 512 * 1024) return undefined;
    try {
      return unwrapComputeResult(JSON.parse(value), depth + 1);
    } catch {
      const message = value.trim();
      return message && !message.startsWith("[") && !message.startsWith("{")
        ? { message }
        : undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const block of value.slice(0, 16)) {
      const text = record(block);
      if (text?.type !== "text") continue;
      const result = unwrapComputeResult(text.text, depth + 1);
      if (result !== undefined) return result;
    }
    return undefined;
  }
  const fields = record(value);
  if (!fields) return undefined;
  if (record(fields.run)) return fields;
  return (
    unwrapComputeResult(fields.structuredContent ?? fields.content ?? fields.error, depth + 1) ??
    (string(fields.message) ? fields : undefined)
  );
}

export function readComputeToolActivity(input: unknown, output: unknown) {
  const args = record(input);
  const result = unwrapComputeResult(output);
  const run = record(result?.run);
  const reportedFile = string(run?.source)?.match(
    /^(?:agent(?: \(this chat\))?: file of |agent: )(.+)$/u,
  )?.[1];
  const parameters = record(run?.parameters) ?? record(args?.parameters);
  const rawFile = reportedFile ?? string(args?.path);
  const file =
    rawFile && !/^(?:[~/\\]|[a-z]:)|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(rawFile)
      ? rawFile
      : undefined;
  return {
    code: string(args?.code),
    language: string(record(result?.session)?.language) ?? string(args?.language),
    file,
    session: string(record(result?.session)?.session) ?? string(args?.session),
    run: string(run?.run) ?? string(args?.run),
    status: string(run?.status),
    output: string(run?.output),
    ...(parameters === undefined
      ? {}
      : {
          parameters: Object.fromEntries(
            Object.entries(parameters).map(([name, value]) => [
              name,
              typeof value === "string" ? value : (JSON.stringify(value) ?? ""),
            ]),
          ),
        }),
    ...(run === undefined && typeof result?.message === "string" && result.message.trim()
      ? {
          failureReason: result.message
            .replace(/(?:~|[^\s"'<>]*)[\\/]\.claude[\\/][^\s"'<>]*/gu, "[provider path]")
            .trim()
            .slice(0, 2048),
        }
      : {}),
  };
}

export function computeToolRunStatus(
  itemStatus: OrchestrationV2TurnItem["status"],
  resultStatus: string | undefined,
): NonNullable<ComputeExecutionRecord["result"]>["status"] | null {
  switch (resultStatus) {
    case "running":
    case "queued":
    case "interrupting":
    case "cancelled":
    case "failed":
    case "lost":
    case "succeeded":
      return resultStatus;
    case "starting":
    case "submitting":
      return "submitting";
  }
  if (itemStatus === "failed") return "failed";
  if (itemStatus === "cancelled" || itemStatus === "interrupted") return "cancelled";
  if (itemStatus === "running") return "running";
  if (itemStatus === "waiting" || itemStatus === "pending") return "queued";
  return null;
}
