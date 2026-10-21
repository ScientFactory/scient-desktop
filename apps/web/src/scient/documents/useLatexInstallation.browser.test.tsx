import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";
import {
  EnvironmentId,
  type ScientLatexManagedInstallState,
  type ScientLatexToolchainReport,
} from "@t3tools/contracts";
import { useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

const readLatexToolchain = vi.fn();
const requestLatexToolchainInstall = vi.fn();
vi.mock("../latex/client", () => ({ readLatexToolchain, requestLatexToolchainInstall }));

const { useLatexInstallation } = await import("./useLatexInstallation");

const missing: ScientLatexToolchainReport = {
  kind: null,
  executable: null,
  version: null,
  probedAtEpochMs: 1,
  canInstallManaged: true,
  compilers: [],
};
const downloading: ScientLatexManagedInstallState = {
  state: "downloading",
  version: "2026.08",
  bytesReceived: null,
  totalBytes: null,
  failureReason: null,
  updatedAtEpochMs: 2,
};

function Watch({ _fixture }: { _fixture: _Fixture }) {
  const controller = useLatexInstallation(EnvironmentId.make("local"));
  useLayoutEffect(() => {
    _fixture.publishKind(controller.view.kind);
    _fixture.publishSummary(controller.view.summary);
    _fixture.publishLastReport(controller.report);
    _fixture.publishInstall(controller.act);
    _fixture.publishRefresh(controller.refresh);
  });
  return null;
}

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.stack.use(_fixtureFakeTimers());
  readLatexToolchain.mockReset();
  requestLatexToolchainInstall.mockReset();
  _fixture.container = document.createElement("div");
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
}

describe("useLatexInstallation answers that arrive out of order", () => {
  it("never installs during mount, refresh, or passive status polling", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    readLatexToolchain.mockResolvedValue(missing);
    await act(async () => await _fixture.root0.rerender(<Watch _fixture={_fixture} />));
    await act(async () => _fixture.refresh());
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(requestLatexToolchainInstall).not.toHaveBeenCalled();
    expect(_fixture.kind).toBe("missing");
  });

  it("ignores an install action when all standalone compilers are already available", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    readLatexToolchain.mockResolvedValue({
      ...missing,
      kind: "latexmk",
      compilers: (["pdflatex", "xelatex", "lualatex"] as const).map((compiler) => ({
        compiler,
        available: true,
        executable: compiler,
        version: null,
      })),
    });
    await act(async () => await _fixture.root0.rerender(<Watch _fixture={_fixture} />));
    await act(() => _fixture.install());
    expect(requestLatexToolchainInstall).not.toHaveBeenCalled();
    expect(_fixture.kind).toBe("ready");
  });

  it("retains existing tool capabilities if an optional install request fails, and permits retry", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const tectonic = { ...missing, kind: "tectonic" as const, executable: "tectonic" };
    readLatexToolchain.mockResolvedValue(tectonic);
    requestLatexToolchainInstall.mockRejectedValueOnce(new Error("Connection interrupted"));
    await act(async () => await _fixture.root0.rerender(<Watch _fixture={_fixture} />));
    await act(async () => _fixture.install());
    expect(_fixture.kind).toBe("failed");
    expect(_fixture.summary).toBe("Ready");
    expect(_fixture.lastReport).toEqual(tectonic);
    requestLatexToolchainInstall.mockResolvedValueOnce(downloading);
    await act(async () => _fixture.install());
    expect(requestLatexToolchainInstall).toHaveBeenCalledTimes(2);
    expect(_fixture.kind).toBe("installing");
    expect(_fixture.summary).toBe("Ready");
    expect(_fixture.lastReport?.kind).toBe("tectonic");
  });

  it("lets the install's answer lead over a check that finished before the server saw it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    readLatexToolchain.mockResolvedValueOnce(missing);
    await act(async () => await _fixture.root0.rerender(<Watch _fixture={_fixture} />));
    expect(_fixture.kind).toBe("missing");
    let acknowledge!: (value: ScientLatexManagedInstallState) => void;
    requestLatexToolchainInstall.mockReturnValueOnce(
      new Promise<ScientLatexManagedInstallState>((resolve) => (acknowledge = resolve)),
    );
    await act(async () => _fixture.install());
    expect(_fixture.kind).toBe("installing");
    readLatexToolchain.mockResolvedValueOnce(missing);
    await act(async () => _fixture.refresh());
    expect(_fixture.kind).toBe("installing");
    await act(async () => acknowledge(downloading));
    expect(_fixture.kind).toBe("installing");
    readLatexToolchain.mockResolvedValue({ ...missing, managedInstall: downloading });
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(readLatexToolchain).toHaveBeenCalledTimes(3);
    expect(_fixture.kind).toBe("installing");
  });
});

function _createFixture() {
  let _published_kind = "";
  let _published_summary = "";
  let _published_lastReport = null as ScientLatexToolchainReport | null;
  let _published_install = (() => undefined) as () => void;
  let _published_refresh = (async () => undefined) as () => Promise<void>;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get kind() {
      return _published_kind;
    },
    publishKind(next: typeof _published_kind) {
      _published_kind = next;
      return next;
    },
    get summary() {
      return _published_summary;
    },
    publishSummary(next: typeof _published_summary) {
      _published_summary = next;
      return next;
    },
    get lastReport() {
      return _published_lastReport;
    },
    publishLastReport(next: typeof _published_lastReport) {
      _published_lastReport = next;
      return next;
    },
    get install() {
      return _published_install;
    },
    publishInstall(next: typeof _published_install) {
      _published_install = next;
      return next;
    },
    get refresh() {
      return _published_refresh;
    },
    publishRefresh(next: typeof _published_refresh) {
      _published_refresh = next;
      return next;
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
