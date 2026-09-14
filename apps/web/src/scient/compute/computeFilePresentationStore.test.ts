import { beforeEach, describe, expect, it } from "vite-plus/test";

import { ComputeContextId } from "./computeContextStore";
import {
  getComputeFilePresentation,
  useComputeFilePresentationStore,
} from "./computeFilePresentationStore";

const first = ComputeContextId.make("file-one");
const second = ComputeContextId.make("file-two");

describe("compute file presentation store", () => {
  beforeEach(() => useComputeFilePresentationStore.setState({ presentations: {} }));

  it("keeps each tab's selected views across component remounts", () => {
    useComputeFilePresentationStore.getState().setFileView(first, "results");
    useComputeFilePresentationStore.getState().setPanelView(first, "variables");
    useComputeFilePresentationStore.getState().setFileView(second, "split");

    expect(getComputeFilePresentation(first)).toEqual({ view: "results", panelView: "variables" });
    expect(getComputeFilePresentation(second)).toEqual({ view: "split", panelView: "results" });
  });

  it("clears only the explicitly closed tab", () => {
    useComputeFilePresentationStore.getState().setFileView(first, "results");
    useComputeFilePresentationStore.getState().setFileView(second, "split");
    useComputeFilePresentationStore.getState().remove(first);

    expect(getComputeFilePresentation(first)).toEqual({ view: "code", panelView: "results" });
    expect(getComputeFilePresentation(second).view).toBe("split");
  });
});
