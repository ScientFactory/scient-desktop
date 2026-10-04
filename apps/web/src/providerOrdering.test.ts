import { describe, expect, it } from "vite-plus/test";

import { DRIVER_OPTIONS } from "./components/settings/providerDriverMeta";
import { PROVIDER_OPTIONS } from "./session-logic";

const expectedOrder = [
  "scient",
  "codex",
  "claudeAgent",
  "antigravity",
  "opencode",
  "droid",
  "pi",
  "omp",
  "cursor",
  "grok",
];

describe("provider ordering consumers", () => {
  it("keeps Settings and provider pickers on the canonical order with registry creation in Settings", () => {
    expect(DRIVER_OPTIONS.map((option) => option.value)).toEqual([...expectedOrder, "acpRegistry"]);
    expect(
      DRIVER_OPTIONS.find((option) => option.value === "acpRegistry")?.hasDefaultInstance,
    ).toBe(false);
    expect(PROVIDER_OPTIONS.map((option) => option.value)).toEqual(expectedOrder);
  });
});

describe("provider maturity markers", () => {
  it("marks no provider Early Access and badges every non-default provider new", () => {
    expect(DRIVER_OPTIONS.filter((option) => option.badgeLabel !== undefined)).toEqual([]);
    expect(
      PROVIDER_OPTIONS.filter((option) => option.pickerSidebarBadge === "new").map(
        (option) => option.value,
      ),
    ).toEqual(expectedOrder.filter((value) => value !== "codex" && value !== "claudeAgent"));
  });
});
