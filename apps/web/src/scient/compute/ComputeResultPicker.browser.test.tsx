import { render as _fixtureRender, act } from "../../../test/render";
import { AnalysisRunId, EnvironmentId } from "@t3tools/contracts";

import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "../../index.css";

vi.mock("~/components/ui/menu", { spy: true });
import { MenuRadioGroup } from "~/components/ui/menu";

import { ComputeResultPicker } from "./ComputeResultPicker";
import { ComputeContextId, useComputeContextStore } from "./computeContextStore";
import {
  getComputeFilePresentation,
  useComputeFilePresentationStore,
} from "./computeFilePresentationStore";

const owner = ComputeContextId.make("owner");
const fresh = ComputeContextId.make("fresh");
const batch = ComputeContextId.make("batch");
const environmentId = EnvironmentId.make("test");

async function _setupFixture0(_fixture: _Fixture) {
  vi.clearAllMocks();
  _fixture.cleanup.defer(() => {
    vi.mocked(MenuRadioGroup).mockClear();
  });
  useComputeContextStore.setState({ bindings: {} });
  useComputeFilePresentationStore.setState({ presentations: {} });
  useComputeContextStore
    .getState()
    .ensureContext({ contextId: owner, environmentId, cwd: "/project", ownerKey: "file" });
}

it("adds no control when there are no additional results", async () => {
  await using _fixture = _createFixture();
  await _setupFixture0(_fixture);

  await using screen = await _fixtureRender(<ComputeResultPicker contextId={owner} />);
  expect(screen.container.innerHTML).toBe("");
});

it("offers the session feed and MATLAB batch runs; fresh runs stay in the feed", async () => {
  await using _fixture = _createFixture();
  await _setupFixture0(_fixture);

  const store = useComputeContextStore.getState();
  store.ensureContext({
    contextId: fresh,
    parentContextId: owner,
    environmentId,
    cwd: "/project",
    ownerKey: "fresh",
  });
  store.ensureContext({
    contextId: batch,
    parentContextId: owner,
    batchRunId: AnalysisRunId.make("batch-run"),
    environmentId,
    cwd: "/project",
    ownerKey: "batch",
  });
  const before = useComputeContextStore.getState().bindings;
  const container = document.createElement("div");
  const root = _fixture.stack.use(
    await _fixtureRender(null, { container: container, router: false }),
  );
  try {
    await act(async () => await root.rerender(<ComputeResultPicker contextId={owner} />));
    await page.getByRole("button", { name: "Choose results" }).click();
    await expect.element(page.getByRole("menuitemradio", { name: "Batch 1" })).toBeVisible();
    expect(page.getByRole("menuitemradio").elements()).toHaveLength(2);
    await page.getByRole("menuitemradio", { name: "Batch 1" }).click();
    expect(getComputeFilePresentation(owner).resultsContextId).toBe(batch);
    await act(() =>
      vi
        .mocked(MenuRadioGroup)
        .mock.lastCall?.[0].onValueChange?.("unrelated-context", {} as never),
    );
    expect(getComputeFilePresentation(owner).resultsContextId).toBe(batch);
    await page.getByRole("menuitemradio", { name: "Session", exact: true }).click();
    expect(getComputeFilePresentation(owner).resultsContextId).toBeNull();
    expect(useComputeContextStore.getState().bindings).toBe(before);
  } finally {
    await act(async () => await root.unmount());
  }
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
