import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
  type ServerProviderWorkspaceSnapshot,
} from "@t3tools/contracts";

export const INVENTORY_PROVIDER = ProviderInstanceId.make("inventory-provider");
export const OTHER_INVENTORY_PROVIDER = ProviderInstanceId.make("other-provider");
const INVENTORY_CHECKED_AT = "2026-10-26T00:00:00.000Z";

export function inventorySnapshot(cwd: string, name: string): ServerProviderWorkspaceSnapshot {
  return {
    cwd,
    checkedAt: INVENTORY_CHECKED_AT,
    skills: [{ name, path: `${cwd}/${name}/SKILL.md`, enabled: true }],
    slashCommands: [{ name }],
    plugins: [{ id: name, name, enabled: true, source: "local" }],
  };
}

export function inventoryProvider(
  generation: string | undefined,
  workspaceSnapshots: ReadonlyArray<ServerProviderWorkspaceSnapshot> = [],
  instanceId = INVENTORY_PROVIDER,
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    status: "ready",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    checkedAt: INVENTORY_CHECKED_AT,
    version: null,
    models: [],
    skills: [],
    slashCommands: [],
    ...(generation === undefined ? {} : { nativeInventoryGeneration: generation }),
    workspaceSnapshots,
  };
}

export function inventoryConfig(providers: ServerConfig["providers"], onDemand = true) {
  return {
    providers,
    environment: {
      serverVersion: "0.0.0-test",
      capabilities: { providerWorkspaceSnapshotsOnDemand: onDemand },
    },
  } as unknown as ServerConfig;
}
