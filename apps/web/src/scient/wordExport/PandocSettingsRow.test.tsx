// @vitest-environment happy-dom
import { EnvironmentId, type ScientPandocToolStatus } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

let lastSummary = "";
let refreshWordTab: () => void = () => undefined;
function WordTab() {
  const controller = usePandocTool(EnvironmentId.make("local"));
  lastSummary = pandocToolSummary(controller.view);
  refreshWordTab = controller.refresh;
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

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  readPandocTool.mockReset();
  installPandocTool.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(<WordTab />));

describe("PandocSettingsRow", () => {
  it("names the Pandoc release, its licence, and links its exact source", async () => {
    readPandocTool.mockResolvedValue(status());
    await render();
    expect(container.querySelector("#word-export")).not.toBeNull();
    const line = container.querySelector('[data-testid="status"]');
    expect(line?.textContent).toBe("Pandoc 3.11 · GPL-2.0-or-later · Source code");
    const link = line?.querySelector("a");
    expect(link?.getAttribute("href")).toBe(SOURCE);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(link?.getAttribute("aria-label")).toBe("Pandoc 3.11 source code (opens in browser)");
  });

  it("leaves out the link for a server that does not name the source", async () => {
    const { license: _license, sourceUrl: _sourceUrl, ...older } = status();
    readPandocTool.mockResolvedValue(older);
    await render();
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("Pandoc 3.11");
    expect(container.querySelector("a")).toBeNull();
  });

  it("offers a reinstall when the installed Pandoc could not be started", async () => {
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
    await render();
    expect(container.textContent).toContain(
      "Pandoc could not be started. Reinstall it to export to Word.",
    );
    const reinstall = container.querySelector("button");
    expect(reinstall?.textContent).toBe("Reinstall Pandoc (40 MB)");
    expect(reinstall?.type).toBe("button");
    expect(reinstall?.disabled).toBe(false);
    reinstall?.focus();
    expect(document.activeElement).toBe(reinstall);
    await act(async () => reinstall?.click());
    expect(installPandocTool).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Downloading Pandoc");
  });

  it("says Pandoc's state in a few words under the Word tab", async () => {
    readPandocTool.mockResolvedValue(status());
    await render();
    expect(container.querySelector("h3")?.textContent).toBe("Pandoc");
    expect(container.querySelector("p")?.textContent).toBe("Installed");
    readPandocTool.mockResolvedValue(status({ installed: false }));
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.querySelector("p")?.textContent).toBe("Not installed · 40 MB");
  });

  it("waits for a running check before installing, so an older answer cannot undo the install", async () => {
    readPandocTool.mockResolvedValue(status({ installed: false }));
    await render();
    let answer!: (value: ScientPandocToolStatus) => void;
    readPandocTool.mockImplementationOnce(
      () => new Promise<ScientPandocToolStatus>((resolve) => (answer = resolve)),
    );
    await act(async () => refreshWordTab());
    const install = container.querySelector("button")!;
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
    await act(async () => container.querySelector("button")!.click());
    expect(installPandocTool).toHaveBeenCalledTimes(1);
    expect(lastSummary).toBe("Installing…");
  });

  it("says Not checked, not Not installed, when only the check failed", async () => {
    readPandocTool.mockResolvedValue(status());
    await render();
    expect(lastSummary).toBe("Ready");
    readPandocTool.mockRejectedValueOnce(new Error("The server did not answer."));
    await act(async () => refreshWordTab());
    expect(lastSummary).toBe("Not checked");
    expect(container.textContent).toContain("The server did not answer.");
    expect(container.querySelector("button")?.textContent).toBe("Check again");
  });
});
