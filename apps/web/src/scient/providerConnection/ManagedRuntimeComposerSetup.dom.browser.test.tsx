import type { ReactNode } from "react";
import { render as _fixtureRender, type Screen } from "../../../test/render";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";

import { PiInlineSetup } from "./PiInlineSetup";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

type Runtime = NonNullable<NonNullable<ServerProvider["connection"]>["runtime"]>;

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
  const render = async (_fixture: _Fixture, provider: ServerProvider) =>
    await _renderMarkup(
      _fixture,
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

  it("describes a system installation as ready without offering the managed runtime", async () => {
    await using _fixture = _createFixture();

    const markup = await render(
      _fixture,
      withRuntime(base, { source: "system", actions: ["install"], managedVersion: null }),
    );
    expect(markup).toContain(`${name} is ready`);
    expect(markup).toContain(`Using ${name} 1.2.3 installed on this Mac.`);
    expect(markup).not.toContain("Scient-managed");
    expect(buttons(markup)).toEqual([{ variant: "ghost-primary", label: "Connect models" }]);
  });

  // regression: c66c948db0 chore(upstream): merge t3 through 81dea7821d
  it("offers installation, or explains when this computer cannot install it", async () => {
    await using _fixture = _createFixture();

    const missing = withRuntime(
      { ...base, installed: false, version: null, status: "warning", models: [] },
      { source: "missing", actions: ["install"], managedVersion: null },
    );
    const markup = await render(_fixture, missing);
    expect(markup).toContain(`Install ${name}`);
    expect(markup).toContain(`${name} is not installed on this Mac.`);
    expect(buttons(markup)).toEqual([{ variant: "ghost-primary", label: "Install" }]);

    const unsupported = await render(_fixture, withRuntime(missing, { actions: [] }));
    expect(unsupported).toContain(`existing ${name} installation`);
    expect(buttons(unsupported)).toEqual([]);
  });

  it("puts Connect models inside the frame when no model is available", async () => {
    await using _fixture = _createFixture();

    const markup = await render(_fixture, {
      ...base,
      status: "warning",
      models: [],
      message: "No models.",
    });
    expect(frames(markup)).toHaveLength(1);
    expect(markup).toContain("Connect a model provider");
    expect(markup).toContain("/login in Pi");
    expect(buttons(markup)).toEqual([{ variant: "ghost-primary", label: "Connect models" }]);
  });

  it("reports a model discovery failure with its server message", async () => {
    await using _fixture = _createFixture();

    const markup = await render(
      _fixture,
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

async function _renderMarkup(_fixture: _Fixture, ui: ReactNode): Promise<string> {
  const screen = _fixture.stack.use(await _fixtureRender(ui, { router: false }));
  return screen.container.innerHTML;
}
