import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  currentOptimisticProviderValue,
  isManagedRuntimeActionDurablySettled,
} from "./optimisticProviderValue";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("cursor"),
  driver: ProviderDriverKind.make("cursor"),
  enabled: true,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-08-23T08:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("currentOptimisticProviderValue", () => {
  it("bridges only the provider snapshot from which the command started", () => {
    const optimistic = { baseProvider: provider, value: "installing" };

    expect(currentOptimisticProviderValue(optimistic, provider)).toBe("installing");
    expect(currentOptimisticProviderValue(optimistic, { ...provider })).toBeNull();
  });

  it("uses durable runtime state to settle install and remove progress", () => {
    const missingRuntime = {
      source: "missing" as const,
      supportTier: "fully_assisted" as const,
      target: "darwin-arm64",
      actions: ["install"] as const,
      managedVersion: null,
      previousManagedVersion: null,
      operation: null,
      message: "Cursor setup is available.",
    };
    const managedRuntime = {
      ...missingRuntime,
      source: "scient_managed" as const,
      actions: ["repair", "remove"] as const,
      managedVersion: "2026.08.11-e8db854",
    };

    expect(isManagedRuntimeActionDurablySettled("install", managedRuntime)).toBe(true);
    expect(isManagedRuntimeActionDurablySettled("install", missingRuntime)).toBe(false);
    expect(isManagedRuntimeActionDurablySettled("remove", missingRuntime)).toBe(true);
    expect(isManagedRuntimeActionDurablySettled("remove", managedRuntime)).toBe(false);
    expect(isManagedRuntimeActionDurablySettled("repair", managedRuntime)).toBe(false);
  });
});
