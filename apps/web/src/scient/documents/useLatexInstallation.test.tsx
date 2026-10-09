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
let install: () => void = () => undefined;
let refresh: () => Promise<void> = async () => undefined;
function Watch() {
  const controller = useLatexInstallation(EnvironmentId.make("local"));
  kind = controller.view.kind;
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
