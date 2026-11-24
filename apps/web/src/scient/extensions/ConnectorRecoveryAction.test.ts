import { describe, expect, it } from "vitest";

import { connectorRecoveryTarget } from "./ConnectorRecoveryAction";

describe("connectorRecoveryTarget", () => {
  it("extracts an explicitly targeted connector name from scient_connector_list and scient_connector_check", () => {
    expect(connectorRecoveryTarget("scient_connector_list", { connector: "cloudflare" })).toBe(
      "cloudflare",
    );
    expect(
      connectorRecoveryTarget("mcp__scient__scient_connector_list", { connector: "  Linear  " }),
    ).toBe("Linear");
    expect(connectorRecoveryTarget("scient_connector_check", { connector: "monday-com" })).toBe(
      "monday-com",
    );
    expect(
      connectorRecoveryTarget("mcp__scient__scient_connector_check", { connector: "github" }),
    ).toBe("github");
  });

  it("ignores broad listings, blank targets, and unrelated tools", () => {
    expect(connectorRecoveryTarget("scient_connector_list", {})).toBeNull();
    expect(connectorRecoveryTarget("scient_connector_list", { query: "cloudflare" })).toBeNull();
    expect(connectorRecoveryTarget("scient_connector_list", { connector: "   " })).toBeNull();
    expect(
      connectorRecoveryTarget("scient_connector_control", { connector: "cloudflare" }),
    ).toBeNull();
    expect(connectorRecoveryTarget("bash", { connector: "cloudflare" })).toBeNull();
    expect(connectorRecoveryTarget("scient_connector_list", null)).toBeNull();
  });
});
