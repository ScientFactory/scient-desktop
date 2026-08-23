import { describe, expect, it } from "vite-plus/test";

import { DRIVER_OPTIONS } from "./components/settings/providerDriverMeta";
import { PROVIDER_OPTIONS } from "./session-logic";

const expectedOrder = [
  "codex",
  "claudeAgent",
  "antigravity",
  "opencode",
  "droid",
  "cursor",
  "grok",
];

describe("provider ordering consumers", () => {
  it("keeps Settings and provider pickers on the canonical order", () => {
    expect(DRIVER_OPTIONS.map((option) => option.value)).toEqual(expectedOrder);
    expect(PROVIDER_OPTIONS.map((option) => option.value)).toEqual(expectedOrder);
  });
});
