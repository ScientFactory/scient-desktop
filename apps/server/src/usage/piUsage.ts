// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

import type { PiUsageRow, UsageDay, UsageTokenTotals } from "@t3tools/contracts";

import { addTotals, EMPTY_TOTALS } from "./usageTranscripts.ts";
import { listTranscriptFiles } from "./usageTranscriptReader.ts";

interface Context {
  readonly connectionId: string;
}

interface MutableRow {
  totals: UsageTokenTotals;
  estimatedCostUsd: number;
  records: number;
  sessions: Set<string>;
  generations: Set<string>;
}

function finiteInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function dayFormatter(timeZone: string): (timestamp: string) => string | null {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  return (timestamp) => {
    const ms = Date.parse(timestamp);
    return Number.isNaN(ms) ? null : formatter.format(new Date(ms));
  };
}

/**
 * Stateful, single-pass pi JSONL reducer. pi writes parents before children,
 * so each entry inherits the nearest branch-local `model_change` without a
 * forward-state bug when users switch branches in one session tree.
 */
export function makePiUsageReducer(input: {
  readonly timeZone: string;
  readonly sinceDay: string;
  readonly untilDay: string;
}) {
  const contexts = new Map<string, Context | null>();
  const seenResponses = new Set<string>();
  const rows = new Map<string, MutableRow>();
  const toDay = dayFormatter(input.timeZone);
  let sessionId = "unknown";

  const addLine = (line: string): void => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const entry = value as Record<string, unknown>;
    if (entry["type"] === "session") {
      if (typeof entry["id"] === "string" && entry["id"].length > 0) sessionId = entry["id"];
      return;
    }

    const id = typeof entry["id"] === "string" ? entry["id"] : "";
    const parentId = typeof entry["parentId"] === "string" ? entry["parentId"] : "";
    const inherited = parentId.length > 0 ? (contexts.get(parentId) ?? null) : null;
    let context = inherited;
    if (entry["type"] === "model_change" && typeof entry["provider"] === "string") {
      const provider = entry["provider"];
      context = provider.startsWith("scient_")
        ? { connectionId: provider.slice("scient_".length) }
        : inherited;
    }
    if (id.length > 0) contexts.set(id, context);
    if (entry["type"] !== "message" || context === null) return;

    const messageValue = entry["message"];
    if (typeof messageValue !== "object" || messageValue === null) return;
    const message = messageValue as Record<string, unknown>;
    if (message["role"] !== "assistant") return;
    const usageValue = message["usage"];
    if (typeof usageValue !== "object" || usageValue === null) return;
    const usage = usageValue as Record<string, unknown>;
    const timestamp =
      typeof entry["timestamp"] === "string"
        ? entry["timestamp"]
        : typeof message["timestamp"] === "string"
          ? message["timestamp"]
          : "";
    const day = toDay(timestamp);
    if (day === null || day < input.sinceDay || day > input.untilDay) return;
    const model = typeof message["model"] === "string" ? message["model"] : "";
    const provider = typeof message["provider"] === "string" ? message["provider"] : "";
    if (model.length === 0 || provider.length === 0) return;
    const responseId = typeof message["responseId"] === "string" ? message["responseId"] : "";
    const dedupeKey =
      responseId.length > 0 ? responseId : id.length > 0 ? `${sessionId}\0${id}` : "";
    if (dedupeKey.length > 0 && seenResponses.has(dedupeKey)) return;
    if (dedupeKey.length > 0) seenResponses.add(dedupeKey);

    const costValue = usage["cost"];
    const cost =
      typeof costValue === "object" && costValue !== null
        ? finiteNumber((costValue as Record<string, unknown>)["total"])
        : 0;
    const totals: UsageTokenTotals = {
      uncachedInputTokens: finiteInt(usage["input"]),
      cachedInputTokens: finiteInt(usage["cacheRead"]),
      cacheCreationTokens: finiteInt(usage["cacheWrite"]),
      outputTokens: finiteInt(usage["output"]),
      reasoningTokens: Math.min(finiteInt(usage["output"]), finiteInt(usage["reasoning"])),
    };
    const key = `${day}\0${context.connectionId}\0${provider}\0${model}`;
    const row = rows.get(key) ?? {
      totals: EMPTY_TOTALS,
      estimatedCostUsd: 0,
      records: 0,
      sessions: new Set<string>(),
      generations: new Set<string>(),
    };
    row.totals = addTotals(row.totals, totals);
    row.estimatedCostUsd += cost;
    row.records += 1;
    row.sessions.add(sessionId);
    if (responseId.length > 0) row.generations.add(responseId);
    rows.set(key, row);
  };

  const finish = (): readonly PiUsageRow[] =>
    [...rows]
      .map(([key, row]) => {
        const [day = "", connectionId = "", provider = "", model = ""] = key.split("\0");
        return {
          day: day as UsageDay,
          connectionId,
          provider,
          model,
          totals: row.totals,
          estimatedCostUsd: row.estimatedCostUsd,
          records: row.records,
          sessions: row.sessions.size,
          generations: row.generations.size,
        };
      })
      .toSorted(
        (a, b) =>
          a.day.localeCompare(b.day) ||
          a.connectionId.localeCompare(b.connectionId) ||
          a.model.localeCompare(b.model),
      );

  return { addLine, finish };
}

export async function scanPiUsage(input: {
  readonly root: string;
  readonly sinceMs: number;
  readonly timeZone: string;
  readonly sinceDay: string;
  readonly untilDay: string;
}): Promise<readonly PiUsageRow[]> {
  const reducer = makePiUsageReducer(input);
  const files = await listTranscriptFiles(input.root, input.sinceMs);
  for (const file of files) {
    await new Promise<void>((resolve) => {
      const stream = NodeFS.createReadStream(file.path, { encoding: "utf8" });
      stream.once("error", () => resolve());
      const lines = NodeReadline.createInterface({ input: stream, crlfDelay: Infinity });
      lines.on("line", reducer.addLine);
      lines.once("close", resolve);
    });
  }
  return reducer.finish();
}
