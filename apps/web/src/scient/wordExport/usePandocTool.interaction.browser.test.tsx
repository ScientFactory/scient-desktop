import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";

import { EnvironmentId } from "@t3tools/contracts";
import { useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

const readPandocTool = vi.fn();
const installPandocTool = vi.fn();
vi.mock("./client", () => ({ readPandocTool, installPandocTool }));

const { PandocInstallStatus } = await import("./PandocInstallControl");
const { usePandocTool } = await import("./usePandocTool");

const environmentId = EnvironmentId.make("local");
const active = {
  version: "3.11",
  installed: false,
  canInstall: true,
  unavailableReason: null,
  downloadBytes: 41_832_712,
  install: {
    state: "downloading" as const,
    bytesReceived: 12 * 1024 * 1024,
    totalBytes: 41_832_712,
    failureReason: null,
    updatedAtEpochMs: 1,
  },
};

function Harness() {
  const controller = usePandocTool(environmentId);
  return (
    <>
      <PandocInstallStatus controller={controller} showReady />
      <button type="button" onClick={controller.refresh}>
        Export failed
      </button>
    </>
  );
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.startsWith(label),
  );

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.stack.use(_fixtureFakeTimers());
  readPandocTool.mockReset();
  installPandocTool.mockReset();
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

describe("usePandocTool status polling", () => {
  it("shows a transient poll failure and retries the status without reinstalling", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    readPandocTool
      .mockResolvedValueOnce(active)
      .mockRejectedValueOnce(new Error("Status temporarily unavailable."))
      .mockResolvedValueOnce({
        ...active,
        installed: true,
        install: { ...active.install, state: "ready" },
      });

    await act(async () => await _fixture.root0.rerender(<Harness />));
    expect(document.body.textContent).toContain("Downloading Pandoc");

    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Status temporarily unavailable.",
    );
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Check again",
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());

    expect(readPandocTool).toHaveBeenCalledTimes(3);
    expect(installPandocTool).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain("Word export is available");
  });
});

describe("usePandocTool reinstall", () => {
  const installed = {
    ...active,
    installed: true,
    install: { ...active.install, state: "ready" as const },
  };
  const unstartable = {
    ...active,
    reinstallRequired: true,
    install: { ...active.install, state: "idle" as const, bytesReceived: null, totalBytes: null },
  };

  it("re-reads the status after a failed export and reinstalls from the offer", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    readPandocTool.mockResolvedValueOnce(installed).mockResolvedValueOnce(unstartable);
    installPandocTool.mockResolvedValueOnce(active);

    await act(async () => await _fixture.root0.rerender(<Harness />));
    expect(document.body.textContent).toContain("Word export is available");

    // The export dialog asks for a fresh status when an export fails.
    await act(async () => button("Export failed")?.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Pandoc could not be started. Reinstall it to export to Word.",
    );
    const reinstall = button("Reinstall Pandoc");
    expect(reinstall?.textContent).toBe("Reinstall Pandoc (40 MB)");
    expect(reinstall?.disabled).toBe(false);

    await act(async () => reinstall?.click());
    expect(installPandocTool).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Downloading Pandoc");
    expect(button("Reinstall Pandoc")).toBeUndefined();
  });
});

describe("usePandocTool answers that arrive out of order", () => {
  const installed = {
    ...active,
    installed: true,
    install: { ...active.install, state: "idle" as const, bytesReceived: null, totalBytes: null },
  };

  const onInstalled = vi.fn();

  function Watch({ _fixture }: { _fixture: _Fixture }) {
    const controller = usePandocTool(environmentId, onInstalled);
    useLayoutEffect(() => {
      _fixture.publishKind(controller.view.kind);
      _fixture.publishRefresh(controller.refresh);
      _fixture.publishInstall(controller.act);
    });
    return null;
  }
  const deferred = () => {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  };

  async function _setupFixture2(_fixture: _Fixture) {
    await onInstalled.mockReset();
  }

  it("keeps the newest answer when an older check finishes last", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const first = deferred();
    const second = deferred();
    readPandocTool.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await act(async () => await _fixture.root0.rerender(<Watch _fixture={_fixture} />));
    await act(async () => _fixture.refresh());
    await act(async () => second.resolve(installed));
    expect(_fixture.kind).toBe("ready");
    await act(async () => first.resolve(active));
    expect(_fixture.kind).toBe("ready");
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it("says Word export became available once a failed check is followed by an installed one", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    readPandocTool.mockRejectedValueOnce(new Error("The server did not answer."));
    await act(async () => await _fixture.root0.rerender(<Watch _fixture={_fixture} />));
    expect(_fixture.kind).toBe("failed");
    readPandocTool.mockResolvedValueOnce(installed);
    await act(async () => _fixture.refresh());
    expect(_fixture.kind).toBe("ready");
    expect(onInstalled).toHaveBeenCalledTimes(1);
    readPandocTool.mockResolvedValueOnce(installed);
    await act(async () => _fixture.refresh());
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it("lets the install's answer lead over a check that finished before the server saw it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const missing = { ...installed, installed: false };
    readPandocTool.mockResolvedValueOnce(missing);
    await act(async () => await _fixture.root0.rerender(<Watch _fixture={_fixture} />));
    expect(_fixture.kind).toBe("offer");
    const acknowledged = deferred();
    installPandocTool.mockReturnValueOnce(acknowledged.promise);
    await act(async () => _fixture.install());
    expect(_fixture.kind).toBe("installing");
    readPandocTool.mockResolvedValueOnce(missing);
    await act(async () => _fixture.refresh());
    expect(_fixture.kind).toBe("installing");
    await act(async () => acknowledged.resolve(active));
    expect(_fixture.kind).toBe("installing");
    readPandocTool.mockResolvedValue(active);
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(readPandocTool).toHaveBeenCalledTimes(3);
  });
});

function _createFixture() {
  let _published_kind = "";
  let _published_refresh = (() => undefined) as () => void;
  let _published_install = (() => undefined) as () => void;

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
    get refresh() {
      return _published_refresh;
    },
    publishRefresh(next: typeof _published_refresh) {
      _published_refresh = next;
      return next;
    },
    get install() {
      return _published_install;
    },
    publishInstall(next: typeof _published_install) {
      _published_install = next;
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
