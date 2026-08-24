import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { CodexInlineSetup } from "./CodexInlineSetup";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const INSTANCE_ID = ProviderInstanceId.make("codex");

const provider = (patch: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: INSTANCE_ID,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "0.147.0",
  status: "warning",
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-08-11T20:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["codex_browser", "codex_device_code"],
    canDisconnect: false,
    operation: null,
    runtime: {
      source: "system",
      supportTier: "fully_assisted",
      target: "darwin-arm64",
      actions: ["install"],
      managedVersion: null,
      previousManagedVersion: null,
      operation: null,
      message: "Scient is using a capability-proven system Codex runtime.",
      diagnostics: {
        executable: "codex",
        version: "0.147.0",
        homePath: null,
        backend: "macOS native",
      },
    },
  },
  ...patch,
});

const runtimePlan: ProviderRuntimePlan = {
  instanceId: INSTANCE_ID,
  action: "install",
  target: "darwin-arm64",
  version: "0.147.0",
  downloadBytes: 1,
  sourceLabel: "Official OpenAI Codex release on GitHub",
  catalogRevision: "reviewed:0.147.0",
  message: "Install Codex.",
};

function controller(): ProviderLifecycleController {
  return {
    startConnection: vi.fn(async () => provider()),
    cancelConnection: vi.fn(async () => provider()),
    submitAuthorizationCode: vi.fn(async () => provider()),
    disconnect: vi.fn(async () => provider()),
    openAuthorizationPage: vi.fn(async () => undefined),
    planRuntime: vi.fn(async () => runtimePlan),
    startRuntime: vi.fn(async () => provider()),
    cancelRuntime: vi.fn(async () => provider()),
    updateExternalRuntime: vi.fn(async () => provider()),
  };
}

function render(value: ServerProvider, managedRuntimePresentedExternally = false): string {
  return renderToStaticMarkup(
    <CodexInlineSetup
      controller={controller()}
      displayName="Codex"
      managedRuntimePresentedExternally={managedRuntimePresentedExternally}
      provider={value}
    />,
  );
}

describe("CodexInlineSetup", () => {
  it("keeps browser sign-in primary and exposes device code as a fallback", () => {
    const markup = render(provider());

    expect(markup).toContain(
      "Sign in with your existing ChatGPT subscription. Scient never sees your password.",
    );
    expect(markup).toContain("Sign in with ChatGPT");
    expect(markup).toContain("Use device code");
    expect(markup).not.toContain("The secure flow opens in your browser");
  });

  it("shows and labels the active Codex device code", () => {
    const markup = render(
      provider({
        connection: {
          ...provider().connection!,
          operation: {
            operationId: "connection-device",
            method: "codex_device_code",
            status: "waiting_for_device_code",
            startedAt: "2026-08-11T20:00:00.000Z",
            finishedAt: null,
            message: "Enter the code.",
            authorizationUrl: "https://auth.openai.com/device",
            userCode: "ABCD-EFGH",
          },
        },
      }),
    );

    expect(markup).toContain("ABCD-EFGH");
    expect(markup).toContain('aria-label="Copy Codex device code"');
    expect(markup).toContain("Reopen sign-in page");
  });

  it("keeps managed installation compact without synthetic progress", () => {
    const markup = render(
      provider({
        connection: {
          ...provider().connection!,
          runtime: {
            ...provider().connection!.runtime!,
            operation: {
              operationId: "runtime-install",
              action: "install",
              status: "downloading",
              startedAt: "2026-08-11T20:00:00.000Z",
              finishedAt: null,
              message: "Downloading Codex.",
              downloadedBytes: 1,
              totalBytes: 2,
            },
          },
        },
      }),
    );

    expect(markup).toContain("Installing Codex");
    expect(markup).toContain("Downloading Codex…");
    expect(markup).toContain(">Cancel<");
    expect(markup).toContain("text-destructive/80");
    expect(markup).not.toContain("progressbar");
    expect(markup).toContain("space-y-3 px-6 pb-4");
  });

  it("keeps the connected account action in the ready row", () => {
    const markup = renderToStaticMarkup(
      <CodexInlineSetup
        accountAction={<button type="button">Sign out</button>}
        controller={controller()}
        displayName="Codex"
        provider={provider({ auth: { status: "authenticated", required: true } })}
      />,
    );

    expect(markup).toContain("Codex is ready");
    expect(markup).toContain('href="https://chatgpt.com/#settings/Subscription"');
    expect(markup).toContain('aria-label="ChatGPT subscription settings (opens in browser)"');
    expect(markup).toContain(">Sign out<");
  });

  it("offers repair only when the server advertises managed repair", () => {
    const managed = provider({
      auth: { status: "authenticated", required: true },
      connection: {
        ...provider().connection!,
        runtime: {
          ...provider().connection!.runtime!,
          source: "scient_managed",
          actions: ["repair", "remove"],
          managedVersion: "0.147.0",
        },
      },
    });
    const system = provider({ auth: { status: "authenticated", required: true } });

    expect(render(managed)).toContain("Repair</button>");
    expect(render(system)).not.toContain("Repair</button>");
  });

  it("states that Scient is confirming sign-in with Codex during account verification", () => {
    const markup = render(
      provider({
        connection: {
          ...provider().connection!,
          operation: {
            operationId: "connection-1",
            method: "codex_browser",
            status: "verifying",
            startedAt: "2026-08-11T20:00:00.000Z",
            finishedAt: null,
            message: "Confirming sign-in.",
          },
        },
      }),
    );

    expect(markup).toContain("Checking your account");
    expect(markup).toContain("Confirming sign-in with Codex…");
  });

  it("offers managed recovery for an automatically selected system runtime", () => {
    expect(render(provider())).toContain("Use Scient-managed Codex");
    expect(render(provider(), true)).not.toContain("Use Scient-managed Codex");
  });

  it("does not offer a managed switch when the server exposes no install action", () => {
    const withoutInstall = provider({
      connection: {
        ...provider().connection!,
        runtime: {
          ...provider().connection!.runtime!,
          actions: [],
        },
      },
    });

    expect(render(withoutInstall)).not.toContain("Use Scient-managed Codex");
    expect(render(withoutInstall)).toContain("System");
  });
});
