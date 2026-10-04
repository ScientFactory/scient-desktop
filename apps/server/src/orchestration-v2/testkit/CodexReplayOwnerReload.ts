import type { ProviderReplayEntry, ProviderReplayTranscript } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

/**
 * These older recordings predate the canonical app-owned provider-thread cache key.
 * Declare the reload point from fixture intent; never derive expectations from outbound traffic.
 */
export function materializeCodexOwnerReload(
  transcript: ProviderReplayTranscript,
  beforeTurnStartOrdinal: number,
  options?: { readonly beforeEntryLabel: string },
): ProviderReplayTranscript {
  let turnOrdinal = 0;
  const targetIndex = transcript.entries.findIndex((entry) => {
    if (
      entry.type !== "expect_outbound" ||
      !Predicate.isObject(entry.frame) ||
      entry.frame.method !== "turn/start"
    )
      return false;
    turnOrdinal += 1;
    return turnOrdinal === beforeTurnStartOrdinal;
  });
  const target = transcript.entries[targetIndex];
  if (
    target?.type !== "expect_outbound" ||
    !Predicate.isObject(target.frame) ||
    !Predicate.isObject(target.frame.params) ||
    typeof target.frame.id !== "number" ||
    typeof target.frame.params.threadId !== "string"
  )
    throw new Error("Declared Codex owner reload has no recorded native turn.");
  const nativeThreadId = target.frame.params.threadId;
  const responseIndex = transcript.entries.findIndex(
    (entry, index) =>
      index < targetIndex &&
      entry.type === "emit_inbound" &&
      Predicate.isObject(entry.frame) &&
      Predicate.isObject(entry.frame.result) &&
      Predicate.isObject(entry.frame.result.thread) &&
      entry.frame.result.thread.id === nativeThreadId,
  );
  const response = transcript.entries[responseIndex];
  if (
    response?.type !== "emit_inbound" ||
    !Predicate.isObject(response.frame) ||
    !Predicate.isObject(response.frame.result)
  )
    throw new Error("Declared Codex owner reload has no owned native thread metadata.");
  const responseFrame = response.frame;
  const start = transcript.entries.find(
    (entry, index) =>
      index < responseIndex &&
      entry.type === "expect_outbound" &&
      Predicate.isObject(entry.frame) &&
      (entry.frame.method === "thread/start" || entry.frame.method === "thread/fork") &&
      entry.frame.id === responseFrame.id,
  );
  if (
    start?.type !== "expect_outbound" ||
    !Predicate.isObject(start.frame) ||
    !Predicate.isObject(start.frame.params)
  )
    throw new Error("Declared Codex owner reload has no recorded creation policy.");
  const insertionIndex =
    options === undefined
      ? targetIndex
      : transcript.entries.findIndex(
          (entry, index) =>
            index > responseIndex &&
            index <= targetIndex &&
            entry.type === "expect_outbound" &&
            entry.label === options.beforeEntryLabel,
        );
  const insertion = transcript.entries[insertionIndex];
  if (
    insertion?.type !== "expect_outbound" ||
    !Predicate.isObject(insertion.frame) ||
    typeof insertion.frame.id !== "number"
  )
    throw new Error("Declared Codex owner reload has no recorded insertion boundary.");
  // Fork-only boundary fields are authority for the clone, never resume parameters.
  const runtimeParams = { ...start.frame.params };
  delete runtimeParams.lastTurnId;
  delete runtimeParams.threadId;
  const entries: ProviderReplayEntry[] = [];
  let requestOffset = 0;
  const requestIds = new Map<number, number>();
  for (const [index, entry] of transcript.entries.entries()) {
    if (index === insertionIndex) {
      entries.push(
        {
          type: "expect_outbound",
          label: "canonical-owner.thread/resume",
          frame: {
            id: insertion.frame.id,
            method: "thread/resume",
            params: {
              ...runtimeParams,
              threadId: nativeThreadId,
              excludeTurns: true,
            },
          },
        },
        {
          type: "emit_inbound",
          label: "canonical-owner.thread/resume:response",
          frame: {
            id: insertion.frame.id,
            result: { ...response.frame.result },
          },
        },
      );
      requestOffset = 1;
    }
    if (
      (entry.type === "expect_outbound" || entry.type === "emit_inbound") &&
      Predicate.isObject(entry.frame)
    ) {
      const frame = entry.frame;
      if (entry.type === "expect_outbound" && frame.method === "initialize") {
        // A recorded process restart resets its request counter and its load ownership.
        requestOffset = 0;
        requestIds.clear();
      }
      if (
        entry.type === "expect_outbound" &&
        typeof frame.method === "string" &&
        typeof frame.id === "number"
      ) {
        const id = frame.id + requestOffset;
        requestIds.set(frame.id, id);
        entries.push(id === frame.id ? entry : { ...entry, frame: { ...frame, id } });
        continue;
      }
      if (
        entry.type === "emit_inbound" &&
        frame.method === undefined &&
        typeof frame.id === "number"
      ) {
        const id = requestIds.get(frame.id) ?? frame.id;
        entries.push(id === frame.id ? entry : { ...entry, frame: { ...frame, id } });
        continue;
      }
    }
    entries.push(entry);
  }
  return {
    ...transcript,
    entries,
    metadata: {
      ...transcript.metadata,
      canonicalOwnerReload: {
        beforeTurnStartOrdinal,
        ...(options === undefined ? {} : { beforeEntryLabel: options.beforeEntryLabel }),
        boundary:
          "synthetic recorded-policy reload; native payloads preserved; client request correlations translated",
      },
    },
  };
}
