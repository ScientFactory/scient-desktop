import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { EnvironmentId, type ScientLatexResolveResult } from "@t3tools/contracts";
import { useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

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
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
    _fixture.publishSeen([]);
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
  }

  function Probe({
    _fixture,
    ...props
  }: { path: string; movedFrom?: string } & { _fixture: _Fixture }) {
    const state = useLatexDocumentResolution({
      environmentId,
      workspaceRoot: "/w",
      sourceRelativePath: props.path,
      sourceRevision: "r1",
      ...(props.movedFrom === undefined ? {} : { movedFrom: props.movedFrom }),
    });
    useLayoutEffect(() => {
      _fixture.appendSeen(state);
    });
    return null;
  }

  it("keeps the old resolution, renamed, until the new path answers", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.resolve.mockResolvedValueOnce(resolvedAt("untitled.tex"));
    await act(
      async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} path="untitled.tex" />),
    );
    expect(_fixture.seen.at(-1)?.result).toEqual(resolvedAt("untitled.tex"));
    let answer!: (value: ScientLatexResolveResult) => void;
    mocks.resolve.mockReturnValueOnce(new Promise((done) => (answer = done)));
    _fixture.publishSeen([]);
    await act(
      async () =>
        await _fixture.root0.rerender(
          <Probe _fixture={_fixture} path="heat-flow.tex" movedFrom="untitled.tex" />,
        ),
    );
    // Never without a root while the new path is being resolved.
    expect(_fixture.seen.every((state) => state.result?._tag === "resolved")).toBe(true);
    expect(_fixture.seen.at(-1)).toMatchObject({
      pending: true,
      result: { sourceRelativePath: "heat-flow.tex", rootRelativePath: "heat-flow.tex" },
    });
    await act(async () => answer(resolvedAt("heat-flow.tex")));
    expect(_fixture.seen.at(-1)).toMatchObject({
      pending: false,
      result: resolvedAt("heat-flow.tex"),
    });
  });

  it("carries nothing to a path the document did not move to", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.resolve.mockResolvedValueOnce(resolvedAt("a.tex"));
    await act(
      async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} path="a.tex" />),
    );
    mocks.resolve.mockReturnValueOnce(new Promise(() => {}));
    _fixture.publishSeen([]);
    await act(
      async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} path="b.tex" />),
    );
    expect(_fixture.seen.at(-1)).toMatchObject({ pending: true, result: null });
  });
  it("retries failed discovery after recovery without changing the file revision", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.resolve.mockRejectedValueOnce(new Error("Workspace publication needs recovery."));
    await act(
      async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} path="paper.tex" />),
    );
    expect(_fixture.seen.at(-1)).toMatchObject({
      pending: false,
      result: null,
      error: "Workspace publication needs recovery.",
    });
    mocks.resolve.mockResolvedValueOnce(resolvedAt("paper.tex"));
    await act(async () => _fixture.seen.at(-1)!.retry());
    expect(_fixture.seen.at(-1)).toMatchObject({
      pending: false,
      error: null,
      result: resolvedAt("paper.tex"),
    });
    expect(mocks.resolve.mock.calls.at(-1)?.[1]).toEqual({
      workspaceRoot: "/w",
      sourceRelativePath: "paper.tex",
    });
  });
});

function _createFixture() {
  let _published_seen = undefined! as LatexDocumentResolutionState[];

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get seen() {
      return _published_seen;
    },
    publishSeen(next: typeof _published_seen) {
      _published_seen = next;
      return next;
    },
    appendSeen(...next: typeof _published_seen) {
      return _published_seen.push(...next);
    },

    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
