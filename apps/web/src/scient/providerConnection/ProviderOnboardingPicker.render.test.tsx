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
vi.mock("./DroidInlineSetup", () => ({
  DroidInlineSetup: () => <div>Droid inline lifecycle</div>,
}));
vi.mock("./useProviderLifecycleController", () => ({
  useProviderLifecycleController: () => ({}),
}));

import { ProviderLifecycleSetupSurface } from "./ProviderOnboardingPicker";

it.each([
  ["grok", "Grok", "grok_account", "Grok inline lifecycle"],
  ["droid", "Droid", "droid_device_pairing", "Droid inline lifecycle"],
] as const)(
  "renders %s's complete lifecycle inline instead of sending the composer to settings",
  (driver, displayName, method, expectedSurface) => {
    const provider: ServerProvider = {
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      displayName,
      enabled: true,
      installed: false,
      version: null,
      status: "error",
      auth: {
        status: "unauthenticated",
        required: true,
        ...(driver === "grok" ? { type: "grok_account" as const } : {}),
      },
      checkedAt: "2026-08-23T08:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      connection: {
        methods: [method],
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
          message: `Scient can install ${displayName} privately.`,
        },
      },
    };
    const [entry] = deriveProviderInstanceEntries([provider]);
    if (!entry) throw new Error(`Expected the ${displayName} provider entry.`);

    const markup = renderToStaticMarkup(
      <ProviderLifecycleSetupSurface environmentId={EnvironmentId.make("local")} entry={entry} />,
    );

    expect(markup).toContain(expectedSurface);
    expect(markup).not.toContain("Open provider settings");
  },
);
