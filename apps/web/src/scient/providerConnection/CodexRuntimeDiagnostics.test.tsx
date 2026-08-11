import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CodexRuntimeDiagnosticsDetails,
  resolveCodexRuntimeDiagnostics,
} from "./CodexRuntimeDiagnostics";

const provider = (patch: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "0.147.0",
  status: "ready",
  auth: { status: "authenticated", required: true },
  checkedAt: "2026-08-11T20:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["codex_browser", "codex_device_code"],
    canDisconnect: true,
    operation: null,
    runtime: {
      source: "system",
      supportTier: "fully_assisted",
      target: "darwin-arm64",
      actions: ["install"],
      managedVersion: null,
      previousManagedVersion: null,
      operation: null,
      message: "Scient is using the system Codex runtime.",
      diagnostics: {
        executable: "/opt/homebrew/bin/codex",
        version: null,
        homePath: "/Users/server/.codex",
        backend: "macOS native",
      },
    },
  },
  ...patch,
});

describe("CodexRuntimeDiagnostics", () => {
  it("omits diagnostics for an older server instead of inventing runtime coordinates", () => {
    const { diagnostics: _diagnostics, ...runtimeWithoutDiagnostics } =
      provider().connection!.runtime!;
    const withoutDiagnostics = provider({
      connection: {
        ...provider().connection!,
        runtime: runtimeWithoutDiagnostics,
      },
    });

    expect(resolveCodexRuntimeDiagnostics(withoutDiagnostics)).toBeNull();
    expect(
      renderToStaticMarkup(<CodexRuntimeDiagnosticsDetails provider={withoutDiagnostics} />),
    ).toBe("");
  });

  it("uses the provider version when runtime diagnostics do not supply one", () => {
    expect(resolveCodexRuntimeDiagnostics(provider())?.version).toBe("0.147.0");
  });

  it("renders server-scoped diagnostics without an unsafe shell command", () => {
    const markup = renderToStaticMarkup(<CodexRuntimeDiagnosticsDetails provider={provider()} />);

    expect(markup).toContain("Runtime diagnostics");
    expect(markup).toContain("Server backend");
    expect(markup).toContain("Server Codex home");
    expect(markup).toContain("Server executable");
    expect(markup).toContain("Remote clients may show paths from a different computer.");
    expect(markup).not.toContain("Manual fallback");
    expect(markup).not.toContain("app-server");
  });

  it("offers managed recovery only when the server exposes the install action", () => {
    const onUseManaged = vi.fn();
    const available = renderToStaticMarkup(
      <CodexRuntimeDiagnosticsDetails onUseManaged={onUseManaged} provider={provider()} />,
    );
    const unavailable = renderToStaticMarkup(
      <CodexRuntimeDiagnosticsDetails provider={provider()} />,
    );

    expect(available).toContain("Use Scient-managed Codex");
    expect(available).toContain("Applies to Codex accounts in this environment");
    expect(available).toContain("Custom executable paths remain unchanged");
    expect(unavailable).not.toContain("Use Scient-managed Codex");
  });
});
