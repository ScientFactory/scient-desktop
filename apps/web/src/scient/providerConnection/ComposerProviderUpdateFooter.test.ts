import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeOperation,
  type ProviderRuntimeSource,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { canOfferComposerManagedRuntimeUpdate } from "./ComposerProviderUpdateFooter";

function providerEntry(input: {
  source: ProviderRuntimeSource;
  actions: Array<"update" | "repair" | "remove">;
  operation?: ProviderRuntimeOperation | null;
}) {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "2.1.245",
    status: "ready",
    auth: { status: "authenticated", required: true },
    checkedAt: "2026-08-29T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: ["claude_subscription"],
      canDisconnect: true,
      operation: null,
      runtime: {
        source: input.source,
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions: input.actions,
        managedVersion: input.source === "scient_managed" ? "2.1.245" : null,
        previousManagedVersion: null,
        operation: input.operation ?? null,
        message: "Runtime status.",
      },
    },
  };
  const [entry] = deriveProviderInstanceEntries([provider]);
  if (!entry) throw new Error("Expected a provider entry.");
  return entry;
}

describe("canOfferComposerManagedRuntimeUpdate", () => {
  it("offers only an idle update advertised by a Scient-managed runtime", () => {
    expect(
      canOfferComposerManagedRuntimeUpdate(
        providerEntry({ source: "scient_managed", actions: ["update", "repair", "remove"] }),
      ),
    ).toBe(true);
    expect(
      canOfferComposerManagedRuntimeUpdate(
        providerEntry({ source: "system", actions: ["update", "repair", "remove"] }),
      ),
    ).toBe(false);
    expect(
      canOfferComposerManagedRuntimeUpdate(
        providerEntry({ source: "scient_managed", actions: ["repair", "remove"] }),
      ),
    ).toBe(false);
  });

  it("does not advertise a second update while a runtime operation is active", () => {
    expect(
      canOfferComposerManagedRuntimeUpdate(
        providerEntry({
          source: "scient_managed",
          actions: ["update", "repair", "remove"],
          operation: {
            operationId: "runtime-update-1",
            action: "update",
            status: "downloading",
            startedAt: "2026-08-29T00:00:00.000Z",
            finishedAt: null,
            message: "Updating Claude.",
          },
        }),
      ),
    ).toBe(false);
  });
});
