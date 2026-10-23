import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { EnvironmentId } from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";

const readPandocTool = vi.fn();
const installPandocTool = vi.fn();
vi.mock("../wordExport/client", () => ({ readPandocTool, installPandocTool }));

const { WordPandocRequirement } = await import("./WordPandocRequirement");

const environmentId = EnvironmentId.make("local");

function status(install: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    version: "3.11",
    installed: false,
    canInstall: true,
    unavailableReason: null,
    downloadBytes: 41_832_712,
    install: {
      state: "idle",
      bytesReceived: null,
      totalBytes: null,
      failureReason: null,
      updatedAtEpochMs: 1,
      ...install,
    },
    ...overrides,
  };
}

async function _setupFixture0(_fixture: _Fixture) {
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
  vi.unstubAllGlobals();
}

async function render(_fixture: _Fixture, disabled: boolean) {
  await act(
    async () =>
      await _fixture.root0.rerender(
        <WordPandocRequirement
          environmentId={environmentId}
          reason="Word export is not available."
          disabled={disabled}
          onAvailable={() => undefined}
        />,
      ),
  );
  await act(async () => {
    await Promise.resolve();
  });
}

function installButton(_fixture: _Fixture) {
  return [..._fixture.container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Install Pandoc",
  );
}

describe("WordPandocRequirement", () => {
  it("disables the install while an export is running", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    readPandocTool.mockResolvedValue(status({}));
    await render(_fixture, true);
    expect(_fixture.container.textContent).toContain(
      "Word export needs Pandoc (40 MB, one-time download).",
    );
    expect(installButton(_fixture)?.disabled).toBe(true);
    await act(async () => installButton(_fixture)?.click());
    expect(installPandocTool).not.toHaveBeenCalled();

    await render(_fixture, false);
    expect(installButton(_fixture)?.disabled).toBe(false);
  });

  it("shows the install progress as a status line with nothing to press", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    readPandocTool.mockResolvedValue(
      status({ state: "downloading", bytesReceived: 12 * 1024 * 1024, totalBytes: 41_832_712 }),
    );
    await render(_fixture, false);
    expect(_fixture.container.querySelector('[role="status"]')?.textContent).toBe(
      "Downloading Pandoc… 12 MB of 40 MB",
    );
    expect(_fixture.container.querySelector("button")).toBeNull();
  });

  it("gives the server's reason when Pandoc is installed but Word export is still unavailable", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    readPandocTool.mockResolvedValue(status({ state: "ready" }, { installed: true }));
    await render(_fixture, false);
    expect(_fixture.container.textContent).toBe("Word export is not available.");
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
