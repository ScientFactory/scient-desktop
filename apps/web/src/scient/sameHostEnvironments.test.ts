import { describe, expect, it } from "vite-plus/test";

import { sameHostEnvironmentIds } from "./sameHostEnvironments";

describe("sameHostEnvironmentIds", () => {
  // regression: a browser opened against a remote server took its page origin for this computer.
  it("trusts no environment from a browser, whatever its page origin serves", () => {
    expect(
      sameHostEnvironmentIds({
        desktopApp: false,
        desktopManagedPrimary: false,
        primaryEnvironmentId: "remote-server",
        hostEnvironmentId: null,
      }).size,
    ).toBe(0);
  });

  it("trusts the desktop app's own backend and the service sharing its home", () => {
    expect([
      ...sameHostEnvironmentIds({
        desktopApp: true,
        desktopManagedPrimary: true,
        primaryEnvironmentId: "local",
        hostEnvironmentId: "service",
      }),
    ]).toEqual(["local", "service"]);
  });

  it("does not trust a desktop app's primary that points at another server", () => {
    expect([
      ...sameHostEnvironmentIds({
        desktopApp: true,
        desktopManagedPrimary: false,
        primaryEnvironmentId: "configured-remote",
        hostEnvironmentId: null,
      }),
    ]).toEqual([]);
  });
});
