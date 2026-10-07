import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { promptResponseState, promptRunStarting } from "./responseFollow";

const prompt = MessageId.make("prompt");
const run = (status: Parameters<typeof promptResponseState>[0]["runs"][number]["status"]) => ({
  id: RunId.make("run-2"),
  userMessageId: prompt,
  status,
});

describe("promptResponseState", () => {
  it("follows the prompt's own run from admission to its end", () => {
    const listed = [{ id: prompt, runId: null }];
    // Sent, not admitted yet: the prompt is listed (optimistically), no run.
    expect(promptResponseState({ promptId: prompt, runs: [], messages: listed })).toBe("awaiting");
    for (const status of ["queued", "preparing", "starting"] as const)
      expect(promptResponseState({ promptId: prompt, runs: [run(status)], messages: listed })).toBe(
        "awaiting",
      );
    for (const status of ["running", "waiting"] as const)
      expect(promptResponseState({ promptId: prompt, runs: [run(status)], messages: listed })).toBe(
        "running",
      );
    for (const status of ["completed", "failed", "interrupted", "cancelled"] as const)
      expect(promptResponseState({ promptId: prompt, runs: [run(status)], messages: listed })).toBe(
        "settled",
      );
  });

  it("follows a steer through the run it steered", () => {
    const steered = {
      id: RunId.make("run-1"),
      userMessageId: MessageId.make("p1"),
      status: "running" as const,
    };
    const messages = [{ id: prompt, runId: steered.id }];
    expect(promptResponseState({ promptId: prompt, runs: [steered], messages })).toBe("running");
    expect(
      promptResponseState({
        promptId: prompt,
        runs: [{ ...steered, status: "completed" }],
        messages,
      }),
    ).toBe("settled");
  });

  it("reports a prompt that left without a run (its send failed) as missing", () => {
    expect(promptResponseState({ promptId: prompt, runs: [], messages: [] })).toBe("missing");
  });
});

describe("promptRunStarting", () => {
  it("is only the admitted run preparing or starting, never a held queue", () => {
    const messages = [{ id: prompt, runId: null }];
    expect(promptRunStarting({ promptId: prompt, runs: [run("starting")], messages })).toBe(true);
    expect(promptRunStarting({ promptId: prompt, runs: [run("preparing")], messages })).toBe(true);
    expect(promptRunStarting({ promptId: prompt, runs: [run("queued")], messages })).toBe(false);
    expect(promptRunStarting({ promptId: prompt, runs: [run("running")], messages })).toBe(false);
    expect(promptRunStarting({ promptId: null, runs: [run("starting")], messages })).toBe(false);
  });
});
