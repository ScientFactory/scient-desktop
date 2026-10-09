import {
  defaultInstanceIdForDriver,
  isUnconfiguredDefaultInstanceEnabled,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("built-in provider enablement policy", () => {
  it.each(BUILT_IN_DRIVERS.map((driver) => [driver.driverKind, driver] as const))(
    "keeps shared %s eligibility aligned with execution's schema default",
    (kind, driver) => {
      const config = Schema.decodeUnknownSync(driver.configSchema)(driver.defaultConfig());
      const enabled = config.enabled ?? true;
      expect(resolveProviderInstanceEnabled({ driver: kind, config: {} })).toBe(enabled);
      expect(isUnconfiguredDefaultInstanceEnabled(defaultInstanceIdForDriver(kind))).toBe(
        driver.metadata.hasDefaultInstance !== false && enabled,
      );
      expect(resolveProviderInstanceEnabled({ driver: kind, enabled: true, config: {} })).toBe(
        true,
      );
      expect(resolveProviderInstanceEnabled({ driver: kind, enabled: false, config: {} })).toBe(
        false,
      );
      expect(
        resolveProviderInstanceEnabled({ driver: kind, enabled: true, config: { enabled: false } }),
      ).toBe(false);
      expect(
        resolveProviderInstanceEnabled({ driver: kind, enabled: false, config: { enabled: true } }),
      ).toBe(false);
    },
  );
});
