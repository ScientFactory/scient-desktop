import { describe, expect, it } from "vitest";

import { connectorRecoveryTarget } from "./ConnectorRecoveryAction";

describe("connectorRecoveryTarget", () => {
  it("extracts the connector scient_connector_check names", () => {
    expect(connectorRecoveryTarget("scient_connector_check", { connector: "  Linear  " })).toBe(
      "Linear",
    );
    expect(connectorRecoveryTarget("scient_connector_check", { connector: "monday-com" })).toBe(
      "monday-com",
    );
    expect(
      connectorRecoveryTarget("mcp__scient__scient_connector_check", { connector: "github" }),
    ).toBe("github");
  });

  it("ignores listings, blank targets, and unrelated tools", () => {
    expect(connectorRecoveryTarget("scient_connector_list", {})).toBeNull();
    expect(connectorRecoveryTarget("scient_connector_list", { query: "cloudflare" })).toBeNull();
    expect(connectorRecoveryTarget("scient_connector_check", { connector: "   " })).toBeNull();
    expect(
      connectorRecoveryTarget("scient_connector_control", { connector: "cloudflare" }),
    ).toBeNull();
    expect(connectorRecoveryTarget("bash", { connector: "cloudflare" })).toBeNull();
    expect(connectorRecoveryTarget("scient_connector_list", null)).toBeNull();
  });
});
