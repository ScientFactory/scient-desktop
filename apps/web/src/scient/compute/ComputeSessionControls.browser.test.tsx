import { render } from "../../../test/render";
import {
  ComputeSessionGeneration,
  ComputeSessionId,
  EnvironmentId,
  type ComputeSessionRecord,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import {
  ensureComputeContext,
  getComputeContext,
  useComputeContextStore,
  type ComputeContextId,
} from "./computeContextStore";
import { ComputeSessionControls } from "./ComputeSessionControls";

const mocks = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock("~/state/compute", () => ({
  computeEnvironment: {
    interruptSession: "interrupt",
    restartSession: "restart",
    stopSession: "stop",
    session: "session",
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "stop" ? mocks.stop : vi.fn()),
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));

const environmentId = EnvironmentId.make("environment");
const sessionId = ComputeSessionId.make("console-session");
const generation = ComputeSessionGeneration.make(1);
const consoleId = "console" as ComputeContextId;
const scriptId = "script" as ComputeContextId;
const session = {
  sessionId,
  generation,
  status: "ready",
  activity: "idle",
} as unknown as ComputeSessionRecord;

function scriptBorrowingConsole() {
  vi.clearAllMocks();
  useComputeContextStore.setState({ bindings: {} });
  mocks.stop.mockResolvedValue({
    _tag: "Success",
    value: { sessionId, generation, status: "stopped" },
  });
  ensureComputeContext({ contextId: consoleId, environmentId, cwd: "/project" });
  ensureComputeContext({
    contextId: scriptId,
    environmentId,
    cwd: "/project",
    relativePath: "analysis.py",
  });
  const store = useComputeContextStore.getState();
  store.reserveSession({ contextId: consoleId, sessionId, generation });
  store.bindSession({ contextId: consoleId, sessionId, generation });
  store.borrowSession({ contextId: scriptId, sessionId, generation });
}

describe("ComputeSessionControls", () => {
  it("stops the shared session for real when a script on loan asks to", async () => {
    scriptBorrowingConsole();
    const onSettled = vi.fn();
    await using _screen = await render(
      <ComputeSessionControls
        environmentId={environmentId}
        cwd="/project"
        session={session}
        contextId={scriptId}
        binding={getComputeContext(scriptId)}
        onSettled={onSettled}
      />,
    );
    await page.getByRole("button", { name: "Session actions" }).click();
    await page.getByRole("menuitem", { name: "Stop session" }).click();
    await page.getByRole("button", { name: "Stop session" }).click();
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(mocks.stop).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/project", sessionId, expectedGeneration: generation },
    });
    expect(getComputeContext(scriptId)).toMatchObject({ lifecycle: "terminal", sessionId });
  });
});
