import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  hasCloudPublicConfig,
  resolveCloudPublicConfig,
  resolveRelayTracingConfig,
} from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("@t3tools/shared/scientDesktopIdentity");
  vi.resetModules();
});

describe("hasCloudPublicConfig", () => {
  it("requires both public cloud values", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    // D4 keeps the cloud foundation present but disables live startup/route
    // activation until an explicit selected-user enablement phase.
    expect(hasCloudPublicConfig()).toBe(false);
    expect(resolveCloudPublicConfig()).toEqual({
      clerkPublishableKey: "pk_test_example",
      clerkJwtTemplate: "t3-relay",
      relayUrl: "https://relay.example.test",
      relayTracing: { tracesUrl: null, tracesDataset: null, tracesToken: null },
    });
    expect(resolveRelayTracingConfig()).toBeNull();
  });

  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  describe("browser origins", () => {
    let foundationHasCloudPublicConfig: typeof hasCloudPublicConfig;
    beforeEach(async () => {
      vi.resetModules();
      // Exercise inherited origin validation with a synthetic enabled policy,
      // while every case also checks the unmocked Scient activation hold.
      vi.doMock("@t3tools/shared/scientDesktopIdentity", async (original) => {
        const actual = await original<typeof import("@t3tools/shared/scientDesktopIdentity")>();
        return {
          ...actual,
          SCIENT_DESKTOP_IDENTITY: { ...actual.SCIENT_DESKTOP_IDENTITY, cloudEnabled: true },
        };
      });
      foundationHasCloudPublicConfig = (await import("./publicConfig.ts")).hasCloudPublicConfig;
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_live_${btoa("clerk.example.com$")}`);
      vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
      vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    });

    function expectCloudConfig(expected: boolean) {
      expect(hasCloudPublicConfig()).toBe(false);
      expect(foundationHasCloudPublicConfig()).toBe(expected);
    }

    it.each(["https://example.com", "https://nightly.app.example.com:443"])(
      "enables production auth on the configured root and subdomains: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expectCloudConfig(true);
      },
    );

    it.each(["http://localhost:3773", "https://machine.example.ts.net"])(
      "disables production auth on private browser origins: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expectCloudConfig(false);
      },
    );

    it.each(["http://app.example.com:443", "https://app.example.com:3773"])(
      "rejects unsupported schemes and ports even on the configured domain: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expectCloudConfig(false);
      },
    );

    it.each(["https://notexample.com", "https://example.com.evil.test"])(
      "rejects domain lookalikes: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expectCloudConfig(false);
      },
    );

    it.each([
      ["https://tenant.clerk.accounts.dev", true],
      ["https://other.clerk.accounts.dev", false],
    ])("keeps a provider hostname scoped to its own instance: %s", (origin, expected) => {
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_live_${btoa("tenant.clerk.accounts.dev$")}`);
      vi.stubGlobal("window", { location: new URL(origin) });

      expectCloudConfig(expected);
    });

    it("keeps development keys available on private browser origins", () => {
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_test_${btoa("tenant.clerk.accounts.dev$")}`);
      vi.stubGlobal("window", { location: new URL("http://localhost:3773") });

      expectCloudConfig(true);
    });

    it("keeps production keys available in the Electron auth shell", () => {
      vi.stubGlobal("window", { location: new URL("file:///app/index.html"), desktopBridge: {} });

      expectCloudConfig(true);
    });

    it("disables cloud auth for an invalid production key without throwing", () => {
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_live_!");
      vi.stubGlobal("window", { location: new URL("https://app.example.com") });

      expectCloudConfig(false);
    });
  });
});
