import type { ProviderRuntimeSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeProviderRuntimeCatalog } from "./providerRuntimeCatalogFreshness";

const checked = { checkedAt: "2026-10-14T10:00:00.000Z", failure: null, checksDisabled: false };
const runtime = (overrides: Partial<ProviderRuntimeSummary>): ProviderRuntimeSummary => ({
  source: "scient_managed",
  supportTier: "fully_assisted",
  target: "macOS arm64",
  actions: ["repair", "remove"],
  managedVersion: "0.235.0",
  availableManagedVersion: null,
  previousManagedVersion: null,
  operation: null,
  message: "Scient is using an app-private, verified runtime.",
  catalog: checked,
  ...overrides,
});
const ago = (iso: string) => (iso === checked.checkedAt ? "3h ago" : "2m ago");

describe("describeProviderRuntimeCatalog", () => {
  it.each([
    ["an up-to-date managed runtime", {}, "Up to date · checked 3h ago", false],
    [
      "a newer qualified release",
      { actions: ["update", "repair", "remove"], availableManagedVersion: "0.241.1" },
      "Update 0.241.1 available · checked 3h ago",
      false,
    ],
    [
      "a failed check, keeping the last good one",
      {
        catalog: {
          ...checked,
          failure: { at: "2026-10-14T12:58:00.000Z", message: "The check timed out." },
        },
      },
      "Couldn't check for updates 2m ago, last checked 3h ago. The check timed out.",
      true,
    ],
    [
      "a failure before any check",
      {
        catalog: {
          checkedAt: null,
          failure: { at: "2026-10-14T12:58:00.000Z", message: "The check timed out." },
          checksDisabled: false,
        },
      },
      "Couldn't check for updates 2m ago. The check timed out.",
      true,
    ],
    [
      "checks turned off",
      { catalog: { ...checked, checksDisabled: true } },
      "Automatic update checks are off",
      false,
    ],
    [
      "a system runtime Scient can take over",
      { source: "system", managedVersion: null, actions: ["install"] },
      "Checked 3h ago",
      false,
    ],
  ] as const)("describes %s", (_case, overrides, text, failed) => {
    expect(
      describeProviderRuntimeCatalog(runtime(overrides as Partial<ProviderRuntimeSummary>), ago),
    ).toEqual({ text, failed });
  });

  it.each([
    ["a custom runtime", { source: "custom", managedVersion: null, actions: [] }],
    [
      "a list never checked",
      { catalog: { checkedAt: null, failure: null, checksDisabled: false } },
    ],
  ] as const)("says nothing for %s", (_case, overrides) => {
    expect(
      describeProviderRuntimeCatalog(runtime(overrides as Partial<ProviderRuntimeSummary>), ago),
    ).toBeNull();
  });

  it("says nothing for a server that predates the field", () => {
    const { catalog: _catalog, ...predating } = runtime({});
    expect(describeProviderRuntimeCatalog(predating, ago)).toBeNull();
  });
});
