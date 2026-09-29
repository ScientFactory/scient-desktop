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
    canUpdate: false,
    canInstallVersion: false,
    checkedAt: "2026-09-25T00:00:00.000Z",
    message:
      "Oh My Pi 18.3.1 is available. Update this installation by running `/Users/test/.local/bin/omp update` in a terminal.",
  },
};

describe("OMP update presentation", () => {
  it("offers no one-click update for a system install, only the Manage flow", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderSettingsLifecycleAction, {
        displayName: "Oh My Pi",
        environmentId: EnvironmentId.make("local"),
        provider,
        onManage: () => undefined,
        onRunExternalUpdate: () => undefined,
      }),
    );

    // Scient never runs `omp update`; the advisory's command is copied by hand.
    expect(markup).not.toContain(">Update</button>");
    expect(markup).toContain("Manage");
  });
});
