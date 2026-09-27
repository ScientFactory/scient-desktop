// @vitest-environment happy-dom
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PiInlineSetup } from "./PiInlineSetup";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

vi.mock("./ProviderRuntimeSection", () => ({
  ProviderRuntimeSection: () => <div>Management runtime controls</div>,
}));

type Runtime = NonNullable<NonNullable<ServerProvider["connection"]>["runtime"]>;

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

const driver = "pi";
const name = "Pi";

function ready(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    displayName: name,
    enabled: true,
    installed: true,
    version: "1.2.3",
    status: "ready",
    auth: { status: "unknown", required: false },
    checkedAt: "2026-09-27T00:00:00.000Z",
    models: [{ slug: "a/model", name: "Model", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    connection: {
      methods: [],
      canDisconnect: false,
      operation: null,
      runtime: {
        source: "scient_managed",
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions: ["repair", "remove"],
        managedVersion: "1.2.3",
        previousManagedVersion: null,
        operation: null,
        message: `Scient is using its private ${name} runtime.`,
      },
    },
  };
}

function withRuntime(provider: ServerProvider, patch: Partial<Runtime>): ServerProvider {
  return {
    ...provider,
    connection: {
      ...provider.connection!,
      runtime: { ...provider.connection!.runtime!, ...patch },
    },
  };
}

describe("Pi composer setup", () => {
  const base = ready();
  const render = (provider: ServerProvider) =>
    renderToStaticMarkup(
      <PiInlineSetup
        composerController={controller}
        displayName={name}
        environmentId={EnvironmentId.make("local")}
        provider={provider}
      />,
    );
  const frames = (markup: string) => markup.match(/data-provider-onboarding-view="assisted"/g);
  const buttons = (markup: string) =>
    [...markup.matchAll(/<button[^>]*data-variant="([^"]+)"[^>]*>(.*?)<\/button>/g)].map(
      ([, variant, body]) => ({ variant, label: body!.replace(/<[^>]+>/g, "") }),
    );

  it("shows one ready frame whose only action connects models", () => {
    const markup = render(base);
    expect(frames(markup)).toHaveLength(1);
    expect(markup).toContain(`${name} is ready`);
    expect(markup).toContain(`Using Scient-managed ${name} 1.2.3.`);
    expect(markup).toContain("lucide-circle-check");
    expect(buttons(markup)).toEqual([{ variant: "ghost-primary", label: "Connect models" }]);
    expect(markup).not.toContain("Management runtime controls");
    expect(markup).not.toContain("Remove");
    expect(markup).not.toContain("Repair");
  });

  it("describes a system installation as ready without offering the managed runtime", () => {
    const markup = render(
      withRuntime(base, { source: "system", actions: ["install"], managedVersion: null }),
    );
    expect(markup).toContain(`${name} is ready`);
    expect(markup).toContain(`Using ${name} 1.2.3 installed on this Mac.`);
    expect(markup).not.toContain("Scient-managed");
    expect(buttons(markup)).toEqual([{ variant: "ghost-primary", label: "Connect models" }]);
  });

  it("puts Connect models inside the frame when no model is available", () => {
    const markup = render({ ...base, status: "warning", models: [], message: "No models." });
    expect(frames(markup)).toHaveLength(1);
    expect(markup).toContain("Connect a model provider");
    expect(markup).toContain("/login in Pi");
    expect(buttons(markup)).toEqual([{ variant: "ghost-primary", label: "Connect models" }]);
  });

  it("reports a model discovery failure with its server message", () => {
    const markup = render(
      withRuntime(
        { ...base, status: "error", models: [], message: `${name} RPC timed out.` },
        { source: "system", actions: [], managedVersion: null },
      ),
    );
    expect(markup).toContain(`Could not load ${name} models`);
    expect(markup).toContain(`${name} RPC timed out.`);
    expect(markup).toContain('role="alert"');
    expect(buttons(markup)).toEqual([{ variant: "ghost-primary", label: "Connect models" }]);
  });

  it("offers the reviewed managed update as the single action", () => {
    const markup = render(withRuntime(base, { actions: ["update", "repair", "remove"] }));
    expect(markup).toContain(`${name} update available`);
    expect(buttons(markup)).toEqual([{ variant: "ghost-primary", label: `Update ${name}` }]);
  });

  it("asks for repair with the server's error and a warning icon", () => {
    const markup = render({
      ...base,
      status: "error",
      models: [],
      message: `${name}'s private runtime could not start: exit 1.`,
    });
    expect(markup).toContain(`${name} needs repair`);
    expect(markup).toContain(`${name}&#x27;s private runtime could not start: exit 1.`);
    expect(markup).toContain("lucide-triangle-alert");
    expect(markup).not.toContain("Connect models");
    expect(buttons(markup)).toEqual([{ variant: "ghost-primary", label: `Repair ${name}` }]);
  });

  it("offers installation, or explains when this computer cannot install it", () => {
    const missing = withRuntime(
      { ...base, installed: false, version: null, status: "warning", models: [] },
      { source: "missing", actions: ["install"], managedVersion: null },
    );
    const markup = render(missing);
    expect(markup).toContain(`Install ${name}`);
    expect(markup).toContain(`${name} is not installed on this Mac.`);
    expect(buttons(markup)).toEqual([{ variant: "ghost-primary", label: "Install" }]);

    const unsupported = render(withRuntime(missing, { actions: [] }));
    expect(unsupported).toContain(`existing ${name} installation`);
    expect(buttons(unsupported)).toEqual([]);
  });

  it("shows a failed installation with a retry", () => {
    const markup = render(
      withRuntime(
        { ...base, installed: false, version: null, status: "warning", models: [] },
        {
          source: "missing",
          actions: ["install"],
          managedVersion: null,
          operation: {
            operationId: "install-1",
            action: "install",
            status: "failed",
            startedAt: "2026-09-27T00:00:00.000Z",
            finishedAt: "2026-09-27T00:00:01.000Z",
            message: "Checksum mismatch.",
          },
        },
      ),
    );
    expect(markup).toContain(`${name} installation couldn’t finish`);
    expect(markup).toContain("Checksum mismatch.");
    expect(buttons(markup)).toEqual([{ variant: "ghost-primary", label: "Retry installation" }]);
  });

  it("shows installation progress with Cancel as the single action", () => {
    const markup = render(
      withRuntime(
        { ...base, installed: false, version: null, status: "warning", models: [] },
        {
          source: "missing",
          actions: ["install"],
          managedVersion: null,
          operation: {
            operationId: "install-1",
            action: "install",
            status: "downloading",
            startedAt: "2026-09-27T00:00:00.000Z",
            finishedAt: null,
            message: `Downloading ${name}…`,
            downloadedBytes: 42,
            totalBytes: 100,
          },
        },
      ),
    );
    expect(markup).toContain(`Installing ${name}`);
    expect(markup).toContain(`Downloading ${name}…`);
    expect(markup).toContain("animate-spin");
    expect(markup).not.toContain("42%");
    expect(buttons(markup)).toEqual([{ variant: "ghost-destructive-action", label: "Cancel" }]);
  });
});

describe("managed runtime composer actions", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("plans and starts the reviewed Pi update", async () => {
    const plan = {
      instanceId: ProviderInstanceId.make(driver),
      action: "update" as const,
      target: "darwin-arm64",
      version: "1.3.0",
      downloadBytes: null,
      sourceLabel: "Official release",
      catalogRevision: "revision",
      message: `Update ${name}`,
    };
    vi.mocked(controller.planRuntime).mockResolvedValueOnce(plan);
    await act(() =>
      root.render(
        <PiInlineSetup
          composerController={controller}
          displayName={name}
          environmentId={EnvironmentId.make("local")}
          provider={withRuntime(ready(), { actions: ["update", "repair", "remove"] })}
        />,
      ),
    );
    const button = [...host.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === `Update ${name}`,
    );
    await act(async () => button!.click());
    expect(controller.planRuntime).toHaveBeenCalledWith("update");
    expect(controller.startRuntime).toHaveBeenCalledWith(plan);
  });

  it("keeps Pi's runtime management on the management surface", async () => {
    await act(() =>
      root.render(
        <PiInlineSetup
          displayName="Pi"
          environmentId={EnvironmentId.make("local")}
          provider={ready()}
        />,
      ),
    );
    expect(host.textContent).toContain("Management runtime controls");
    expect(host.textContent).not.toContain("Pi is ready");
  });
});
