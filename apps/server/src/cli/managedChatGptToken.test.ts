import { expect, it, vi } from "vite-plus/test";

const ipc = vi.hoisted(() => ({ createConnection: vi.fn() }));
vi.mock("node:net", () => ({ createConnection: ipc.createConnection }));

import { runManagedChatGptTokenCli } from "./managedChatGptToken.ts";
import { CODEX_SUBSCRIPTION_SHARING_UNAVAILABLE } from "../scient/providerLifecycle/codexSubscriptionSharingPolicy.ts";

it("refuses subscription sharing before IPC and emits no credential", async () => {
  ipc.createConnection.mockReset();
  using stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  using stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const previousExitCode = process.exitCode;
  try {
    await runManagedChatGptTokenCli([
      "/synthetic/broker.sock",
      "codex",
      "environment",
      "a".repeat(64),
    ]);
    expect(ipc.createConnection).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(`${CODEX_SUBSCRIPTION_SHARING_UNAVAILABLE}\n`);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = previousExitCode;
  }
});
