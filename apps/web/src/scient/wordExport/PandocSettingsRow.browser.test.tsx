import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { EnvironmentId, type ScientPandocToolStatus } from "@t3tools/contracts";
import { useLayoutEffect, type ReactNode } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

const readPandocTool = vi.fn();
const installPandocTool = vi.fn();
vi.mock("./client", () => ({ readPandocTool, installPandocTool }));
// Only the Word export row is under test, not the settings scope stores.
vi.mock("~/components/settings/settingsLayout", () => ({
  SettingsSection: ({
    id,
    title,
    children,
  }: {
    id: string;
    title: ReactNode;
    children: ReactNode;
  }) => (
    <section id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: (props: {
    id?: string;
    title: ReactNode;
    description: ReactNode;
    status?: ReactNode;
    control: ReactNode;
  }) => (
    <div id={props.id}>
      <h3>{props.title}</h3>
      <p>{props.description}</p>
      <div data-testid="status">{props.status}</div>
      {props.control}
    </div>
  ),
}));

const { PandocSettingsRow } = await import("./PandocSettingsRow");
const { usePandocTool } = await import("./usePandocTool");
const { pandocToolSummary } = await import("./pandocToolModel");

function WordTab({ _fixture }: { _fixture: _Fixture }) {
  const controller = usePandocTool(EnvironmentId.make("local"));
  useLayoutEffect(() => {
    _fixture.publishLastSummary(pandocToolSummary(controller.view));
    _fixture.publishRefreshWordTab(controller.refresh);
  });
  return <PandocSettingsRow controller={controller} />;
}

const SOURCE = "https://github.com/jgm/pandoc/archive/refs/tags/3.11.tar.gz";
const status = (overrides: Partial<ScientPandocToolStatus> = {}): ScientPandocToolStatus => ({
  version: "3.11",
  license: "GPL-2.0-or-later",
  sourceUrl: SOURCE,
  installed: true,
  canInstall: true,
  unavailableReason: null,
  downloadBytes: 41_832_712,
  install: {
    state: "idle",
    bytesReceived: null,
    totalBytes: null,
    failureReason: null,
    updatedAtEpochMs: 1,
  },
  ...overrides,
});

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

const render = async (_fixture: _Fixture) =>
  await act(async () => await _fixture.root0.rerender(<WordTab _fixture={_fixture} />));

describe("PandocSettingsRow", () => {
  it("names the Pandoc release, its licence, and links its exact source", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    readPandocTool.mockResolvedValue(status());
    await render(_fixture);
    expect(_fixture.container.querySelector("#word-export")).not.toBeNull();
    const line = _fixture.container.querySelector('[data-testid="status"]');
    expect(line?.textContent).toBe("Pandoc 3.11 · GPL-2.0-or-later · Source code");
    const link = line?.querySelector("a");
    expect(link?.getAttribute("href")).toBe(SOURCE);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(link?.getAttribute("aria-label")).toBe("Pandoc 3.11 source code (opens in browser)");
  });

  it("leaves out the link for a server that does not name the source", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { license: _license, sourceUrl: _sourceUrl, ...older } = status();
    readPandocTool.mockResolvedValue(older);
    await render(_fixture);
    expect(_fixture.container.querySelector('[data-testid="status"]')?.textContent).toBe(
      "Pandoc 3.11",
    );
    expect(_fixture.container.querySelector("a")).toBeNull();
  });

  it("offers a reinstall when the installed Pandoc could not be started", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    readPandocTool.mockResolvedValue(status({ installed: false, reinstallRequired: true }));
    installPandocTool.mockResolvedValue(
      status({
        installed: false,
        install: {
          state: "downloading",
          bytesReceived: 0,
          totalBytes: 41_832_712,
          failureReason: null,
          updatedAtEpochMs: 2,
        },
      }),
    );
    await render(_fixture);
    expect(_fixture.container.textContent).toContain(
      "Pandoc could not be started. Reinstall it to export to Word.",
    );
    const reinstall = _fixture.container.querySelector("button");
    expect(reinstall?.textContent).toBe("Reinstall Pandoc (40 MB)");
    expect(reinstall?.type).toBe("button");
    expect(reinstall?.disabled).toBe(false);
    reinstall?.focus();
    expect(document.activeElement).toBe(reinstall);
    await act(async () => reinstall?.click());
    expect(installPandocTool).toHaveBeenCalledTimes(1);
    expect(_fixture.container.textContent).toContain("Downloading Pandoc");
  });

  it("says Pandoc's state in a few words under the Word tab", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    readPandocTool.mockResolvedValue(status());
    await render(_fixture);
    expect(_fixture.container.querySelector("h3")?.textContent).toBe("Pandoc");
    expect(_fixture.container.querySelector("p")?.textContent).toBe("Installed");
    readPandocTool.mockResolvedValue(status({ installed: false }));
    await act(async () => await _fixture.root0.unmount());
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
    await render(_fixture);
    expect(_fixture.container.querySelector("p")?.textContent).toBe("Not installed · 40 MB");
  });

  it("waits for a running check before installing, so an older answer cannot undo the install", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    readPandocTool.mockResolvedValue(status({ installed: false }));
    await render(_fixture);
    let answer!: (value: ScientPandocToolStatus) => void;
    readPandocTool.mockImplementationOnce(
      () => new Promise<ScientPandocToolStatus>((resolve) => (answer = resolve)),
    );
    await act(async () => _fixture.refreshWordTab());
    const install = _fixture.container.querySelector("button")!;
    expect(install.disabled).toBe(true);
    await act(async () => install.click());
    expect(installPandocTool).not.toHaveBeenCalled();
    await act(async () => answer(status({ installed: false })));
    installPandocTool.mockResolvedValue(
      status({
        installed: false,
        install: {
          state: "downloading",
          bytesReceived: 0,
          totalBytes: 41_832_712,
          failureReason: null,
          updatedAtEpochMs: 2,
        },
      }),
    );
    await act(async () => _fixture.container.querySelector("button")!.click());
    expect(installPandocTool).toHaveBeenCalledTimes(1);
    expect(_fixture.lastSummary).toBe("Installing…");
  });

  it("says Not checked, not Not installed, when only the check failed", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    readPandocTool.mockResolvedValue(status());
    await render(_fixture);
    expect(_fixture.lastSummary).toBe("Ready");
    readPandocTool.mockRejectedValueOnce(new Error("The server did not answer."));
    await act(async () => _fixture.refreshWordTab());
    expect(_fixture.lastSummary).toBe("Not checked");
    expect(_fixture.container.textContent).toContain("The server did not answer.");
    expect(_fixture.container.querySelector("button")?.textContent).toBe("Check again");
  });
});

function _createFixture() {
  let _published_lastSummary = "";
  let _published_refreshWordTab = (() => undefined) as () => void;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get lastSummary() {
      return _published_lastSummary;
    },
    publishLastSummary(next: typeof _published_lastSummary) {
      _published_lastSummary = next;
      return next;
    },
    get refreshWordTab() {
      return _published_refreshWordTab;
    },
    publishRefreshWordTab(next: typeof _published_refreshWordTab) {
      _published_refreshWordTab = next;
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
