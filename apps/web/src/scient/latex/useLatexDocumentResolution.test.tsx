// @vitest-environment happy-dom
import { EnvironmentId, type ScientLatexResolveResult } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("./client", () => ({ requestLatexResolution: mocks.resolve }));

import {
  type LatexDocumentResolutionState,
  useLatexDocumentResolution,
} from "./useLatexDocumentResolution";

const environmentId = EnvironmentId.make("resolution-test");

function resolvedAt(path: string): ScientLatexResolveResult {
  return {
    _tag: "resolved",
    sourceRelativePath: path,
    rootRelativePath: path,
    reason: "self-document",
    candidates: [
      { rootRelativePath: path, evidence: ["self-document"], independentlyCompilable: true },
    ],
    complete: true,
    incompleteReasons: [],
  };
}

describe("useLatexDocumentResolution across an in-place rename", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let seen: LatexDocumentResolutionState[];
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    seen = [];
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function Probe(props: { path: string; movedFrom?: string }) {
    const state = useLatexDocumentResolution({
      environmentId,
      workspaceRoot: "/w",
      sourceRelativePath: props.path,
      sourceRevision: "r1",
      ...(props.movedFrom === undefined ? {} : { movedFrom: props.movedFrom }),
    });
    useLayoutEffect(() => {
      seen.push(state);
    });
    return null;
  }

  it("keeps the old resolution, renamed, until the new path answers", async () => {
    mocks.resolve.mockResolvedValueOnce(resolvedAt("untitled.tex"));
    await act(async () => root.render(<Probe path="untitled.tex" />));
    expect(seen.at(-1)?.result).toEqual(resolvedAt("untitled.tex"));
    let answer!: (value: ScientLatexResolveResult) => void;
    mocks.resolve.mockReturnValueOnce(new Promise((done) => (answer = done)));
    seen = [];
    await act(async () => root.render(<Probe path="heat-flow.tex" movedFrom="untitled.tex" />));
    // Never without a root while the new path is being resolved.
    expect(seen.every((state) => state.result?._tag === "resolved")).toBe(true);
    expect(seen.at(-1)).toMatchObject({
      pending: true,
      result: { sourceRelativePath: "heat-flow.tex", rootRelativePath: "heat-flow.tex" },
    });
    await act(async () => answer(resolvedAt("heat-flow.tex")));
    expect(seen.at(-1)).toMatchObject({ pending: false, result: resolvedAt("heat-flow.tex") });
  });

  it("carries nothing to a path the document did not move to", async () => {
    mocks.resolve.mockResolvedValueOnce(resolvedAt("a.tex"));
    await act(async () => root.render(<Probe path="a.tex" />));
    mocks.resolve.mockReturnValueOnce(new Promise(() => {}));
    seen = [];
    await act(async () => root.render(<Probe path="b.tex" />));
    expect(seen.at(-1)).toMatchObject({ pending: true, result: null });
  });
});
