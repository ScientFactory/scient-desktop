import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { connectorProviderSupport, connectorTransportSupport } from "./ConnectorProviderSupport.ts";
import { SCIENT_SKILL_DELIVERY } from "../skills/ScientSkillSession.ts";

const provider = (driver: string, displayName?: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(`${driver}-instance`),
  driver: ProviderDriverKind.make(driver),
  ...(displayName === undefined ? {} : { displayName }),
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: "2026-10-21T00:00:00.000Z",
  version: null,
  models: [],
  slashCommands: [],
  skills: [],
});

it("has a reviewed decision for every built-in driver that receives Scient MCP", () => {
  for (const driver of Object.keys(SCIENT_SKILL_DELIVERY)) {
    const support = connectorTransportSupport(ProviderDriverKind.make(driver));
    assert.notDeepEqual(
      support,
      connectorTransportSupport(ProviderDriverKind.make("unreviewed-driver")),
      driver,
    );
  }
});

it("fails closed with a reason for drivers it has not reviewed", () => {
  assert.deepEqual(
    connectorProviderSupport([provider("future-agent"), provider("codex", "Work")]),
    [
      {
        providerInstanceId: ProviderInstanceId.make("future-agent-instance"),
        driver: ProviderDriverKind.make("future-agent"),
        displayName: "future-agent",
        status: "unsupported",
        reason: "Scient has not qualified connector delivery for this agent.",
      },
      {
        providerInstanceId: ProviderInstanceId.make("codex-instance"),
        driver: ProviderDriverKind.make("codex"),
        displayName: "Work",
        status: "supported",
      },
    ],
  );
});
