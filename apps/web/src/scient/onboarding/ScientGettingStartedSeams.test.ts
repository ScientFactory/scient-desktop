// @effect-diagnostics nodeBuiltinImport:off -- static audit for narrow inherited host seams.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const read = (relativePath: string) =>
  NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("Scient getting-started host seams", () => {
  it("keeps hosted environment onboarding ahead of the local first-run gate", () => {
    const indexRoute = read("../../routes/_chat.index.tsx");
    const hostedBranch = indexRoute.indexOf('authGateState.status === "hosted-static"');
    const scientGate = indexRoute.indexOf("<ScientGettingStartedGate");

    expect(hostedBranch).toBeGreaterThan(-1);
    expect(scientGate).toBeGreaterThan(hostedBranch);
    expect(indexRoute).toContain("fallback={<IndexDraftLanding />}");
  });

  it("keeps replay additive and contained to a Scient-owned route", () => {
    const settings = read("../../components/settings/SettingsPanels.tsx");
    const route = read("../../routes/_chat.getting-started.tsx");
    const settingsRow = read("./ScientGettingStartedSettingsRow.tsx");

    expect(settings).toContain("<ScientGettingStartedSettingsRow />");
    expect(route).toContain('<ScientGettingStartedFlow mode="manual" />');
    expect(settingsRow.indexOf("<Link")).toBeLessThan(settingsRow.indexOf("<SettingsRow"));
    expect(settingsRow).toContain('to="/getting-started"');
    expect(settingsRow).not.toContain("<Button");
  });

  it("reuses canonical provider setup and avoids card or progress primitives", () => {
    const view = read("./ScientGettingStartedView.tsx");
    const flow = read("./ScientGettingStartedFlow.tsx");

    expect(view).toContain("ProviderLifecycleSetupSurface");
    expect(flow).toContain("deriveProviderInstanceEntries");
    expect(flow).toContain("isProviderInstancePickerReady");
    expect(view).not.toMatch(/\bCard(?:Content|Header|Title)?\b/);
    expect(view).not.toMatch(/\bProgress\b/);
  });
});
