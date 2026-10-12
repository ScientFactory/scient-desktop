import type { OrchestrationV2SubagentPresentation } from "@t3tools/contracts";
import { isRecord, type OmpRpcEvent } from "effect-omp-rpc/schema";
import { decodeOmpModelSlug, encodeOmpModelSlug } from "./OmpModel.ts";

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const fullText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** A task assignment stays intact; only its display label is flattened and bounded. */
const label = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const clean = value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(^|\n)\s*(?:#{1,6}\s+|[-*>]+\s+|\d+[.)]\s+)/g, " ")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? (clean.length > 120 ? `${clean.slice(0, 119).trimEnd()}…` : clean) : undefined;
};

const modelIdentity = (value: unknown, display = false): string | undefined => {
  const identity = text(value);
  if (!identity) return undefined;
  const decoded = decodeOmpModelSlug(
    display ? identity.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "") : identity,
  );
  return decoded ? encodeOmpModelSlug(decoded.provider, decoded.modelId) : undefined;
};

export interface ScientSubagentObservation {
  readonly title?: string;
  readonly prompt?: string;
  readonly progress?: string;
  readonly result?: string;
  readonly model?: string;
  readonly presentation: OrchestrationV2SubagentPresentation;
}

/** Aggregated Scient RPC observations, not a reconstruction of child transcript events. */
export function parseScientSubagent(
  event: OmpRpcEvent,
  terminal: boolean,
): ScientSubagentObservation {
  const payload = isRecord(event.payload) ? event.payload : {};
  const progress = isRecord(payload.progress) ? payload.progress : {};
  const result = isRecord(payload.result) ? payload.result : {};
  const observed = { ...result, ...progress };
  const prompt =
    fullText(payload.assignment) ??
    fullText(progress.assignment) ??
    fullText(result.assignment) ??
    fullText(payload.task) ??
    fullText(progress.task) ??
    fullText(result.task);
  const role = text(payload.agent) ?? text(observed.agent);
  const title = label(
    text(payload.description) ?? text(observed.description) ?? role ?? text(event.title) ?? prompt,
  );
  const recentTools = Array.isArray(progress.recentTools) ? progress.recentTools : [];
  const lastTool = recentTools.at(-1);
  const lastToolName =
    text(progress.currentTool) ?? (isRecord(lastTool) ? text(lastTool.tool) : undefined);
  const recentOutput = Array.isArray(progress.recentOutput)
    ? progress.recentOutput.filter((line): line is string => typeof line === "string").join("\n")
    : undefined;
  const activity =
    text(progress.currentToolIntent) ??
    text(progress.lastIntent) ??
    text(payload.lastIntent) ??
    text(progress.currentTool) ??
    text(recentOutput);
  const output = terminal
    ? (fullText(payload.error) ??
      fullText(result.error) ??
      (isRecord(progress.retryFailure)
        ? fullText(progress.retryFailure.errorMessage)
        : undefined) ??
      fullText(payload.abortReason) ??
      fullText(result.abortReason) ??
      fullText(payload.output) ??
      fullText(result.output) ??
      fullText(payload.result) ??
      fullText(payload.message))
    : undefined;
  const model =
    modelIdentity(observed.resolvedModelIdentity ?? payload.resolvedModelIdentity) ??
    modelIdentity(observed.resolvedModel ?? payload.resolvedModel, true);
  const usageRecord = isRecord(result.usage) ? result.usage : {};
  // AgentProgress.tokens is cumulative billing volume (input + output + cacheWrite),
  // not contextTokens, which is a latest-turn context gauge and has no matching field here.
  const usage: NonNullable<OrchestrationV2SubagentPresentation["usage"]> = Object.fromEntries(
    [
      ["totalTokens", count(observed.tokens ?? payload.tokens)],
      ["toolUses", count(progress.toolCount ?? payload.toolCount)],
      ["durationMs", count(observed.durationMs ?? payload.durationMs)],
      ["inputTokens", count(usageRecord.input)],
      ["cachedInputTokens", count(usageRecord.cacheRead)],
      ["outputTokens", count(usageRecord.output)],
    ].filter((entry) => entry[1] !== undefined),
  );
  const effort = text(observed.resolvedThinkingLevel ?? payload.resolvedThinkingLevel);
  const index = count(payload.index ?? observed.index);
  return {
    ...(title === undefined ? {} : { title }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(activity === undefined ? {} : { progress: activity }),
    ...(output === undefined ? {} : { result: output }),
    ...(model === undefined ? {} : { model }),
    presentation: {
      kind: "subagent",
      ...(role === undefined ? {} : { role }),
      ...(effort === undefined ? {} : { effort }),
      ...(index === undefined ? {} : { agentIndex: index }),
      ...(lastToolName === undefined ? {} : { lastToolName }),
      ...(Object.keys(usage).length === 0 ? {} : { usage }),
    },
  };
}
