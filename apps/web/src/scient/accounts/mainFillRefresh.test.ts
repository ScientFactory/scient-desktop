import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { importIntoMain } from "./mainFill";

const environmentId = EnvironmentId.make("environment-fixture");
const state = vi.hoisted(() => ({ commands: [] as string[] }));
vi.mock("~/state/environments", () => ({ readPrimaryEnvironmentId: () => "environment-fixture" }));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: async (_registry: unknown, command: string) => {
    state.commands.push(command);
    return command === "read"
      ? { _tag: "Success", value: { accounts: [], profiles: [] } }
      : { _tag: "Success", value: undefined };
  },
}));
vi.mock("./accountsState", () => ({
  accountsState: { readSnapshot: "read", profileResend: "resend" },
}));

it("sends an agent's refresh of Main on only after its check, the person's import at once (6j)", async () => {
  vi.stubGlobal("window", {
    desktopBridge: {
      accounts: {
        fillMain: async () => ({ units: [{ sites: ["github.com"], outcome: "copied" }] }),
      },
    },
  });
  await importIntoMain(environmentId, "chrome", "Default", { operationId: "op-main" });
  // regression: the refresh's import went to other computers before it was checked again.
  expect(state.commands).toEqual(["read"]);
  state.commands = [];
  await importIntoMain(environmentId, "chrome", "Default");
  expect(state.commands).toEqual(["read", "resend"]);
});
