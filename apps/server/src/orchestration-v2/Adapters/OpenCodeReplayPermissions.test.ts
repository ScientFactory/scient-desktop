import type { ProviderReplayTranscript } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { materializeOpenCodeReplayPermissions } from "./OpenCodeAdapterV2.testkit.ts";

const transcript = {
  provider: "opencode",
  protocol: "opencode-sdk.sse",
  version: "1.14.39",
  scenario: "permission-materialization",
  entries: [
    {
      type: "emit_inbound",
      label: "created",
      frame: {
        type: "sdk.response",
        operation: "session.create",
        data: { id: "recorded-session", title: "Captured session" },
      },
    },
    {
      type: "expect_outbound",
      label: "prompt",
      frame: {
        type: "session.promptAsync",
        input: {
          sessionID: "recorded-session",
          parts: [{ type: "text", text: "Captured prompt" }],
        },
      },
    },
    { type: "emit_inbound", label: "captured-event", frame: { type: "sdk.event", event: {} } },
  ],
} satisfies ProviderReplayTranscript;

it("adds exact declared full-access confirmation without modifying captured prompt or native events", () => {
  const result = materializeOpenCodeReplayPermissions(transcript, {
    cwd: "/synthetic-workspace",
    runtimeMode: "full-access",
    interactionMode: "default",
  });
  expect(result.entries).toHaveLength(7);
  expect(result.entries[1]).toMatchObject({
    type: "expect_outbound",
    frame: {
      type: "session.update",
      input: {
        sessionID: "recorded-session",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      },
    },
  });
  expect(result.entries[4]).toMatchObject({
    type: "emit_inbound",
    frame: {
      operation: "session.get",
      data: {
        id: "recorded-session",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      },
    },
  });
  expect(result.entries[5]).toBe(transcript.entries[1]);
  expect(result.entries[6]).toBe(transcript.entries[2]);
  expect(transcript.entries).toHaveLength(3);
});

it("uses the explicit captured supervised policy instead of recorded create defaults", () => {
  const result = materializeOpenCodeReplayPermissions(transcript, {
    cwd: "/synthetic-workspace",
    runtimeMode: "approval-required",
    interactionMode: "default",
  });
  expect(result.entries[1]).toMatchObject({
    frame: {
      input: {
        permission: expect.arrayContaining([{ permission: "*", pattern: "*", action: "ask" }]),
      },
    },
  });
  expect(result.entries[1]).not.toMatchObject({
    frame: { input: { permission: [{ permission: "*", pattern: "*", action: "allow" }] } },
  });
});

it("refuses to invent session ownership for an orphan recorded prompt", () => {
  const capturedPrompt = transcript.entries[1];
  if (capturedPrompt === undefined) throw new Error("Missing captured prompt fixture.");
  expect(() =>
    materializeOpenCodeReplayPermissions(
      { ...transcript, entries: [capturedPrompt] },
      {
        cwd: "/synthetic-workspace",
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    ),
  ).toThrow("no owned session metadata");
});
