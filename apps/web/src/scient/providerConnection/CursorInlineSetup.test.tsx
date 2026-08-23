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
  };
}

function render(value: ServerProvider): string {
  return renderToStaticMarkup(
    <CursorInlineSetup controller={controller()} displayName="Cursor" provider={value} />,
  );
}

describe("CursorInlineSetup", () => {
  it("offers the single truthful browser sign-in flow", () => {
    const markup = render(provider());

    expect(markup).toContain("Sign in to Cursor");
    expect(markup).toContain("Scient never sees your password.");
    expect(markup).not.toContain("device code");
    expect(markup).not.toContain("Paste code");
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

    expect(markup).toContain("Installing Cursor");
    expect(markup).toContain("Downloading Cursor.");
    expect(markup).toContain('viewBox="0 0 466.73 532.09"');
    expect(markup).toContain("in-[[data-model-picker-content=true]]:inline-flex");
    expect(markup).toContain(">Cancel<");
    expect(markup).toContain("text-destructive/80");
    expect(markup).not.toContain("progressbar");
    expect(markup).toContain('data-provider-onboarding-view="cursor-flow"');
    expect(markup).toContain(
      "hidden size-4.5 animate-spin text-primary in-[[data-model-picker-content=true]]:inline",
    );
    expect(markup).not.toContain("hidden size-3.5 animate-spin");
  });

  it("shows model discovery as part of the final installation check", () => {
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

    expect(markup).toContain("Installing Cursor");
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
    expect(markup).toContain(
      "hidden size-4.5 animate-spin text-primary in-[[data-model-picker-content=true]]:inline",
    );
    expect(markup).not.toContain("hidden size-3.5 animate-spin");
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
    expect(markup).toContain('viewBox="0 0 466.73 532.09"');
  });
});
