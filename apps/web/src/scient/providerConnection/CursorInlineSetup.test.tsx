import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { CursorInlineSetup } from "./CursorInlineSetup";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const INSTANCE_ID = ProviderInstanceId.make("cursor");

const provider = (patch: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: INSTANCE_ID,
  driver: ProviderDriverKind.make("cursor"),
  enabled: true,
  installed: true,
  version: "2026.08.11-e8db854",
  status: "warning",
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-08-23T08:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["cursor_browser"],
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
      message: "Scient is using a system Cursor runtime.",
      diagnostics: {
        executable: "cursor-agent",
        version: "2026.08.11-e8db854",
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
  version: "2026.08.11-e8db854",
  downloadBytes: 1,
  sourceLabel: "Official Cursor Agent release",
  catalogRevision: "reviewed:2026.08.11-e8db854",
  message: "Install Cursor.",
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
    refresh: vi.fn(async () => provider()),
  };
}

function render(value: ServerProvider, managedRuntimePresentedExternally = false): string {
  return renderToStaticMarkup(
    <CursorInlineSetup
      controller={controller()}
      displayName="Cursor"
      managedRuntimePresentedExternally={managedRuntimePresentedExternally}
      provider={value}
    />,
  );
}

describe("CursorInlineSetup", () => {
  it("offers the single truthful browser sign-in flow", () => {
    const markup = render(provider());

    expect(markup).toContain("Sign in to Cursor");
    expect(markup).toContain("Scient never sees your password.");
    expect(markup).toContain("border-transparent");
    expect(markup).toContain("text-primary");
    expect(markup).not.toContain("text-primary-foreground");
    expect(markup).not.toContain("device code");
    expect(markup).not.toContain("Paste code");
  });

  it("does not offer a CLI switch as SDK sign-in recovery", () => {
    const failedSignIn = provider({
      connection: {
        ...provider().connection!,
        operation: {
          operationId: "cursor-login-failed",
          method: "cursor_browser",
          status: "failed",
          startedAt: "2026-08-23T08:00:00.000Z",
          finishedAt: "2026-08-23T08:01:00.000Z",
          message: "Cursor could not complete sign-in.",
        },
      },
    });

    // CLI management never becomes a remedy for SDK account sign-in.
    expect(render(provider())).not.toContain("Runtime diagnostics");
    expect(render(failedSignIn)).not.toContain("Use Scient-managed Cursor");
    expect(render(failedSignIn)).toContain("Cursor sign-in didn’t finish");
    expect(render(failedSignIn, true)).not.toContain("Use Scient-managed Cursor");
  });

  it("keeps SDK catalog failures separate from a healthy managed CLI", () => {
    const markup = render(
      provider({
        status: "error",
        auth: { status: "unknown", required: true },
        message: "Cursor model lookup failed: network unavailable.",
        connection: {
          ...provider().connection!,
          runtime: {
            ...provider().connection!.runtime!,
            source: "scient_managed",
            managedVersion: "2026.08.11-e8db854",
            actions: ["repair", "remove"],
          },
        },
      }),
    );
    expect(markup).toContain("Cursor needs attention");
    expect(markup).toContain("Cursor model lookup failed: network unavailable.");
    expect(markup).not.toContain("Repair Cursor");
    expect(markup).not.toContain("Use Scient-managed");
  });

  it("preserves repair after an explicitly attempted CLI operation fails", () => {
    const markup = render(
      provider({
        connection: {
          ...provider().connection!,
          runtime: {
            ...provider().connection!.runtime!,
            source: "scient_managed",
            managedVersion: "2026.08.11-e8db854",
            actions: ["repair", "remove"],
            operation: {
              operationId: "cursor-cli-repair-failed",
              action: "repair",
              status: "failed",
              startedAt: "2026-08-23T08:00:00.000Z",
              finishedAt: "2026-08-23T08:01:00.000Z",
              message: "Cursor CLI archive verification failed.",
            },
          },
        },
      }),
    );
    expect(markup).toContain("Cursor CLI needs repair");
    expect(markup).toContain("Cursor CLI archive verification failed.");
    expect(markup).toContain("Repair Cursor CLI");
  });

  it("uses the Cursor mark for composer installation while preserving dialog status styling", () => {
    const markup = render(
      provider({
        installed: false,
        status: "error",
        connection: {
          ...provider().connection!,
          runtime: {
            ...provider().connection!.runtime!,
            source: "missing",
            actions: ["install"],
          },
        },
      }),
    );

    expect(markup).toContain("Install Cursor");
    expect(markup).toContain('viewBox="0 0 466.73 532.09"');
    expect(markup).toContain("in-[[data-model-picker-content=true]]:inline-flex");
    expect(markup).toContain("in-[[data-model-picker-content=true]]:hidden");
  });

  it("keeps managed installation compact without synthetic progress", () => {
    const markup = render(
      provider({
        connection: {
          ...provider().connection!,
          runtime: {
            ...provider().connection!.runtime!,
            source: "scient_managed",
            actions: ["repair", "remove"],
            managedVersion: "2026.08.11-e8db854",
            operation: {
              operationId: "runtime-install",
              action: "install",
              status: "downloading",
              startedAt: "2026-08-23T08:00:00.000Z",
              finishedAt: null,
              message: "Downloading Cursor.",
              downloadedBytes: 1,
              totalBytes: 2,
            },
          },
        },
      }),
    );

    expect(markup).toContain("Installing Cursor CLI");
    expect(markup).toContain("Downloading Cursor.");
    expect(markup).not.toContain('viewBox="0 0 466.73 532.09"');
    expect(markup.match(/animate-spin/g)).toHaveLength(1);
    expect(markup).toContain(">Cancel<");
    expect(markup).toContain("text-destructive/80");
    expect(markup).not.toContain("progressbar");
    expect(markup).toContain('data-provider-onboarding-view="assisted"');
    // The status icon is the only spinner: no second one beside the title.
    expect(markup.match(/animate-spin/g)).toHaveLength(1);
  });

  it("shows the explicitly requested CLI activation", () => {
    const markup = render(
      provider({
        connection: {
          ...provider().connection!,
          runtime: {
            ...provider().connection!.runtime!,
            source: "scient_managed",
            actions: ["repair", "remove"],
            managedVersion: "2026.08.11-e8db854",
            operation: {
              operationId: "runtime-install",
              action: "install",
              status: "activating",
              startedAt: "2026-08-23T08:00:00.000Z",
              finishedAt: null,
              message: "Activating Cursor.",
            },
          },
        },
      }),
    );

    expect(markup).toContain("Installing Cursor CLI");
    expect(markup).toContain("Activating Cursor.");
  });

  it("shows the account identity and sign-out action in the ready row", () => {
    const markup = renderToStaticMarkup(
      <CursorInlineSetup
        accountAction={<button type="button">Sign out</button>}
        controller={controller()}
        displayName="Cursor"
        provider={provider({
          status: "ready",
          auth: {
            status: "authenticated",
            required: true,
            email: "cursor@example.com",
            label: "Cursor Pro Subscription",
          },
          models: [
            {
              slug: "cursor-auto",
              name: "Auto",
              isCustom: false,
              capabilities: null,
            },
          ],
        })}
      />,
    );

    expect(markup).toContain("Cursor is ready");
    expect(markup).toContain("cursor@example.com · Cursor Pro Subscription");
    expect(markup).toContain(">Sign out<");
  });

  it("does not invent browser sign-in for externally configured instances", () => {
    const markup = render(
      provider({
        connection: {
          ...provider().connection!,
          methods: [],
        },
      }),
    );

    expect(markup).toContain("Custom Cursor setup");
    expect(markup).not.toContain("Sign in to Cursor");
  });

  it("reopens the captured Cursor authorization page while sign-in is active", () => {
    const markup = render(
      provider({
        connection: {
          ...provider().connection!,
          operation: {
            operationId: "cursor-login",
            method: "cursor_browser",
            status: "waiting_for_browser",
            startedAt: "2026-08-23T08:00:00.000Z",
            finishedAt: null,
            message: "Finish sign in.",
            authorizationUrl: "https://cursor.com/loginDeepControl",
            authorizationUrlKind: "primary",
          },
        },
      }),
    );

    expect(markup).toContain("Finish signing in");
    expect(markup).toContain("Reopen Cursor sign-in");
    expect(markup).toContain(">Cancel<");
    // The status icon is the only spinner: no second one beside the title.
    expect(markup.match(/animate-spin/g)).toHaveLength(1);
  });

  it("shows model discovery while verifying a completed sign-in", () => {
    const markup = render(
      provider({
        connection: {
          ...provider().connection!,
          operation: {
            operationId: "cursor-login",
            method: "cursor_browser",
            status: "verifying",
            startedAt: "2026-08-23T08:00:00.000Z",
            finishedAt: null,
            message: "Verifying the connected provider account.",
          },
        },
      }),
    );

    expect(markup).toContain("Checking your account");
    expect(markup).toContain("Finding models for your account…");
    expect(markup).toContain("animate-spin");
    expect(markup).not.toContain('viewBox="0 0 466.73 532.09"');
  });
});
