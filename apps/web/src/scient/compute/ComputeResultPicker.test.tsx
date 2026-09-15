// @vitest-environment happy-dom
import { AnalysisRunId, EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const menu = vi.hoisted(() => ({ select: (_value: string) => {} }));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  MenuPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuRadioGroup: ({
    children,
    onValueChange,
  }: {
    children: ReactNode;
    onValueChange: (value: string) => void;
  }) => {
    menu.select = onValueChange;
    return <>{children}</>;
  },
  MenuRadioItem: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

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

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useComputeContextStore.setState({ bindings: {} });
  useComputeFilePresentationStore.setState({ presentations: {} });
  useComputeContextStore
    .getState()
    .ensureContext({ contextId: owner, environmentId, cwd: "/project", ownerKey: "file" });
});

it("adds no control when there are no additional results", () => {
  expect(renderToStaticMarkup(<ComputeResultPicker contextId={owner} />)).toBe("");
});

it("selects only this tab's retained results without mutating execution ownership", async () => {
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
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ComputeResultPicker contextId={owner} />));
    expect(container.textContent).toContain("Fresh run 1");
    expect(container.textContent).toContain("MATLAB batch 1");
    await act(async () => menu.select(fresh));
    expect(getComputeFilePresentation(owner).resultsContextId).toBe(fresh);
    await act(async () => menu.select(batch));
    expect(getComputeFilePresentation(owner).resultsContextId).toBe(batch);
    await act(async () => menu.select("unrelated-context"));
    expect(getComputeFilePresentation(owner).resultsContextId).toBe(batch);
    await act(async () => menu.select(owner));
    expect(getComputeFilePresentation(owner).resultsContextId).toBeNull();
    expect(useComputeContextStore.getState().bindings).toBe(before);
  } finally {
    await act(async () => root.unmount());
  }
});
