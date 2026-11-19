import { PROVIDER_DISPLAY_ORDER, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderClient, orderProvidersForDisplay } from "./scientProviderClients.ts";

describe("Scient provider clients", () => {
  it("names every first-party driver, including the ones Scient adds", () => {
    expect(PROVIDER_DISPLAY_ORDER.filter((driver) => !getProviderClient(driver)?.label)).toEqual(
      [],
    );
  });

  it("lists Scient first and each driver's default instance before its custom ones", () => {
    const provider = (driver: string, instanceId = driver) => ({
      driver: ProviderDriverKind.make(driver),
      instanceId,
    });

    expect(
      orderProvidersForDisplay([
        provider("codex", "codex_work"),
        provider("droid"),
        provider("codex", "codex_home"),
        provider("codex"),
        provider("scient"),
      ]).map((entry) => entry.instanceId),
    ).toEqual(["scient", "codex", "codex_work", "codex_home", "droid"]);
  });
});
