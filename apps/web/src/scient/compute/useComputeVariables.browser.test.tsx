import { render } from "../../../test/render";
import { EnvironmentId, type ComputeExecutionRecord } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ComputePanelSessions } from "./useComputePanelSessions";
import { useComputeVariables } from "./useComputeVariables";

const mocks = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.inspect }));

const environmentId = EnvironmentId.make("environment");

/** A Console whose live feed never saw its run end; only history knows. */
const model = (executions: ReadonlyArray<unknown>) =>
  ({
    liveSession: {
      sessionId: "session",
      generation: 1,
      languageId: "python",
      status: "ready",
      activity: "idle",
    },
    selectedIsLive: true,
    executions,
    events: { data: { executions: new Map() } },
    runtimes: {
      data: {
        languages: [{ descriptor: { languageId: "python", capabilities: ["variables"] } }],
      },
    },
  }) as unknown as ComputePanelSessions;

const finished = (executionId: string) =>
  ({
    request: { executionId, submittedAt: "2026-10-30T10:00:00.000Z" },
    result: { status: "succeeded", finishedAt: "2026-10-30T10:00:01.000Z" },
  }) as unknown as ComputeExecutionRecord;

function Reader(props: { readonly model: ComputePanelSessions }) {
  const variables = useComputeVariables({
    environmentId,
    cwd: "/project",
    visible: true,
    model: props.model,
  });
  return <p>{variables.snapshot?.variables.length ?? "none"}</p>;
}

describe("useComputeVariables", () => {
  it("reads again when a run finishes, even if the live feed missed it", async () => {
    mocks.inspect.mockResolvedValueOnce({
      _tag: "Success",
      value: { generation: 1, variables: [], truncated: false },
    });
    mocks.inspect.mockResolvedValueOnce({
      _tag: "Success",
      value: { generation: 1, variables: [{ name: "x" }], truncated: false },
    });
    await using screen = await render(<Reader model={model([])} />);
    await vi.waitFor(() => expect(mocks.inspect).toHaveBeenCalledTimes(1));
    await screen.rerender(<Reader model={model([finished("first-run")])} />);
    await vi.waitFor(() => expect(mocks.inspect).toHaveBeenCalledTimes(2));
    await expect.element(screen.getByText("1")).toBeInTheDocument();
  });
});
