// @effect-diagnostics nodeBuiltinImport:off - reads the committed Cargo manifests.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";

import { SCIENT_DESKTOP_IDENTITY, SCIENT_HELPER_EXECUTABLES } from "./scientDesktopIdentity.ts";

describe("Scient desktop identity", () => {
  it("uses the canonical production identity while keeping development and data isolated", () => {
    assert.equal(SCIENT_DESKTOP_IDENTITY.baseName, "Scient");
    assert.equal(SCIENT_DESKTOP_IDENTITY.cliCommandName, "scient");
    assert.equal(SCIENT_DESKTOP_IDENTITY.developmentName, "Scient (Dev)");
    assert.equal(SCIENT_DESKTOP_IDENTITY.appId, "com.scientfactory.scient");
    assert.equal(SCIENT_DESKTOP_IDENTITY.developmentAppId, "com.scientfactory.scient.next.dev");
    assert.equal(SCIENT_DESKTOP_IDENTITY.productionScheme, "scient");
    assert.equal(SCIENT_DESKTOP_IDENTITY.developmentScheme, "scient-next-dev");
    assert.equal(SCIENT_DESKTOP_IDENTITY.productionUserDataDirName, "scient-next");
    assert.equal(SCIENT_DESKTOP_IDENTITY.developmentUserDataDirName, "scient-next-dev");
    assert.equal(SCIENT_DESKTOP_IDENTITY.serviceUnitName, "scient.service");
    assert.equal(SCIENT_DESKTOP_IDENTITY.serviceLaunchdLabel, "com.scientfactory.scient.service");
    assert.equal(SCIENT_DESKTOP_IDENTITY.previewPartitionPrefix, "persist:scient-next-preview-");
    assert.equal(
      SCIENT_DESKTOP_IDENTITY.previewEphemeralPartitionPrefix,
      "scient-next-preview-ephemeral-",
    );
    assert.equal(
      SCIENT_DESKTOP_IDENTITY.clientSettingsStorageKey,
      "scient-next:client-settings:v1",
    );
  });

  it("names the shipped native helpers for Scient", () => {
    assert.deepStrictEqual(SCIENT_HELPER_EXECUTABLES, {
      resourceMonitor: "scient-resource-monitor",
      browserSecret: "scient-browser-secret",
      kdeCapture: "scient-kde-snap-shot",
      hyprlandCapture: "scient-hyprland-snap-shot",
    });
  });

  it("keeps the Cargo binary names in step with the helper names", () => {
    for (const [crate, name] of [
      ["resource-monitor", SCIENT_HELPER_EXECUTABLES.resourceMonitor],
      ["kde-snap-shot", SCIENT_HELPER_EXECUTABLES.kdeCapture],
      ["hyprland-snap-shot", SCIENT_HELPER_EXECUTABLES.hyprlandCapture],
    ] as const) {
      const manifest = NodeFS.readFileSync(
        new URL(`../../../native/${crate}/Cargo.toml`, import.meta.url),
        "utf8",
      );
      assert.include(manifest, `[[bin]]\nname = "${name}"\npath = "src/main.rs"\n`);
    }
  });

  it("keeps cloud and telemetry closed while enabling the owned updater", () => {
    assert.isFalse(SCIENT_DESKTOP_IDENTITY.outboundTelemetryEnabled);
    assert.isTrue(SCIENT_DESKTOP_IDENTITY.autoUpdateEnabled);
    assert.equal(SCIENT_DESKTOP_IDENTITY.desktopUpdateChannelPolicy, "user-selectable");
    assert.isTrue(SCIENT_DESKTOP_IDENTITY.safetyEnvelopeEnabled);
    assert.isFalse(SCIENT_DESKTOP_IDENTITY.cloudEnabled);
  });
});
