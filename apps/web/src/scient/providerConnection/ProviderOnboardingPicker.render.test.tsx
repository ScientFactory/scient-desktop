import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("./GrokInlineSetup", () => ({
  GrokInlineSetup: () => <div>Grok inline lifecycle</div>,
}));
vi.mock("./useProviderLifecycleController", () => ({
  useProviderLifecycleController: () => ({}),
}));

import { ProviderLifecycleSetupSurface } from "./ProviderOnboardingPicker";

it("renders Grok's complete lifecycle inline instead of sending the composer to settings", () => {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("grok"),
    driver: ProviderDriverKind.make("grok"),
    displayName: "Grok",
    enabled: true,
    installed: false,
    version: null,
    status: "error",
    auth: { status: "unauthenticated", required: true, type: "grok_account" },
    checkedAt: "2026-08-23T08:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: ["grok_account", "grok_device_code"],
      canDisconnect: false,
      operation: null,
      runtime: {
        source: "missing",
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions: ["install"],
        managedVersion: null,
        previousManagedVersion: null,
        operation: null,
        message: "Scient can install Grok privately.",
      },
    },
  };
  const [entry] = deriveProviderInstanceEntries([provider]);
  if (!entry) throw new Error("Expected the Grok provider entry.");

  const markup = renderToStaticMarkup(
    <ProviderLifecycleSetupSurface environmentId={EnvironmentId.make("local")} entry={entry} />,
  );

  expect(markup).toContain("Grok inline lifecycle");
  expect(markup).not.toContain("Open provider settings");
});
