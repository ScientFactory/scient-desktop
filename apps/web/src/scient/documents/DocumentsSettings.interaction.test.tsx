// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => "local",
  useEnvironment: (id: string) => ({ environmentId: id, label: id }),
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
vi.mock("~/hooks/useSettings", () => ({ usePrimarySettingsAvailable: () => true }));
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
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const render = async () => {
    await act(async () => {
      root.render(<DocumentsSettings />);
      await Promise.resolve();
    });
  };
  const installButton = () =>
    [
      ...container.querySelectorAll<HTMLButtonElement>(
        "#latex-installation button, #latex-additional-compilers button",
      ),
    ].find((node) => node.textContent?.startsWith("Install"));
  const missing = () => {
    const { source: _source, ...found } = report();
    return { ...found, kind: null, executable: null, version: null, compilers: [] };
  };
  const select = (label: string) =>
    container.querySelector<HTMLElement>(`[data-slot="select-trigger"][aria-label="${label}"]`)!;
  const choose = async (label: string, option: string) => {
    await act(() => select(label).click());
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

  it("checks both installations again from the header", async () => {
    await render();
    await act(async () => {
      container.querySelector<HTMLElement>('[aria-label="Check installations again"]')!.click();
      await Promise.resolve();
    });
    expect(mocks.pandocRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.readToolchain).toHaveBeenLastCalledWith("remote", { refresh: true });
  });
  it("keeps PDF compilation in one row with descriptions only inside the picker", async () => {
    await render();
    const row = container.querySelector("#latex-compilation")!;
    expect(row.textContent).toBe("PDF compilationOn save");
    await act(() => select("PDF compilation").click());
    const options = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      "Auto-compileUpdate the PDF after you pause editing.",
      "On saveUpdate the PDF when you save.",
      "ManualUpdate the PDF when you click Rebuild.",
    ]);
    await act(() => options[0]!.click());
    expect(stored(LATEX_COMPILATION_STORAGE_KEY)).toBe("auto");
    expect(select("PDF compilation").textContent).toBe("Auto-compile");
    await act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(select("PDF compilation").textContent).toBe("Auto-compile");
  });
  it("finds the compilation row from settings search and tolerates old unknown values", async () => {
    mocks.target = "latex-compilation";
    localStorage.setItem(LATEX_COMPILATION_STORAGE_KEY, JSON.stringify("unknown"));
    await render();
    expect(select("PDF compilation").textContent).toBe("On save");
    expect(container.querySelector("#documents-latex")?.hasAttribute("hidden")).toBe(false);
  });

  const manage = async () => {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>("#new-document-template button"),
    ].find((node) => node.textContent === "Manage")!;
    await act(() => button.click());
  };
  const library = () => container.querySelector<HTMLElement>("#document-template-library")!;
  const place = (label: string) =>
    [...library().querySelectorAll(`section[aria-label="${label}"] li`)].map(
      (node) => node.querySelector("span")!.textContent,
    );
  const templateAction = async (name: string, action: string) => {
    await act(() =>
      library().querySelector<HTMLElement>(`[aria-label="${name} actions"]`)!.click(),
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
    await render();
    expect(container.querySelector("#new-document-template")?.textContent).toContain(
      "New documents start as Blank",
    );
    expect(select("Language for new documents").textContent).toBe("English");
    await manage();
    await templateAction("Thesis", "Set as default");
    await choose("Language for new documents", "Hebrew");
    expect(stored("scient.newDocumentTemplate")).toBe("thesis");
    expect(stored("scient.newDocumentLanguage")).toBe("hebrew");
    expect(container.querySelector("#new-document-template")?.textContent).toContain(
      "New documents start as Thesis",
    );
  });

  it("arranges, hides, shows, and restores templates the way a new document offers them", async () => {
    await render();
    await manage();
    expect(place("On the page")).toEqual(["Blank", "Article", "Thesis", "Problem set"]);
    await templateAction("Thesis", "Move up");
    expect(place("On the page")).toEqual(["Blank", "Thesis", "Article", "Problem set"]);
    await templateAction("Article", "Move to More");
    expect(place("On the page")).not.toContain("Article");
    expect(place("More")[0]).toBe("Article");
    await templateAction("Letter", "Hide");
    expect(place("Hidden")).toEqual(["Letter"]);
    await templateAction("Letter", "Show");
    expect(place("More")[0]).toBe("Letter");
    expect(library().querySelector('section[aria-label="Hidden"]')).toBeNull();
    const restore = [...library().querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Restore defaults",
    )!;
    await act(() => restore.click());
    expect(place("On the page")).toEqual(["Blank", "Article", "Thesis", "Problem set"]);
  });

  it("opens LaTeX files in the view the editor remembers", async () => {
    localStorage.setItem("scient.latexPreviewMode", JSON.stringify("source"));
    await render();
    expect(select("Open LaTeX files in").textContent).toBe("Source");
    await choose("Open LaTeX files in", "Split");
    expect(stored("scient.latexPreviewMode")).toBe("split");
  });

  it("keeps compiler preferences editable offline without claiming server availability", async () => {
    mocks.scopeEnvironmentId = null;
    await render();
    expect(container.querySelector("#latex-installation")?.textContent).toContain("Offline");
    await choose("Default compiler for new documents", "XeLaTeX — recommended for Hebrew");
    expect(stored("scient.newDocumentCompiler")).toBe("xelatex");
    await act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(select("Default compiler for new documents").textContent).toBe(
      "XeLaTeX — recommended for Hebrew",
    );
    expect(mocks.readToolchain).not.toHaveBeenCalled();
  });

  it("keeps versions and paths folded until details are requested, with actual per-engine availability", async () => {
    await render();
    const details = container.querySelector("#latex-compilers")!;
    const toggle = details.querySelector<HTMLButtonElement>("button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("#latex-installation")?.textContent).not.toContain("4.85");
    await act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const rows = [...details.querySelectorAll('[data-slot="settings-row"]')];
    const compiler = (name: string) =>
      rows.find((row) => row.querySelector("h3")?.textContent === name)!;
    expect(compiler("pdfLaTeX").textContent).toContain("Available");
    expect(compiler("XeLaTeX — recommended for Hebrew").textContent).toContain("Available");
    expect(compiler("LuaLaTeX").textContent).toContain("Not installed");
    expect(details.textContent).toContain("/Library/TeX/texbin/latexmk");
    expect(details.textContent).toContain("4.85");
  });

  it("opens Markdown files Rich or Source", async () => {
    localStorage.setItem("t3code.renderMarkdown", JSON.stringify(false));
    await render();
    await act(() => container.querySelector<HTMLElement>("#documents-markdown-trigger")!.click());
    expect(container.querySelector("#latex-installation")).toBeNull();
    expect(select("Open Markdown files in").textContent).toBe("Source");
    await choose("Open Markdown files in", "Rich");
    expect(stored("t3code.renderMarkdown")).toBe(true);
  });

  it("installs tools only after an explicit action, not mounting or changing the default", async () => {
    mocks.report = missing();
    await render();
    expect(installButton()).toBeDefined();
    expect(mocks.install).not.toHaveBeenCalled();
    await choose("Default compiler for new documents", "XeLaTeX — recommended for Hebrew");
    expect(mocks.install).not.toHaveBeenCalled();
    await choose("Default compiler for new documents", "Automatic");
    expect(mocks.install).not.toHaveBeenCalled();
    await act(async () => installButton()!.click());
    expect(mocks.install).toHaveBeenCalledWith("remote");
    expect(container.querySelector("#latex-installation [role=status]")?.textContent).toContain(
      "Downloading",
    );
    expect(installButton()).toBeUndefined();
  });

  it("does not stay busy when the install cannot even be asked for", async () => {
    mocks.report = missing();
    mocks.install.mockImplementation(() => {
      throw new Error("This server is not connected.");
    });
    await render();
    await act(async () => {
      installButton()!.click();
      await Promise.resolve();
    });
    const row = container.querySelector("#latex-installation")!;
    expect(row.textContent).toContain("This server is not connected.");
    expect(row.querySelector("[role=alert]")).not.toBeNull();
    const retry = row.querySelector<HTMLButtonElement>("button")!;
    await act(async () => retry.click());
    expect(mocks.install).toHaveBeenCalledTimes(2);
  });

  it("holds Install while a search for LaTeX is still answering", async () => {
    mocks.report = missing();
    await render();
    let answer!: (value: ScientLatexToolchainReport) => void;
    mocks.readToolchain.mockImplementationOnce(
      () => new Promise<ScientLatexToolchainReport>((resolve) => (answer = resolve)),
    );
    await act(() =>
      container.querySelector<HTMLElement>('[aria-label="Check installations again"]')!.click(),
    );
    expect(installButton()!.disabled).toBe(true);
    await act(async () => {
      answer(missing());
      await Promise.resolve();
    });
    expect(installButton()!.disabled).toBe(false);
  });

  it("shows optional installation progress and failure while keeping working Tectonic tools ready", async () => {
    mocks.report = report({
      kind: "tectonic",
      executable: "tectonic",
      version: "0.15",
      compilers: [],
    });
    await render();
    const tools = () => container.querySelector("#latex-installation")!;
    const additional = () => container.querySelector("#latex-additional-compilers")!;
    expect(tools().textContent).toContain("Ready");
    expect(installButton()).toBeDefined();
    const { promise, reject } = Promise.withResolvers<unknown>();
    mocks.install.mockReturnValueOnce(promise);
    await act(() => installButton()!.click());
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
    mocks.report = report({
      compilers: report().compilers.map((entry) => ({ ...entry, available: true })),
    });
    await render();
    expect(installButton()).toBeUndefined();
    expect(container.querySelector("#latex-additional-compilers")).toBeNull();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("reveals technical details when search targets compiler status, but not when it targets installation", async () => {
    localStorage.setItem("scient.documentsSettingsFormat", JSON.stringify("markdown"));
    mocks.target = "latex-compilers";
    await render();
    expect(container.querySelector("#latex-compilers button")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(container.querySelector("#latex-compilers")?.textContent).toContain(
      "/Library/TeX/texbin/latexmk",
    );
    await act(() => root.unmount());
    root = createRoot(container);
    mocks.target = "latex-installation";
    await render();
    expect(container.querySelector("#latex-compilers button")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(installButton()).toBeDefined();
  });

  it("reads LaTeX on the environment chosen in the settings scope", async () => {
    mocks.scopeEnvironmentId = "scoped";
    await render();
    expect(mocks.readToolchain).toHaveBeenCalledWith("scoped", { refresh: false });
  });

  it("opens the LaTeX tab when search jumps to one of its rows", async () => {
    localStorage.setItem("scient.documentsSettingsFormat", JSON.stringify("markdown"));
    mocks.target = "new-document-template";
    await render();
    expect(container.querySelector("#new-document-template")).not.toBeNull();
    expect(stored("scient.documentsSettingsFormat")).toBe("latex");
  });

  it("shows the server tools as Offline, and keeps preferences editable, with no connected server", async () => {
    mocks.scopeEnvironmentId = null;
    await render();
    expect(mocks.readToolchain).not.toHaveBeenCalled();
    expect(mocks.pandocEnvironments).toEqual([]);
    expect(container.querySelector("#documents-latex-trigger")?.textContent).toBe("LaTeXOffline");
    expect(container.querySelector("#latex-installation")?.textContent).toContain("Offline");
    expect(container.querySelector("#new-document-template")).not.toBeNull();
    const word = container.querySelector<HTMLElement>("#documents-word-trigger")!;
    expect(word.textContent).toBe("WordOffline");
    await act(() => word.click());
    expect(container.querySelector("#word-export")?.textContent).toContain("Offline");
    expect(container.querySelector("#word-export button")).toBeNull();
  });

  it("lets the tabs change while a search jump is still waiting for its row", async () => {
    mocks.scopeEnvironmentId = null;
    mocks.target = "latex-installation";
    localStorage.setItem("scient.documentsSettingsFormat", JSON.stringify("markdown"));
    await render();
    expect(container.querySelector("#documents-latex")).not.toBeNull();
    await act(() => container.querySelector<HTMLElement>("#documents-markdown-trigger")!.click());
    expect(container.querySelector("#documents-markdown")).not.toBeNull();
    expect(stored("scient.documentsSettingsFormat")).toBe("markdown");
  });
});
