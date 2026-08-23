import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderStatusBannerKey,
  ProviderStatusBanner,
  shouldShowProviderStatusBanner,
} from "./ProviderStatusBanner";

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
  it("stays hidden after its current warning is dismissed", () => {
    const status = warningProvider();

    expect(shouldShowProviderStatusBanner(status, null)).toBe(true);
    expect(shouldShowProviderStatusBanner(status, getProviderStatusBannerKey(status))).toBe(false);
  });

  it("renders an accessible dismiss control for provider warnings", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={warningProvider()} onDismiss={() => {}} />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Dismiss Codex provider warning"');
    expect(markup).toContain("absolute top-2 right-2");
  });

  it("renders on a glass surface so the timeline never reads through the banner", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={warningProvider()} onDismiss={() => {}} />,
    );

    expect(markup).toContain("alert-glass");
    expect(markup).toContain('data-variant="warning"');
  });

  it("labels error dismiss controls with the correct severity", () => {
    const markup = renderToStaticMarkup(
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
    expect(
      renderToStaticMarkup(<ProviderStatusBanner status={missing} onDismiss={() => {}} />),
    ).toBe("");
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

    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={failed} onDismiss={() => {}} />,
    );
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

    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={failed} onDismiss={() => {}} />,
    );
    expect(getProviderStatusBannerKey(failed)).not.toBeNull();
    expect(markup).toContain("Cursor provider failed its health check.");
  });
});
