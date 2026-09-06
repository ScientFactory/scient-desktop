// @vitest-environment happy-dom
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PiInlineSetup } from "./PiInlineSetup";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

vi.mock("./ProviderRuntimeSection", () => ({
  ProviderRuntimeSection: () => <div>Management runtime controls</div>,
}));
vi.mock("./ConnectModelsButton", () => ({
  ConnectModelsButton: () => <button>Connect models</button>,
}));

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("pi"),
  driver: ProviderDriverKind.make("pi"),
  enabled: true,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-09-06T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: [],
    canDisconnect: false,
    operation: null,
    runtime: {
      source: "missing",
      supportTier: "fully_assisted",
      target: "darwin-arm64",
      actions: ["install"],
      managedVersion: null,
      previousManagedVersion: null,
      operation: null,
      message: "Pi is not installed.",
    },
  },
};
const controller: ProviderLifecycleController = {
  planRuntime: vi.fn(),
  startRuntime: vi.fn(),
  cancelRuntime: vi.fn(),
  startConnection: vi.fn(),
  cancelConnection: vi.fn(),
  submitAuthorizationCode: vi.fn(),
  disconnect: vi.fn(),
  openAuthorizationPage: vi.fn(),
  updateExternalRuntime: vi.fn(),
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  host.dataset.modelPickerContent = "true";
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(value = provider, composer = true) {
  await act(() =>
    root.render(
      <PiInlineSetup
        environmentId={EnvironmentId.make("local")}
        provider={value}
        displayName="Pi"
        {...(composer ? { composerController: controller } : {})}
      />,
    ),
  );
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === text,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it("presents the shared composer setup and uses the reviewed install plan", async () => {
  const plan = {
    instanceId: provider.instanceId,
    action: "install" as const,
    target: "darwin-arm64",
    version: "0.84.4",
    downloadBytes: null,
    sourceLabel: "Official Pi release",
    catalogRevision: "qualified-revision",
    message: "Install Pi",
  };
  vi.mocked(controller.planRuntime).mockResolvedValueOnce(plan);
  await render();
  expect(host.textContent).toContain("Install Pi");
  expect(host.textContent).not.toContain("Management runtime controls");
  expect(host.querySelector('[data-provider-onboarding-view="assisted"]')).not.toBeNull();
  await click("Install");
  expect(controller.planRuntime).toHaveBeenCalledWith("install");
  expect(controller.startRuntime).toHaveBeenCalledWith(plan);
});
it("shows a failed installation and allows retry", async () => {
  vi.mocked(controller.planRuntime).mockRejectedValueOnce(new Error("Download unavailable"));
  await render();
  await click("Install");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Download unavailable");
  await click("Retry installation");
  expect(controller.planRuntime).toHaveBeenCalledTimes(2);
});
it("keeps management controls on the management surface", async () => {
  await render(provider, false);
  expect(host.textContent).toContain("Management runtime controls");
});
it("does not offer install when the environment does not support it", async () => {
  await render({
    ...provider,
    connection: {
      ...provider.connection!,
      runtime: { ...provider.connection!.runtime!, actions: [] },
    },
  });
  expect(host.textContent).toContain("existing Pi installation");
  expect(host.querySelector("button")).toBeNull();
});

it("shows progress and cancels the exact active operation", async () => {
  await render({
    ...provider,
    connection: {
      ...provider.connection!,
      runtime: {
        ...provider.connection!.runtime!,
        operation: {
          operationId: "pi-install",
          action: "install",
          status: "downloading",
          startedAt: "2026-09-06T00:00:00.000Z",
          finishedAt: null,
          message: "Downloading Pi…",
        },
      },
    },
  });
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Downloading Pi");
  expect(host.textContent).not.toContain("Management runtime controls");
  await click("Cancel");
  expect(controller.cancelRuntime).toHaveBeenCalledWith("pi-install");
});
