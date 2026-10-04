import type { ProviderReplayTranscript } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { materializeCodexOwnerReload } from "./CodexReplayOwnerReload.ts";

const transcript = {
  provider: "codex",
  protocol: "codex-app-server.jsonrpc",
  version: "captured",
  scenario: "owner-reload",
  entries: [
    { type: "expect_outbound", frame: { id: 1, method: "initialize", params: {} } },
    { type: "emit_inbound", frame: { id: 1, result: {} } },
    {
      type: "expect_outbound",
      frame: {
        id: 2,
        method: "thread/start",
        params: {
          model: "selected-model",
          cwd: "<workspace>",
          config: { "tools.update_plan.enabled": true },
        },
      },
    },
    {
      type: "emit_inbound",
      frame: {
        id: 2,
        result: {
          thread: { id: "owned-native", updatedAt: 1, turns: [] },
          model: "selected-model",
        },
      },
    },
    {
      type: "expect_outbound",
      frame: {
        id: 3,
        method: "turn/start",
        params: { threadId: "owned-native", input: [{ type: "text", text: "First" }] },
      },
    },
    { type: "emit_inbound", frame: { id: 3, result: { turn: { id: "first-native-turn" } } } },
    {
      type: "emit_inbound",
      frame: {
        method: "turn/completed",
        params: { threadId: "owned-native", turn: { id: "first-native-turn" } },
      },
    },
    {
      type: "expect_outbound",
      frame: {
        id: 4,
        method: "turn/start",
        params: {
          threadId: "owned-native",
          input: [{ type: "text", text: "Second" }],
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      },
    },
    { type: "emit_inbound", frame: { id: 4, result: { turn: { id: "second-native-turn" } } } },
    {
      type: "emit_inbound",
      frame: {
        id: 5,
        method: "item/commandExecution/requestApproval",
        params: { itemId: "approval" },
      },
    },
    { type: "expect_outbound", frame: { id: 5, result: { decision: "accept" } } },
    { type: "expect_outbound", frame: { id: 1, method: "initialize", params: {} } },
    { type: "emit_inbound", frame: { id: 1, result: {} } },
  ],
} satisfies ProviderReplayTranscript;

it("adds one declared reload using captured native identity and policy, preserving prompt/event payloads", () => {
  const original = structuredClone(transcript);
  const capturedRequest = transcript.entries[7];
  const capturedResponse = transcript.entries[8];
  if (capturedRequest === undefined || capturedResponse === undefined)
    throw new Error("Missing captured second turn fixture.");
  const result = materializeCodexOwnerReload(transcript, 2);
  expect(result.entries).toHaveLength(transcript.entries.length + 2);
  expect(result.entries[7]).toEqual({
    type: "expect_outbound",
    label: "canonical-owner.thread/resume",
    frame: {
      id: 4,
      method: "thread/resume",
      params: {
        model: "selected-model",
        cwd: "<workspace>",
        config: { "tools.update_plan.enabled": true },
        threadId: "owned-native",
        excludeTurns: true,
      },
    },
  });
  expect(result.entries[8]).toEqual({
    type: "emit_inbound",
    label: "canonical-owner.thread/resume:response",
    frame: {
      id: 4,
      result: { thread: { id: "owned-native", updatedAt: 1, turns: [] }, model: "selected-model" },
    },
  });
  expect(result.entries[9]).toEqual({
    ...capturedRequest,
    frame: { ...capturedRequest.frame, id: 5 },
  });
  expect(result.entries[10]).toEqual({
    ...capturedResponse,
    frame: { ...capturedResponse.frame, id: 5 },
  });
  expect(result.entries[6]).toBe(transcript.entries[6]);
  expect(transcript).toEqual(original);
});

it("preserves server request/response correlations and resets the client counter after a recorded restart", () => {
  const result = materializeCodexOwnerReload(transcript, 2);
  expect(result.entries[11]).toBe(transcript.entries[9]);
  expect(result.entries[12]).toBe(transcript.entries[10]);
  expect(result.entries[13]).toBe(transcript.entries[11]);
  expect(result.entries[14]).toBe(transcript.entries[12]);
});

it("refuses a declared reload without recorded native ownership or an existing target turn", () => {
  expect(() => materializeCodexOwnerReload(transcript, 3)).toThrow("no recorded native turn");
  expect(() =>
    materializeCodexOwnerReload(
      { ...transcript, entries: transcript.entries.filter((_, index) => index !== 3) },
      2,
    ),
  ).toThrow("no owned native thread metadata");
});

it("reloads a recorded clone before history injection without replaying its fork boundary", () => {
  const clone = {
    ...transcript,
    entries: [
      ...transcript.entries.slice(0, 7),
      {
        type: "expect_outbound",
        frame: {
          id: 4,
          method: "thread/fork",
          params: {
            threadId: "owned-native",
            lastTurnId: "first-native-turn",
            model: "selected-model",
            cwd: "<workspace>",
            config: { "tools.update_plan.enabled": true },
          },
        },
      },
      {
        type: "emit_inbound",
        frame: { id: 4, result: { thread: { id: "owned-clone", updatedAt: 2, turns: [] } } },
      },
      {
        type: "expect_outbound",
        label: "rejected-turn-history",
        frame: {
          id: 5,
          method: "thread/inject_items",
          params: { threadId: "owned-clone", items: [{ type: "text", text: "Rejected turn" }] },
        },
      },
      { type: "emit_inbound", frame: { id: 5, result: {} } },
      {
        type: "expect_outbound",
        frame: {
          id: 6,
          method: "turn/start",
          params: { threadId: "owned-clone", input: [{ type: "text", text: "Retry" }] },
        },
      },
      { type: "emit_inbound", frame: { id: 6, result: { turn: { id: "retry-turn" } } } },
    ],
  } satisfies ProviderReplayTranscript;
  const original = structuredClone(clone);
  const result = materializeCodexOwnerReload(clone, 2, {
    beforeEntryLabel: "rejected-turn-history",
  });
  expect(result.entries[9]).toEqual({
    type: "expect_outbound",
    label: "canonical-owner.thread/resume",
    frame: {
      id: 5,
      method: "thread/resume",
      params: {
        threadId: "owned-clone",
        excludeTurns: true,
        model: "selected-model",
        cwd: "<workspace>",
        config: { "tools.update_plan.enabled": true },
      },
    },
  });
  expect(result.entries[11]).toEqual({
    ...clone.entries[9],
    frame: { ...clone.entries[9]?.frame, id: 6 },
  });
  expect(result.entries[13]).toEqual({
    ...clone.entries[11],
    frame: { ...clone.entries[11]?.frame, id: 7 },
  });
  expect(clone).toEqual(original);
});

it("refuses a declared pre-turn boundary outside the owned creation and turn", () => {
  expect(() =>
    materializeCodexOwnerReload(transcript, 2, {
      beforeEntryLabel: "missing-history-boundary",
    }),
  ).toThrow("no recorded insertion boundary");
});
