import { describe, expect, it } from "vitest";

import { connectorRecoveryTarget, signInRequestTarget } from "./ConnectorRecoveryAction";

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

describe("signInRequestTarget", () => {
  it("names the server an agent asked the user to sign in to", () => {
    expect(
      signInRequestTarget("mcp__scient__scient_connector_control", {
        connector: " guru ",
        action: "sign-in",
      }),
    ).toBe("guru");
    expect(
      signInRequestTarget("scient_connector_control", {
        connector: "plugin:design:intercom",
        action: "sign-in",
      }),
    ).toBe("plugin:design:intercom");
  });

  it("ignores other actions, blank names and other tools", () => {
    expect(
      signInRequestTarget("scient_connector_control", { connector: "guru", action: "restart" }),
    ).toBeNull();
    expect(
      signInRequestTarget("scient_connector_control", { connector: "  ", action: "sign-in" }),
    ).toBeNull();
    expect(
      signInRequestTarget("scient_connector_check", { connector: "guru", action: "sign-in" }),
    ).toBeNull();
    expect(signInRequestTarget("scient_connector_control", null)).toBeNull();
  });
});
