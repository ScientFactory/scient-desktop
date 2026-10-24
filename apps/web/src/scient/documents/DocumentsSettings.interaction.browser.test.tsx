import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { type ReactNode } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import type { ScientLatexToolchainReport } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  report: null as ScientLatexToolchainReport | null,
  target: null as string | null,
  /** `undefined`: no settings scope; `null`: a scope with no connected environment. */
  scopeEnvironmentId: undefined as string | null | undefined,
  readToolchain: vi.fn(),
  install: vi.fn(),
  pandocEnvironments: [] as string[],
  pandocRefresh: vi.fn(),
}));
vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  usePrimaryEnvironmentId: () => "local",
  usePrimaryEnvironment: () => ({ environmentId: "local", label: "local" }),
  useEnvironment: (id: string) => ({ environmentId: id, label: id }),
}));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (targets: { environmentId: string }[]) =>
    new Set(targets.map((target) => target.environmentId)),
}));
vi.mock("~/components/settings/settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/settings/settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  useSettingsSearchTargetId: () => mocks.target,
}));
vi.mock("~/components/settings/SettingsScopeContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/settings/SettingsScopeContext")>()),
  useOptionalSettingsScope: () =>
    mocks.scopeEnvironmentId === undefined
      ? null
      : {
          environment:
            mocks.scopeEnvironmentId === null ? null : { environmentId: mocks.scopeEnvironmentId },
          connectedEnvironments:
            mocks.scopeEnvironmentId === null ? [] : [{ environmentId: mocks.scopeEnvironmentId }],
          scope: { kind: "environment" },
          targets: [],
        },
}));
vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  usePrimarySettingsAvailable: () => true,
}));
vi.mock("../latex/client", () => ({
  readLatexToolchain: mocks.readToolchain,
  requestLatexToolchainInstall: mocks.install,
}));
vi.mock("../wordExport/usePandocTool", () => ({
  usePandocTool: (environmentId: string) => {
    mocks.pandocEnvironments.push(environmentId);
    return {
      status: null,
      view: { kind: "ready", detail: "", actionLabel: null, busy: false },
      act: vi.fn(),
      refresh: mocks.pandocRefresh,
    };
  },
}));
import { DocumentsSettings } from "./DocumentsSettings";
import { LATEX_COMPILATION_STORAGE_KEY } from "../latex/latexCompilation";

const report = (
  overrides: Partial<ScientLatexToolchainReport> = {},
): ScientLatexToolchainReport => ({
  kind: "latexmk",
  executable: "/Library/TeX/texbin/latexmk",
  version: "4.85",
  probedAtEpochMs: 1,
  source: "system",
  canInstallManaged: true,
  compilers: [
    { compiler: "pdflatex", available: true, executable: "pdflatex", version: "3.141592653" },
    { compiler: "xelatex", available: true, executable: "xelatex", version: "0.999997" },
    { compiler: "lualatex", available: false, executable: null, version: null },
  ],
  ...overrides,
});

describe("Settings ▸ Documents", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    localStorage.clear();
    mocks.report = report();
    mocks.pandocEnvironments = [];
    mocks.pandocRefresh.mockReset();
    mocks.target = null;
    mocks.scopeEnvironmentId = "remote";
    mocks.readToolchain.mockReset().mockImplementation(async () => mocks.report);
    mocks.install.mockReset().mockResolvedValue({
      state: "downloading",
      version: "2026.08",
      bytesReceived: null,
      totalBytes: null,
      failureReason: null,
      updatedAtEpochMs: 2,
    });
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
  const render = async (_fixture: _Fixture) => {
    await act(async () => {
      await _fixture.root0.rerender(<DocumentsSettings />);
      await Promise.resolve();
    });
  };
  const installButton = (_fixture: _Fixture) =>
    [
      ..._fixture.container.querySelectorAll<HTMLButtonElement>(
        "#latex-installation button, #latex-additional-compilers button",
      ),
    ].find((node) => node.textContent?.startsWith("Install"));
  const missing = () => {
    const { source: _source, ...found } = report();
    return { ...found, kind: null, executable: null, version: null, compilers: [] };
  };
  const select = (_fixture: _Fixture, label: string) =>
    _fixture.container.querySelector<HTMLElement>(
      `[data-slot="select-trigger"][aria-label="${label}"]`,
    )!;
  const choose = async (_fixture: _Fixture, label: string, option: string) => {
    await act(() => select(_fixture, label).click());
    const item = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(
      (node) => node.textContent === option,
    );
    expect(item, option).toBeDefined();
    await act(async () => {
      item!.click();
      await Promise.resolve();
    });
  };
  const stored = (key: string) => {
    const value = localStorage.getItem(key);
    return value === null ? null : JSON.parse(value);
  };

  it("remembers the PDF compilation choice across a remount", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    expect(select(_fixture, "PDF compilation").textContent).toBe("On save");
    await act(() => select(_fixture, "PDF compilation").click());
    const options = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')];
    await act(() => options[0]!.click());
    expect(stored(LATEX_COMPILATION_STORAGE_KEY)).toBe("auto");
    expect(select(_fixture, "PDF compilation").textContent).toBe("Auto-compile");
    await act(async () => await _fixture.root0.unmount());
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
    await render(_fixture);
    expect(select(_fixture, "PDF compilation").textContent).toBe("Auto-compile");
  });
  it("finds the compilation row from settings search and tolerates old unknown values", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.target = "latex-compilation";
    localStorage.setItem(LATEX_COMPILATION_STORAGE_KEY, JSON.stringify("unknown"));
    await render(_fixture);
    expect(select(_fixture, "PDF compilation").textContent).toBe("On save");
    expect(_fixture.container.querySelector("#documents-latex")?.hasAttribute("hidden")).toBe(
      false,
    );
  });

  const manage = async (_fixture: _Fixture) => {
    const button = [
      ..._fixture.container.querySelectorAll<HTMLButtonElement>("#new-document-template button"),
    ].find((node) => node.textContent === "Manage")!;
    await act(() => button.click());
  };
  const library = (_fixture: _Fixture) =>
    _fixture.container.querySelector<HTMLElement>("#document-template-library")!;
  const place = (_fixture: _Fixture, label: string) =>
    [...library(_fixture).querySelectorAll(`section[aria-label="${label}"] li`)].map(
      (node) => node.querySelector("span")!.textContent,
    );
  const templateAction = async (_fixture: _Fixture, name: string, action: string) => {
    await act(() =>
      library(_fixture).querySelector<HTMLElement>(`[aria-label="${name} actions"]`)!.click(),
    );
    const item = [...document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')].find(
      (node) => node.textContent === action,
    );
    expect(item, `${name}: ${action}`).toBeDefined();
    await act(async () => {
      item!.click();
      await Promise.resolve();
    });
  };

  it("starts new documents Blank and English, and remembers another choice", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    expect(_fixture.container.querySelector("#new-document-template")?.textContent).toContain(
      "New documents start as Blank",
    );
    expect(select(_fixture, "Language for new documents").textContent).toBe("English");
    await manage(_fixture);
    await templateAction(_fixture, "Thesis", "Set as default");
    await choose(_fixture, "Language for new documents", "Hebrew");
    expect(stored("scient.newDocumentTemplate")).toBe("thesis");
    expect(stored("scient.newDocumentLanguage")).toBe("hebrew");
    expect(_fixture.container.querySelector("#new-document-template")?.textContent).toContain(
      "New documents start as Thesis",
    );
  });

  it("arranges, hides, shows, and restores templates the way a new document offers them", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await manage(_fixture);
    expect(place(_fixture, "On the page")).toEqual(["Blank", "Article", "Thesis", "Problem set"]);
    await templateAction(_fixture, "Thesis", "Move up");
    expect(place(_fixture, "On the page")).toEqual(["Blank", "Thesis", "Article", "Problem set"]);
    await templateAction(_fixture, "Article", "Move to More");
    expect(place(_fixture, "On the page")).not.toContain("Article");
    expect(place(_fixture, "More")[0]).toBe("Article");
    await templateAction(_fixture, "Letter", "Hide");
    expect(place(_fixture, "Hidden")).toEqual(["Letter"]);
    await templateAction(_fixture, "Letter", "Show");
    expect(place(_fixture, "More")[0]).toBe("Letter");
    expect(library(_fixture).querySelector('section[aria-label="Hidden"]')).toBeNull();
    const restore = [...library(_fixture).querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Restore defaults",
    )!;
    await act(() => restore.click());
    expect(place(_fixture, "On the page")).toEqual(["Blank", "Article", "Thesis", "Problem set"]);
  });

  it("opens LaTeX files in the view the editor remembers", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    localStorage.setItem("scient.latexPreviewMode", JSON.stringify("source"));
    await render(_fixture);
    expect(select(_fixture, "Open LaTeX files in").textContent).toBe("Source");
    await choose(_fixture, "Open LaTeX files in", "Split");
    expect(stored("scient.latexPreviewMode")).toBe("split");
  });

  it("keeps versions and paths folded until details are requested, with actual per-engine availability", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    const details = _fixture.container.querySelector("#latex-compilers")!;
    const toggle = details.querySelector<HTMLButtonElement>("button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(_fixture.container.querySelector("#latex-installation")?.textContent).not.toContain(
      "4.85",
    );
    await act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const rows = [...details.querySelectorAll('[data-slot="settings-row"]')];
    const compiler = (name: string) =>
      rows.find((row) => row.querySelector("h3")?.textContent === name)!;
    expect(compiler("pdfLaTeX").textContent).toContain("Available");
    expect(compiler("XeLaTeX (recommended for Hebrew)").textContent).toContain("Available");
    expect(compiler("LuaLaTeX").textContent).toContain("Not installed");
    expect(details.textContent).toContain("/Library/TeX/texbin/latexmk");
    expect(details.textContent).toContain("4.85");
  });

  it("opens Markdown files Rich or Source", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    localStorage.setItem("t3code.renderMarkdown", JSON.stringify(false));
    await render(_fixture);
    await act(() =>
      _fixture.container.querySelector<HTMLElement>("#documents-markdown-trigger")!.click(),
    );
    expect(_fixture.container.querySelector("#latex-installation")).toBeNull();
    expect(select(_fixture, "Open Markdown files in").textContent).toBe("Source");
    await choose(_fixture, "Open Markdown files in", "Rich");
    expect(stored("t3code.renderMarkdown")).toBe(true);
  });

  it("installs tools only after an explicit action, not mounting or changing the default", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.report = missing();
    await render(_fixture);
    expect(installButton(_fixture)).toBeDefined();
    expect(mocks.install).not.toHaveBeenCalled();
    await choose(
      _fixture,
      "Default compiler for new documents",
      "XeLaTeX (recommended for Hebrew)",
    );
    expect(mocks.install).not.toHaveBeenCalled();
    await choose(_fixture, "Default compiler for new documents", "Automatic");
    expect(mocks.install).not.toHaveBeenCalled();
    await act(async () => installButton(_fixture)!.click());
    expect(mocks.install).toHaveBeenCalledWith("remote");
    expect(
      _fixture.container.querySelector("#latex-installation [role=status]")?.textContent,
    ).toContain("Downloading");
    expect(installButton(_fixture)).toBeUndefined();
  });

  it("does not stay busy when the install cannot even be asked for", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.report = missing();
    mocks.install.mockImplementation(() => {
      throw new Error("This server is not connected.");
    });
    await render(_fixture);
    await act(async () => {
      installButton(_fixture)!.click();
      await Promise.resolve();
    });
    const row = _fixture.container.querySelector("#latex-installation")!;
    expect(row.textContent).toContain("This server is not connected.");
    expect(row.querySelector("[role=alert]")).not.toBeNull();
    const retry = row.querySelector<HTMLButtonElement>("button")!;
    await act(async () => retry.click());
    expect(mocks.install).toHaveBeenCalledTimes(2);
  });

  it("holds Install while a search for LaTeX is still answering", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.report = missing();
    await render(_fixture);
    let answer!: (value: ScientLatexToolchainReport) => void;
    mocks.readToolchain.mockImplementationOnce(
      () => new Promise<ScientLatexToolchainReport>((resolve) => (answer = resolve)),
    );
    await act(() =>
      _fixture.container
        .querySelector<HTMLElement>('[aria-label="Check installations again"]')!
        .click(),
    );
    expect(installButton(_fixture)!.disabled).toBe(true);
    await act(async () => {
      answer(missing());
      await Promise.resolve();
    });
    expect(installButton(_fixture)!.disabled).toBe(false);
  });

  it("shows optional installation progress and failure while keeping working Tectonic tools ready", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.report = report({
      kind: "tectonic",
      executable: "tectonic",
      version: "0.15",
      compilers: [],
    });
    await render(_fixture);
    const tools = () => _fixture.container.querySelector("#latex-installation")!;
    const additional = () => _fixture.container.querySelector("#latex-additional-compilers")!;
    expect(tools().textContent).toContain("Ready");
    expect(installButton(_fixture)).toBeDefined();
    const { promise, reject } = Promise.withResolvers<unknown>();
    mocks.install.mockReturnValueOnce(promise);
    await act(() => installButton(_fixture)!.click());
    expect(tools().textContent).toContain("Ready");
    expect(additional().querySelector("[role=status]")).not.toBeNull();
    expect(additional().querySelector("button")).toBeNull();
    await act(async () => reject(new Error("Connection interrupted")));
    expect(tools().textContent).toContain("Ready");
    expect(additional().querySelector("[role=alert]")?.textContent).toContain(
      "Connection interrupted",
    );
    expect(additional().querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
    expect(tools().textContent).not.toContain("Not installed");
  });

  it("does not offer another bundle when every standalone compiler is already available", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.report = report({
      compilers: report().compilers.map((entry) => ({ ...entry, available: true })),
    });
    await render(_fixture);
    expect(installButton(_fixture)).toBeUndefined();
    expect(_fixture.container.querySelector("#latex-additional-compilers")).toBeNull();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("reveals technical details when search targets compiler status, but not when it targets installation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    localStorage.setItem("scient.documentsSettingsFormat", JSON.stringify("markdown"));
    mocks.target = "latex-compilers";
    await render(_fixture);
    expect(
      _fixture.container.querySelector("#latex-compilers button")?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(_fixture.container.querySelector("#latex-compilers")?.textContent).toContain(
      "/Library/TeX/texbin/latexmk",
    );
    await act(async () => await _fixture.root0.unmount());
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
    mocks.target = "latex-installation";
    await render(_fixture);
    expect(
      _fixture.container.querySelector("#latex-compilers button")?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(installButton(_fixture)).toBeDefined();
  });

  it("reads LaTeX on the environment chosen in the settings scope", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.scopeEnvironmentId = "scoped";
    await render(_fixture);
    expect(mocks.readToolchain).toHaveBeenCalledWith("scoped", { refresh: false });
  });

  it("opens the LaTeX tab when search jumps to one of its rows", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    localStorage.setItem("scient.documentsSettingsFormat", JSON.stringify("markdown"));
    mocks.target = "new-document-template";
    await render(_fixture);
    expect(_fixture.container.querySelector("#new-document-template")).not.toBeNull();
    expect(stored("scient.documentsSettingsFormat")).toBe("latex");
  });

  it("shows the server tools as Offline, and keeps preferences editable, with no connected server", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.scopeEnvironmentId = null;
    await render(_fixture);
    expect(mocks.readToolchain).not.toHaveBeenCalled();
    expect(mocks.pandocEnvironments).toEqual([]);
    expect(_fixture.container.querySelector("#documents-latex-trigger")?.textContent).toBe(
      "LaTeXOffline",
    );
    expect(_fixture.container.querySelector("#latex-installation")?.textContent).toContain(
      "Offline",
    );
    expect(_fixture.container.querySelector("#new-document-template")).not.toBeNull();
    await choose(
      _fixture,
      "Default compiler for new documents",
      "XeLaTeX (recommended for Hebrew)",
    );
    expect(stored("scient.newDocumentCompiler")).toBe("xelatex");
    const word = _fixture.container.querySelector<HTMLElement>("#documents-word-trigger")!;
    expect(word.textContent).toBe("WordOffline");
    await act(() => word.click());
    expect(_fixture.container.querySelector("#word-export")?.textContent).toContain("Offline");
    expect(_fixture.container.querySelector("#word-export button")).toBeNull();
  });

  it("lets the tabs change while a search jump is still waiting for its row", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.scopeEnvironmentId = null;
    mocks.target = "latex-installation";
    localStorage.setItem("scient.documentsSettingsFormat", JSON.stringify("markdown"));
    await render(_fixture);
    expect(_fixture.container.querySelector("#documents-latex")).not.toBeNull();
    await act(() =>
      _fixture.container.querySelector<HTMLElement>("#documents-markdown-trigger")!.click(),
    );
    expect(_fixture.container.querySelector("#documents-markdown")).not.toBeNull();
    expect(stored("scient.documentsSettingsFormat")).toBe("markdown");
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
