import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";

import { FileReadFailure } from "./FileReadFailure";

describe("files panel read failure", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }

  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    vi.unstubAllGlobals();
  }

  const tryAgain = (_fixture: _Fixture) =>
    [..._fixture.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Try again"),
    );

  it("recovers through Try again: request, pending, then the file replaces the failure", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onRetry = vi.fn();
    const failed = (retrying: boolean) => (
      <FileReadFailure
        failure="operation_failed"
        message="Failed to open '/tmp/report.md'."
        retrying={retrying}
        onRetry={onRetry}
      />
    );
    await act(async () => await _fixture.root0.rerender(failed(false)));
    expect(_fixture.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't open this file",
    );
    expect(_fixture.container.textContent).not.toContain("/tmp/report.md");

    await act(() => tryAgain(_fixture)?.click());
    expect(onRetry).toHaveBeenCalledOnce();

    await act(async () => await _fixture.root0.rerender(failed(true)));
    expect(tryAgain(_fixture)?.getAttribute("aria-busy")).toBe("true");
    await act(() => tryAgain(_fixture)?.click());
    expect(onRetry).toHaveBeenCalledOnce();

    await act(async () => await _fixture.root0.rerender(<p>report contents</p>));
    expect(_fixture.container.querySelector('[role="alert"]')).toBeNull();
    expect(_fixture.container.textContent).toBe("report contents");
  });

  it("offers no retry where reading again cannot help", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    for (const failure of ["binary_file", "resolved_path_outside_root"] as const) {
      await act(
        async () =>
          await _fixture.root0.rerender(
            <FileReadFailure failure={failure} message="x" retrying={false} onRetry={vi.fn()} />,
          ),
      );
      expect(tryAgain(_fixture)).toBeUndefined();
    }
    expect(_fixture.container.textContent).toContain("Outside this project");
  });

  const button = (_fixture: _Fixture, label: string) =>
    [..._fixture.container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label),
    );

  it("names the missing location and lets the user pick which file was meant", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onOpenCandidate = vi.fn();
    await act(
      async () =>
        await _fixture.root0.rerender(
          <FileReadFailure
            failure="operation_failed"
            reason="not_found"
            message="raw"
            retrying={false}
            onRetry={vi.fn()}
            path="/Users/me/project/dup.md"
            candidates={["reviews/a/dup.md", "reviews/b/dup.md"]}
            onOpenCandidate={onOpenCandidate}
          />,
        ),
    );
    // A choice to make reads as a question, not as a broken link.
    expect(_fixture.container.textContent).toContain("Which file did you mean?");
    expect(_fixture.container.textContent).toContain("/Users/me/project/dup.md");
    expect(_fixture.container.textContent).toContain(
      "These files in this project have the same name:",
    );
    expect(_fixture.container.textContent).not.toContain("couldn't search the whole project");

    await act(() => button(_fixture, "reviews/b/dup.md")?.click());
    expect(onOpenCandidate).toHaveBeenCalledExactlyOnceWith("reviews/b/dup.md");
  });

  it("says plainly when nothing was found, and when the search was incomplete", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const render = async (candidates: string[], candidatesIncomplete: boolean) =>
      await act(
        async () =>
          await _fixture.root0.rerender(
            <FileReadFailure
              failure="operation_failed"
              reason="not_found"
              message="raw"
              retrying={false}
              onRetry={vi.fn()}
              path="/Users/me/project/reviews/missing.md"
              candidates={candidates}
              candidatesIncomplete={candidatesIncomplete}
              onOpenCandidate={vi.fn()}
            />,
          ),
      );
    await render([], false);
    expect(_fixture.container.textContent).toContain("File not found");
    expect(tryAgain(_fixture)).toBeDefined();

    await render(["archive/missing.md"], true);
    expect(_fixture.container.textContent).toContain("One file in this project has the same name:");
    expect(_fixture.container.textContent).toContain("couldn't search the whole project");
  });

  it("offers no choices and no settings shortcut for a denied read", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(
      async () =>
        await _fixture.root0.rerender(
          <FileReadFailure
            failure="operation_failed"
            reason="permission_denied"
            message={null}
            retrying={false}
            onRetry={vi.fn()}
            path="/Users/me/private/notes.md"
            candidates={["reviews/notes.md"]}
            onOpenCandidate={vi.fn()}
          />,
        ),
    );
    expect(_fixture.container.textContent).toContain("Access denied");
    expect(button(_fixture, "reviews/notes.md")).toBeUndefined();
    expect(button(_fixture, "Privacy")).toBeUndefined();
  });

  it("opens an older server's outside-the-project refusal read-only", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onOpenReadOnly = vi.fn();
    await act(
      async () =>
        await _fixture.root0.rerender(
          <FileReadFailure
            failure="workspace_path_outside_root"
            message="outside"
            retrying={false}
            onRetry={vi.fn()}
            onOpenReadOnly={onOpenReadOnly}
          />,
        ),
    );
    await act(() => button(_fixture, "Open read-only")?.click());
    expect(onOpenReadOnly).toHaveBeenCalledOnce();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
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
