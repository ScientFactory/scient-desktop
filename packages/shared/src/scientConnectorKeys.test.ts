import { AccountId, defaultAccountControls, type AccountSummary } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { connectorKeyFits } from "./scientConnectorKeys.ts";

const connector = {
  connectorId: "con_synthetic01",
  url: "https://mcp.example.com/mcp",
  strategy: "bearer" as const,
};
const key = (overrides: Partial<AccountSummary> = {}): AccountSummary => ({
  accountId: AccountId.make("acc_synthetic1"),
  name: "Example",
  details: { kind: "api-key", sites: ["https://mcp.example.com"], auth: { type: "bearer" } },
  secrets: { token: { source: { type: "scient" } } },
  controls: defaultAccountControls("api-key"),
  status: "ready",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

it("offers a connector only keys its server would send, Off ones only when kept for it", () => {
  const off = { ...defaultAccountControls("api-key"), access: "off" as const };
  expect(connectorKeyFits(key(), connector)).toBe(true);
  expect(connectorKeyFits(key({ controls: off }), connector)).toBe(false);
  const kept = key({
    controls: off,
    details: {
      kind: "api-key",
      sites: ["https://mcp.example.com"],
      auth: { type: "bearer" },
      privateTo: { kind: "connector", id: connector.connectorId, name: "Example" },
    },
  });
  expect(connectorKeyFits(kept, connector)).toBe(true);
});
