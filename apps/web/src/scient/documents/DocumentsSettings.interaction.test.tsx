// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ScientLatexToolchainReport } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  report: null as ScientLatexToolchainReport | null,
  target: null as string | null,
  scopeEnvironmentId: null as string | null,
  readToolchain: vi.fn(),
  install: vi.fn(),
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
    mocks.scopeEnvironmentId === null
      ? null
      : {
          environment: { environmentId: mocks.scopeEnvironmentId },
          connectedEnvironments: [{ environmentId: mocks.scopeEnvironmentId }],
          scope: { kind: "environment" },
          targets: [],
        },
}));
vi.mock("~/hooks/useSettings", () => ({ usePrimarySettingsAvailable: () => true }));
vi.mock("../latex/client", () => ({
  readLatexToolchain: mocks.readToolchain,
  requestLatexToolchainInstall: mocks.install,
}));
vi.mock("../wordExport/WordExportSettingsSection", () => ({
  WordExportSettingsSection: () => <section>Word export (Pandoc)</section>,
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
    mocks.target = null;
    mocks.scopeEnvironmentId = null;
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

  it("shows LaTeX and Markdown side by side, then Word export", async () => {
    await render();
    const strip = container.querySelector('[aria-label="Document formats"]')!;
    expect(strip.textContent).toContain("LaTeX");
    expect(strip.textContent).toContain("Installed");
    expect(strip.textContent).toContain("Markdown");
    expect(container.querySelector("#latex-installation")?.textContent).toContain(
      "latexmk 4.85 · This computer",
    );
    expect(container.textContent).toContain("Word export (Pandoc)");
  });

  it("starts new documents Blank and English, and remembers another choice", async () => {
    await render();
    expect(select("Template for new documents").textContent).toBe("Blank");
    expect(select("Language for new documents").textContent).toBe("English");
    await choose("Template for new documents", "Thesis");
    await choose("Language for new documents", "Hebrew");
    expect(stored("scient.newDocumentTemplate")).toBe("thesis");
    expect(stored("scient.newDocumentLanguage")).toBe("hebrew");
    expect(select("Template for new documents").textContent).toBe("Thesis");
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
      container.querySelector<HTMLElement>('[aria-label="Find LaTeX again"]')!.click(),
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
});
