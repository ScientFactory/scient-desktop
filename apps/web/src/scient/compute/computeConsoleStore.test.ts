import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  ComputeSessionGeneration,
  ComputeSessionId,
  EnvironmentId,
  type ComputeSessionRecord,
} from "@t3tools/contracts";

import { computeConsoleIsEmpty, useComputeConsoleStore } from "./computeConsoleStore";
import { stopComputeContext } from "./computeContextCoordinator";
import {
  computeConsoleSession,
  ensureComputeContext,
  getComputeContext,
  useComputeContextStore,
  type ComputeContextId,
} from "./computeContextStore";

const environmentId = EnvironmentId.make("environment");
const cwd = "/project";
const sessionId = ComputeSessionId.make("console-session");
const generation = ComputeSessionGeneration.make(1);
const consoleId = "console" as ComputeContextId;
const scriptId = "script" as ComputeContextId;

const session = (status: "ready" | "stopped" = "ready") =>
  ({ sessionId, generation, status, languageId: "python" }) as unknown as Pick<
    ComputeSessionRecord,
    "sessionId" | "generation" | "status" | "languageId"
  >;

const liveConsole = () => {
  ensureComputeContext({ contextId: consoleId, environmentId, cwd });
  const store = useComputeContextStore.getState();
  store.reserveSession({ contextId: consoleId, sessionId, generation });
  store.bindSession({ contextId: consoleId, sessionId, generation });
};

describe("Console", () => {
  beforeEach(() => {
    useComputeContextStore.setState({ bindings: {} });
    useComputeConsoleStore.setState({ drafts: {}, languages: {}, runtimes: {} });
  });

  it("is empty until something ran or something is typed", () => {
    ensureComputeContext({ contextId: consoleId, environmentId, cwd });
    expect(computeConsoleIsEmpty(consoleId)).toBe(true);
    useComputeConsoleStore.getState().setDraft(consoleId, "   ");
    expect(computeConsoleIsEmpty(consoleId)).toBe(true);
    useComputeConsoleStore.getState().setDraft(consoleId, "half typed");
    expect(computeConsoleIsEmpty(consoleId)).toBe(false);
    useComputeConsoleStore.getState().setDraft(consoleId, "");
    liveConsole();
    expect(computeConsoleIsEmpty(consoleId)).toBe(false);
  });

  it("remembers the picked runtime until the tab closes", () => {
    useComputeConsoleStore.getState().chooseRuntime(consoleId, "r:/bin/R");
    expect(useComputeConsoleStore.getState().runtimes[consoleId]).toBe("r:/bin/R");
    useComputeConsoleStore.getState().forget(consoleId);
    expect(useComputeConsoleStore.getState().runtimes[consoleId]).toBeUndefined();
  });

  it("is found for scripts of its language only, in the same project", () => {
    liveConsole();
    const find = (languageId: string, sessions = [session()], where = cwd) =>
      computeConsoleSession({ environmentId, cwd: where, languageId, sessions });
    expect(find("python")?.sessionId).toBe(sessionId);
    expect(find("r")).toBeNull();
    expect(find("python", [session("stopped")])).toBeNull();
    expect(find("python", [session()], "/another")).toBeNull();
  });

  it("does not offer a script's own session as a Console", () => {
    ensureComputeContext({
      contextId: scriptId,
      environmentId,
      cwd,
      relativePath: "analysis.py",
    });
    const store = useComputeContextStore.getState();
    store.reserveSession({ contextId: scriptId, sessionId, generation });
    store.bindSession({ contextId: scriptId, sessionId, generation });
    expect(
      computeConsoleSession({ environmentId, cwd, languageId: "python", sessions: [session()] }),
    ).toBeNull();
  });

  it("lets a script borrow the session, and closing it leaves the Console running", async () => {
    liveConsole();
    ensureComputeContext({
      contextId: scriptId,
      environmentId,
      cwd,
      relativePath: "analysis.py",
    });
    expect(
      useComputeContextStore
        .getState()
        .borrowSession({ contextId: scriptId, sessionId, generation }),
    ).toBe(true);
    expect(getComputeContext(scriptId)).toMatchObject({
      lifecycle: "live",
      sessionId,
      borrowed: true,
    });
    const stops: unknown[] = [];
    const result = await stopComputeContext({
      contextId: scriptId,
      stopSession: async (input: unknown) => {
        stops.push(input);
        throw new Error("A borrowed session is not this tab's to stop.");
      },
      getSession: async () => {
        throw new Error("unused");
      },
    } as unknown as Parameters<typeof stopComputeContext>[0]);
    expect(result.closed).toBe(true);
    expect(stops).toEqual([]);
    expect(getComputeContext(scriptId)).toMatchObject({ lifecycle: "unbound", sessionId: null });
    expect(getComputeContext(consoleId)).toMatchObject({ lifecycle: "live", sessionId });
  });

  it("will not borrow into a tab with a session of its own", () => {
    liveConsole();
    expect(
      useComputeContextStore
        .getState()
        .borrowSession({ contextId: consoleId, sessionId, generation }),
    ).toBe(false);
  });
});
