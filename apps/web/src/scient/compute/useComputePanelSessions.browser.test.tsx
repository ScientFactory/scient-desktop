import { render } from "../../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComputePanelSessions } from "./useComputePanelSessions";

const mocks = vi.hoisted(() => ({
  stale: false,
  refreshes: { sessions: vi.fn(), events: vi.fn() },
}));
vi.mock("~/state/compute", () => ({
  computeEnvironment: {
    runtimes: () => "runtimes",
    sessions: () => "sessions",
    events: () => "events",
    session: () => "session",
    executions: () => "executions",
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: "sessions" | "events" | "runtimes") => ({
    data:
      query === "events"
        ? { stale: mocks.stale, sessions: new Map(), executions: new Map() }
        : null,
    refresh: mocks.refreshes[query as "sessions" | "events"] ?? vi.fn(),
  }),
}));

function Sessions() {
  const model = useComputePanelSessions({
    environmentId: EnvironmentId.make("environment"),
    cwd: "/project",
    contextId: undefined,
  });
  return (
    <button type="button" onClick={model.refresh}>
      Refresh
    </button>
  );
}

describe("useComputePanelSessions", () => {
  it("keeps the live feed connected when it refreshes", async () => {
    mocks.stale = false;
    vi.clearAllMocks();
    await using screen = await render(<Sessions />);
    await screen.getByRole("button", { name: "Refresh" }).click();
    expect(mocks.refreshes.sessions).toHaveBeenCalledTimes(1);
    expect(mocks.refreshes.events).not.toHaveBeenCalled();
  });

  it("reconnects a feed that has gone stale", async () => {
    mocks.stale = true;
    vi.clearAllMocks();
    await using _screen = await render(<Sessions />);
    await vi.waitFor(() => expect(mocks.refreshes.events).toHaveBeenCalledTimes(1));
  });
});
