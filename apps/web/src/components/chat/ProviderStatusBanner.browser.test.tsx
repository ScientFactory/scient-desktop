import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { getProviderStatusBannerKey, ProviderStatusBanner } from "./ProviderStatusBanner";

function warningProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "warning",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-23T12:00:00.000Z",
    message: "Provider is temporarily degraded.",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

function assistedCursorProvider(): ServerProvider {
  return {
    ...warningProvider(),
    instanceId: ProviderInstanceId.make("cursor"),
    driver: ProviderDriverKind.make("cursor"),
    displayName: "Cursor",
    status: "error",
    auth: { status: "unauthenticated", required: true },
    message: "Cursor Agent is not authenticated.",
    connection: {
      methods: ["cursor_browser"],
      canDisconnect: false,
      operation: null,
      runtime: {
        source: "scient_managed",
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions: ["repair", "remove"],
        managedVersion: "2026.08.11-e8db854",
        previousManagedVersion: null,
        operation: null,
        message: "Scient is using an app-private, verified Cursor runtime.",
      },
    },
  };
}

describe("ProviderStatusBanner", () => {
  it("renders an accessible dismiss control for provider warnings", () => {
    const markup = renderMarkup(
      <ProviderStatusBanner status={warningProvider()} onDismiss={() => {}} />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Dismiss Codex provider warning"');
  });

  it("labels error dismiss controls with the correct severity", () => {
    const markup = renderMarkup(
      <ProviderStatusBanner
        status={{ ...warningProvider(), status: "error" }}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Dismiss Codex provider error"');
  });

  it("does not duplicate expected assisted installation and sign-in states", () => {
    const installed = assistedCursorProvider();
    const missing: ServerProvider = {
      ...installed,
      installed: false,
      message: "Cursor CLI command /private/cursor-agent was not found.",
      connection: {
        ...installed.connection!,
        runtime: {
          ...installed.connection!.runtime!,
          source: "missing",
          actions: ["install"],
          managedVersion: null,
        },
      },
    };
    const installing: ServerProvider = {
      ...missing,
      connection: {
        ...missing.connection!,
        runtime: {
          ...missing.connection!.runtime!,
          operation: {
            operationId: "cursor-install",
            action: "install",
            status: "activating",
            startedAt: "2026-08-23T08:00:00.000Z",
            finishedAt: null,
            message: "Finishing setup.",
          },
        },
      },
    };

    expect(getProviderStatusBannerKey(missing)).toBeNull();
    expect(getProviderStatusBannerKey(installing)).toBeNull();
    expect(getProviderStatusBannerKey(installed)).toBeNull();
    expect(renderMarkup(<ProviderStatusBanner status={missing} onDismiss={() => {}} />)).toBe("");
  });

  it("keeps genuine assisted lifecycle failures visible", () => {
    const installed = assistedCursorProvider();
    const failed: ServerProvider = {
      ...installed,
      connection: {
        ...installed.connection!,
        runtime: {
          ...installed.connection!.runtime!,
          operation: {
            operationId: "cursor-install",
            action: "install",
            status: "failed",
            startedAt: "2026-08-23T08:00:00.000Z",
            finishedAt: "2026-08-23T08:00:05.000Z",
            message: "Cursor verification failed.",
          },
        },
      },
    };

    const markup = renderMarkup(<ProviderStatusBanner status={failed} onDismiss={() => {}} />);
    expect(getProviderStatusBannerKey(failed)).not.toBeNull();
    expect(markup).toContain("Cursor setup failed");
    expect(markup).toContain("Cursor verification failed.");
  });

  it("keeps an unexplained provider failure visible when assisted sign-in is available", () => {
    const failed: ServerProvider = {
      ...assistedCursorProvider(),
      auth: { status: "unknown", required: true },
      message: "Cursor provider failed its health check.",
    };

    const markup = renderMarkup(<ProviderStatusBanner status={failed} onDismiss={() => {}} />);
    expect(getProviderStatusBannerKey(failed)).not.toBeNull();
    expect(markup).toContain("Cursor provider failed its health check.");
  });
});

const browserRoots: Root[] = [];
afterEach(async () => {
  for (const root of browserRoots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function renderMarkup(node: ReactNode): string {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  browserRoots.push(root);
  act(() => root.render(node));
  return container.innerHTML;
}
