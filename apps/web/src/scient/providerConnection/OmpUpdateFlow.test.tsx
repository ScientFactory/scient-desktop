import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderSettingsLifecycleAction } from "./ProviderSettingsLifecycleAction";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("omp"),
  driver: ProviderDriverKind.make("omp"),
  displayName: "Oh My Pi",
  enabled: true,
  installed: true,
  version: "18.3.0",
  status: "ready",
  auth: { status: "unknown", required: false },
  checkedAt: "2026-09-25T00:00:00.000Z",
  models: [
    { slug: "ollama/gemma4:12b-it-qat", name: "Gemma", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
  connection: {
    methods: [],
    canDisconnect: false,
    operation: null,
    runtime: {
      source: "system",
      supportTier: "external_runtime_supported",
      target: "darwin-arm64",
      actions: [],
      managedVersion: null,
      previousManagedVersion: null,
      operation: null,
      message: "Scient is using the healthy Oh My Pi runtime already installed on this computer.",
    },
  },
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "18.3.0",
    latestVersion: "18.3.1",
    updateCommand: "/Users/test/.local/bin/omp update",
    canUpdate: true,
    canInstallVersion: false,
    checkedAt: "2026-09-25T00:00:00.000Z",
    message: "A newer stable Oh My Pi release is available. Update it with Oh My Pi.",
  },
};

describe("OMP update presentation", () => {
  it("uses the shared selected-provider Update and compact Manage flow", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderSettingsLifecycleAction, {
        displayName: "Oh My Pi",
        environmentId: EnvironmentId.make("local"),
        provider,
        onManage: () => undefined,
        onRunExternalUpdate: () => undefined,
      }),
    );

    expect(markup).toContain(">Update</button>");
    expect(markup).toContain('aria-label="Manage Oh My Pi"');
    expect(markup).toContain("lucide-settings-2");
    expect(markup).not.toContain(">Manage</button>");
  });
});
