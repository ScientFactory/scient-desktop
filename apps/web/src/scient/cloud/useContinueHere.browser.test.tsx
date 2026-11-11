import type { ThreadIndexRow } from "@scientfactory/scient-cloud/api";
import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import type { CloudApi } from "./cloudApi";
import { useContinueHere } from "./useContinueHere";

const state = vi.hoisted(() => ({
  takeOver: vi.fn(),
}));

vi.mock("./serverCloud", () => ({
  readCloudStatus: async () => ({ enrolledUserId: "user_1", enabled: true }),
  takeOverCloudThread: (...args: Array<unknown>) => state.takeOver(...args),
  turnOnCloudCopy: async () => {},
}));
vi.mock("../conversationImport/importDestination.logic", () => ({
  newChatModelSelection: () => ({ instanceId: "codex", model: "gpt-5" }),
}));
vi.mock("~/state/entities", () => ({
  useProjects: () => [],
  useServerConfigs: () => new Map([["env-b", { settings: {} }]]),
}));
vi.mock("~/state/environments", () => ({ useEnvironmentProviders: () => new Map() }));
vi.mock("~/hooks/useSettings", () => ({
  mergeEnvironmentSettings: () => ({}),
  useClientSettings: () => ({}),
}));

function setup() {
  state.takeOver.mockReset();
}

const row = {
  environmentId: "env-a",
  threadId: "thread-a",
  projectKey: "github.com/acme/lab",
} as ThreadIndexRow;
const api = { lease: async () => ({ generation: 2 }) } as unknown as CloudApi;

// The hook navigates nowhere itself, so these renders need no router.
function Continue() {
  const continueHere = useContinueHere({ api, userId: "user_1" });
  return (
    <>
      <button type="button" onClick={() => void continueHere.run(row, "env-b")}>
        Continue
      </button>
      {continueHere.chooser}
    </>
  );
}

describe("useContinueHere", () => {
  it("releases the conversation when a project choice arrives after the page closed", async () => {
    setup();
    let answer: (value: unknown) => void = () => {};
    state.takeOver.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    {
      await using screen = await render(<Continue />, { router: false });
      await screen.getByRole("button", { name: "Continue" }).click();
      await vi.waitFor(() => expect(state.takeOver).toHaveBeenCalledTimes(1));
    }
    answer({
      _tag: "choose-project",
      candidates: [{ projectId: ProjectId.make("project-lab"), title: "Lab" }],
    });

    // Returning to the conversation can continue it again once the late answer has settled.
    state.takeOver.mockResolvedValue({ _tag: "imported", threadId: "thread-b" });
    await using screen = await render(<Continue />, { router: false });
    await vi.waitFor(async () => {
      await screen.getByRole("button", { name: "Continue" }).click();
      expect(state.takeOver.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
