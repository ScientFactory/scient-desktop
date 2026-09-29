import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/session", () => ({ readPreparedConnection: () => null }));
vi.mock("../../lib/runtime", () => ({ runtime: { runPromise: vi.fn() } }));

const { exportConversation, prepareConversationExport } = await import("./client");

describe("conversation export client", () => {
  it("rejects instead of throwing when the environment is disconnected", async () => {
    const environmentId = EnvironmentId.make("remote");
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = prepareConversationExport(environmentId, ThreadId.make("thread-1"));
    }).not.toThrow();
    await expect(pending).rejects.toThrow("The conversation's environment is not connected.");
    await expect(
      exportConversation(environmentId, {
        threadId: ThreadId.make("thread-1"),
        format: "markdown",
        delivery: "file",
        options: { includeWorkLog: false, includeReasoning: false, range: { _tag: "whole" } },
      }),
    ).rejects.toThrow("not connected");
  });
});
