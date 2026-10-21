import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";
import { useLatexAutoBuild } from "./useLatexAutoBuild";
import { LATEX_AUTO_COMPILE_DELAY_MS } from "./latexCompilation";

describe("PDF-visible automatic builds", () => {
  const requestBuild = vi.fn();

  function Harness({ _fixture }: { _fixture: _Fixture }) {
    useLatexAutoBuild(_fixture.input);
    return null;
  }
  const render = async (_fixture: _Fixture) => {
    await act(async () => await _fixture.root0.rerender(<Harness _fixture={_fixture} />));
  };
  const tick = async (ms: number) => {
    await act(async () => vi.advanceTimersByTime(ms));
  };
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.stack.use(_fixtureFakeTimers());
    vi.setSystemTime(10_000);
    requestBuild.mockReset();
    _fixture.input = {
      visible: true,
      needsBuild: true,
      blocked: false,
      busy: false,
      toolchainReady: true,
      sourceKey: "r1",
      requestBuild,
    };
    _fixture.container = document.createElement("div");
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
  it("builds a stale PDF immediately on open and re-entry", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await tick(0);
    expect(requestBuild).toHaveBeenCalledTimes(1);
    _fixture.input = { ..._fixture.input, visible: false };
    await render(_fixture);
    _fixture.input = { ..._fixture.input, visible: true };
    await render(_fixture);
    await tick(0);
    expect(requestBuild).toHaveBeenCalledTimes(2);
  });
  it("does not build a current PDF or while PDF is hidden", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.input = { ..._fixture.input, needsBuild: false };
    await render(_fixture);
    await tick(10_000);
    _fixture.input = { ..._fixture.input, visible: false, needsBuild: true };
    await render(_fixture);
    await tick(10_000);
    expect(requestBuild).not.toHaveBeenCalled();
  });
  it("does not request timed builds after editing or saving", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.input = { ..._fixture.input, needsBuild: false };
    await render(_fixture);
    _fixture.input = { ..._fixture.input, needsBuild: true, sourceKey: "r2", blocked: true };
    await render(_fixture);
    await tick(1000);
    _fixture.input = { ..._fixture.input, sourceKey: "r3", blocked: false };
    await render(_fixture);
    await tick(2499);
    expect(requestBuild).not.toHaveBeenCalled();
    await tick(1);
    expect(requestBuild).not.toHaveBeenCalled();
    await tick(60_000);
    expect(requestBuild).not.toHaveBeenCalled();
  });
  it("coalesces edits during a running build into one later build", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.input = { ..._fixture.input, busy: true };
    await render(_fixture);
    for (const key of ["r2", "r3", "r4"]) {
      _fixture.input = { ..._fixture.input, sourceKey: key };
      await render(_fixture);
    }
    await tick(3000);
    expect(requestBuild).not.toHaveBeenCalled();
    _fixture.input = { ..._fixture.input, busy: false };
    await render(_fixture);
    await tick(0);
    expect(requestBuild).toHaveBeenCalledTimes(1);
    await render(_fixture);
    await tick(10_000);
    expect(requestBuild).toHaveBeenCalledTimes(1);
  });
  it("does not retry a failed unchanged source or compile without TeX", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.input = { ..._fixture.input, toolchainReady: false };
    await render(_fixture);
    await tick(10_000);
    expect(requestBuild).not.toHaveBeenCalled();
    _fixture.input = { ..._fixture.input, toolchainReady: true };
    await render(_fixture);
    await tick(0);
    expect(requestBuild).toHaveBeenCalledTimes(1);
    _fixture.input = { ..._fixture.input, busy: true };
    await render(_fixture);
    _fixture.input = { ..._fixture.input, busy: false };
    await render(_fixture);
    await tick(10_000);
    expect(requestBuild).toHaveBeenCalledTimes(1);
  });
  it("waits for a pause, coalesces rapid edits, and compiles while Source is visible", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.input = { ..._fixture.input, mode: "auto", visible: false, needsBuild: false };
    await render(_fixture);
    _fixture.input = { ..._fixture.input, needsBuild: true, sourceKey: "edit-1" };
    await render(_fixture);
    await tick(1_500);
    _fixture.input = { ..._fixture.input, sourceKey: "edit-2" };
    await render(_fixture);
    await tick(LATEX_AUTO_COMPILE_DELAY_MS - 1);
    expect(requestBuild).not.toHaveBeenCalled();
    await tick(1);
    expect(requestBuild).toHaveBeenCalledTimes(1);
  });
  it("waits for saves and a running build, then builds only the newest source", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.input = { ..._fixture.input, mode: "auto", busy: true };
    await render(_fixture);
    _fixture.input = { ..._fixture.input, sourceKey: "included-edit-1" };
    await render(_fixture);
    _fixture.input = {
      ..._fixture.input,
      sourceKey: "included-edit-2",
      busy: false,
      blocked: true,
    };
    await render(_fixture);
    await tick(10_000);
    expect(requestBuild).not.toHaveBeenCalled();
    _fixture.input = { ..._fixture.input, blocked: false };
    await render(_fixture);
    await tick(LATEX_AUTO_COMPILE_DELAY_MS);
    expect(requestBuild).toHaveBeenCalledTimes(1);
  });
  it("does not loop on a failed source; retries after an included source changes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.input = { ..._fixture.input, mode: "auto" };
    await render(_fixture);
    await tick(LATEX_AUTO_COMPILE_DELAY_MS);
    _fixture.input = { ..._fixture.input, busy: true };
    await render(_fixture);
    _fixture.input = { ..._fixture.input, busy: false };
    await render(_fixture);
    await tick(60_000);
    expect(requestBuild).toHaveBeenCalledTimes(1);
    _fixture.input = { ..._fixture.input, sourceKey: "included-file-new-revision" };
    await render(_fixture);
    await tick(LATEX_AUTO_COMPILE_DELAY_MS);
    expect(requestBuild).toHaveBeenCalledTimes(2);
  });
  it("builds again when an outside change makes a previously current PDF stale", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.input = { ..._fixture.input, mode: "auto" };
    await render(_fixture);
    await tick(LATEX_AUTO_COMPILE_DELAY_MS);
    _fixture.input = { ..._fixture.input, needsBuild: false };
    await render(_fixture);
    _fixture.input = { ..._fixture.input, needsBuild: true };
    await render(_fixture);
    await tick(LATEX_AUTO_COMPILE_DELAY_MS);
    expect(requestBuild).toHaveBeenCalledTimes(2);
  });
  it("cancels a pending automatic build when switched to Manual", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.input = { ..._fixture.input, mode: "auto" };
    await render(_fixture);
    await tick(1_000);
    _fixture.input = { ..._fixture.input, mode: "manual" };
    await render(_fixture);
    await tick(60_000);
    _fixture.input = { ..._fixture.input, visible: false };
    await render(_fixture);
    _fixture.input = { ..._fixture.input, visible: true };
    await render(_fixture);
    await tick(60_000);
    expect(requestBuild).not.toHaveBeenCalled();
  });
  it("retires timers when the document closes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.input = { ..._fixture.input, mode: "auto" };
    await render(_fixture);
    await act(async () => await _fixture.root0.unmount());
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
    await tick(60_000);
    expect(requestBuild).not.toHaveBeenCalled();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    input: undefined! as Parameters<typeof useLatexAutoBuild>[0],

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
