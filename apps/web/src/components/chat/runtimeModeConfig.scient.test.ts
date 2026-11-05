import type { ManagedPolicySummary } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { resolveCompatibleRuntimeMode, resolveRuntimeModeOptions } from "./runtimeModeConfig";

it("keeps permission controls stable across equivalent provider snapshots and typing", () => {
  const before = resolveCompatibleRuntimeMode("auto", ["auto", "approval-required"]);
  const after = resolveCompatibleRuntimeMode("auto", ["approval-required", "auto"]);
  expect(after.modes).toEqual(["approval-required", "auto"]);
  expect(after.modes).toBe(before.modes);
  expect(resolveRuntimeModeOptions(after.modes, undefined)).toBe(
    resolveRuntimeModeOptions(before.modes, undefined),
  );
  expect(resolveCompatibleRuntimeMode("full-access", ["auto"]).mode).toBe("auto");
  expect(resolveCompatibleRuntimeMode("full-access", []).mode).toBe("full-access");
});

it("updates disabled options when the administrator changes the ceiling or its explanation", () => {
  const modes = resolveCompatibleRuntimeMode("auto", undefined).modes;
  const limited: ManagedPolicySummary = {
    organization: "Research lab",
    lockedSettings: [],
    limits: { maxRuntimeMode: "approval-required" },
  };
  const restricted = resolveRuntimeModeOptions(modes, limited);
  expect(restricted.find((option) => option.mode === "auto")?.disabledReason).toContain(
    "Research lab",
  );
  expect(resolveRuntimeModeOptions(modes, limited)).toBe(restricted);
  const renamed = resolveRuntimeModeOptions(modes, { ...limited, organization: "New lab" });
  expect(renamed.find((option) => option.mode === "auto")?.disabledReason).toContain("New lab");
  const relaxed = resolveRuntimeModeOptions(modes, {
    ...limited,
    limits: { maxRuntimeMode: "full-access" },
  });
  expect(relaxed.every((option) => option.disabledReason === undefined)).toBe(true);
  expect(
    resolveRuntimeModeOptions(modes, undefined).every((option) => !option.disabledReason),
  ).toBe(true);
});
