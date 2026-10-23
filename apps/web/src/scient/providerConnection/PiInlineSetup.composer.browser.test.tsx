import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { expect, it, vi } from "vite-plus/test";
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
  signInKey: {
    environmentId: "environment-test",
    instanceId: "sign-in-test",
  } as ProviderLifecycleController["signInKey"],
  openAuthorizationPage: vi.fn(),
  updateExternalRuntime: vi.fn(),
  refresh: vi.fn(),
};

async function _setupFixture0(_fixture: _Fixture) {
  vi.clearAllMocks();

  _fixture.host = document.createElement("div");
  _fixture.host.dataset.modelPickerContent = "true";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.host.remove();
  vi.unstubAllGlobals();
}
async function render(_fixture: _Fixture, value = provider, composer = true) {
  await act(
    async () =>
      await _fixture.root0.rerender(
        <PiInlineSetup
          environmentId={EnvironmentId.make("local")}
          provider={value}
          displayName="Pi"
          {...(composer ? { composerController: controller } : {})}
        />,
      ),
  );
}
async function click(_fixture: _Fixture, text: string) {
  const button = [..._fixture.host.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === text,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it("presents the shared composer setup and uses the reviewed install plan", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

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
  await render(_fixture);
  expect(_fixture.host.textContent).toContain("Install Pi");
  expect(_fixture.host.textContent).not.toContain("Management runtime controls");
  expect(_fixture.host.querySelector('[data-provider-onboarding-view="assisted"]')).not.toBeNull();
  await click(_fixture, "Install");
  expect(controller.planRuntime).toHaveBeenCalledWith("install");
  expect(controller.startRuntime).toHaveBeenCalledWith(plan);
});
it("shows a failed installation and allows retry", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  vi.mocked(controller.planRuntime).mockRejectedValueOnce(new Error("Download unavailable"));
  await render(_fixture);
  await click(_fixture, "Install");
  expect(_fixture.host.querySelector('[role="alert"]')?.textContent).toContain(
    "Download unavailable",
  );
  await click(_fixture, "Retry installation");
  expect(controller.planRuntime).toHaveBeenCalledTimes(2);
});
it("keeps management controls on the management surface", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, provider, false);
  expect(_fixture.host.textContent).toContain("Management runtime controls");
});
it("does not offer install when the environment does not support it", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, {
    ...provider,
    connection: {
      ...provider.connection!,
      runtime: { ...provider.connection!.runtime!, actions: [] },
    },
  });
  expect(_fixture.host.textContent).toContain("existing Pi installation");
  expect(_fixture.host.querySelector("button")).toBeNull();
});

it("shows progress and cancels the exact active operation", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, {
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
  expect(_fixture.host.querySelector('[role="status"]')?.textContent).toContain("Downloading Pi");
  expect(_fixture.host.textContent).not.toContain("Management runtime controls");
  await click(_fixture, "Cancel");
  expect(controller.cancelRuntime).toHaveBeenCalledWith("pi-install");
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
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
