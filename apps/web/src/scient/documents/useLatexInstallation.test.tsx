// @vitest-environment happy-dom
import {
  EnvironmentId,
  type ScientLatexManagedInstallState,
  type ScientLatexToolchainReport,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

let kind = "";
let summary = "";
let lastReport: ScientLatexToolchainReport | null = null;
let install: () => void = () => undefined;
let refresh: () => Promise<void> = async () => undefined;
function Watch() {
  const controller = useLatexInstallation(EnvironmentId.make("local"));
  kind = controller.view.kind;
  summary = controller.view.summary;
  lastReport = controller.report;
  install = controller.act;
  refresh = controller.refresh;
  return null;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  readLatexToolchain.mockReset();
  requestLatexToolchainInstall.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useLatexInstallation answers that arrive out of order", () => {
  it("never installs during mount, refresh, or passive status polling", async () => {
    readLatexToolchain.mockResolvedValue(missing);
    await act(async () => root.render(<Watch />));
    await act(async () => refresh());
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(requestLatexToolchainInstall).not.toHaveBeenCalled();
    expect(kind).toBe("missing");
  });

  it("ignores an install action when all standalone compilers are already available", async () => {
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
    await act(async () => root.render(<Watch />));
    await act(() => install());
    expect(requestLatexToolchainInstall).not.toHaveBeenCalled();
    expect(kind).toBe("ready");
  });

  it("retains existing tool capabilities if an optional install request fails, and permits retry", async () => {
    const tectonic = { ...missing, kind: "tectonic" as const, executable: "tectonic" };
    readLatexToolchain.mockResolvedValue(tectonic);
    requestLatexToolchainInstall.mockRejectedValueOnce(new Error("Connection interrupted"));
    await act(async () => root.render(<Watch />));
    await act(async () => install());
    expect(kind).toBe("failed");
    expect(summary).toBe("Ready");
    expect(lastReport).toEqual(tectonic);
    requestLatexToolchainInstall.mockResolvedValueOnce(downloading);
    await act(async () => install());
    expect(requestLatexToolchainInstall).toHaveBeenCalledTimes(2);
    expect(kind).toBe("installing");
    expect(summary).toBe("Ready");
    expect(lastReport?.kind).toBe("tectonic");
  });

  it("lets the install's answer lead over a check that finished before the server saw it", async () => {
    readLatexToolchain.mockResolvedValueOnce(missing);
    await act(async () => root.render(<Watch />));
    expect(kind).toBe("missing");
    let acknowledge!: (value: ScientLatexManagedInstallState) => void;
    requestLatexToolchainInstall.mockReturnValueOnce(
      new Promise<ScientLatexManagedInstallState>((resolve) => (acknowledge = resolve)),
    );
    await act(async () => install());
    expect(kind).toBe("installing");
    readLatexToolchain.mockResolvedValueOnce(missing);
    await act(async () => refresh());
    expect(kind).toBe("installing");
    await act(async () => acknowledge(downloading));
    expect(kind).toBe("installing");
    readLatexToolchain.mockResolvedValue({ ...missing, managedInstall: downloading });
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(readLatexToolchain).toHaveBeenCalledTimes(3);
    expect(kind).toBe("installing");
  });
});
