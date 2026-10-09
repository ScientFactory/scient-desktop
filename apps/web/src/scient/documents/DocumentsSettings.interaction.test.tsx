// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ScientLatexToolchainReport } from "@t3tools/contracts";

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

const report = (
  overrides: Partial<ScientLatexToolchainReport> = {},
): ScientLatexToolchainReport => ({
  kind: "latexmk",
  executable: "/Library/TeX/texbin/latexmk",
  version: "4.85",
  probedAtEpochMs: 1,
  source: "system",
  canInstallManaged: true,
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
    mocks.scopeEnvironmentId = undefined;
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
  const render = async (environmentId: string | null = "remote") => {
    await act(async () => {
      root.render(
        <DocumentsSettings
          environmentId={environmentId === null ? undefined : EnvironmentId.make(environmentId)}
        />,
      );
      await Promise.resolve();
    });
  };
  const installButton = () =>
    [...container.querySelectorAll<HTMLButtonElement>("#latex-installation button")].find(
      (node) => node.textContent === "Install TinyTeX",
    );
  const missing = () => {
    const { source: _source, ...found } = report();
    return { ...found, kind: null, executable: null, version: null };
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

  it("shows LaTeX, Markdown, and Word with their logos and states", async () => {
    await render();
    const strip = container.querySelector('[aria-label="Document formats"]')!;
    const tab = (format: string) =>
      strip.querySelector<HTMLElement>(`#documents-${format}-trigger`)!;
    expect(tab("latex").textContent).toBe("LaTeXInstalled");
    expect(tab("markdown").textContent).toBe("MarkdownBuilt in");
    expect(tab("word").textContent).toBe("WordReady");
    expect(strip.querySelectorAll("img")).toHaveLength(3);
    expect(container.querySelector("#latex-installation")?.textContent).toContain(
      "latexmk 4.85 · System installation",
    );
    await act(() => tab("word").click());
    expect(container.querySelector("#word-export")?.textContent).toContain("Pandoc");
    expect(mocks.pandocEnvironments.at(-1)).toBe("remote");
  });

  it("checks both installations again from the header", async () => {
    await render();
    await act(async () => {
      container.querySelector<HTMLElement>('[aria-label="Check installations again"]')!.click();
      await Promise.resolve();
    });
    expect(mocks.pandocRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.readToolchain).toHaveBeenLastCalledWith("remote", { refresh: true });
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

  it("opens Markdown files Rich or Source", async () => {
    localStorage.setItem("t3code.renderMarkdown", JSON.stringify(false));
    await render();
    await act(() => container.querySelector<HTMLElement>("#documents-markdown-trigger")!.click());
    expect(container.querySelector("#latex-installation")).toBeNull();
    expect(select("Open Markdown files in").textContent).toBe("Source");
    await choose("Open Markdown files in", "Rich");
    expect(stored("t3code.renderMarkdown")).toBe(true);
  });

  it("offers TinyTeX when no engine is found, and shows the install starting", async () => {
    mocks.report = missing();
    await render();
    const row = container.querySelector("#latex-installation")!;
    expect(row.textContent).toContain("Not found");
    const install = [...row.querySelectorAll("button")].find(
      (node) => node.textContent === "Install TinyTeX",
    );
    await act(async () => {
      install!.click();
      await Promise.resolve();
    });
    expect(mocks.install).toHaveBeenCalledWith("remote");
    expect(container.querySelector("#latex-installation")?.textContent).toContain(
      "Downloading TinyTeX",
    );
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
    expect(row.textContent).toContain("Check again");
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

  it("reads LaTeX on the environment chosen in the settings scope", async () => {
    mocks.scopeEnvironmentId = "scoped";
    await render(null);
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
    await render(null);
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
    await render(null);
    expect(container.querySelector("#documents-latex")).not.toBeNull();
    await act(() => container.querySelector<HTMLElement>("#documents-markdown-trigger")!.click());
    expect(container.querySelector("#documents-markdown")).not.toBeNull();
    expect(stored("scient.documentsSettingsFormat")).toBe("markdown");
  });
});
