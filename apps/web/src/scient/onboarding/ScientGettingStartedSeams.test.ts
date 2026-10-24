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

  it("mounts replay in the inherited Settings through one Scient-owned row", () => {
    const settings = read("../../components/settings/SettingsPanels.tsx");

    expect(settings).toContain("<ScientGettingStartedSettingsRow />");
  });
});
