import { assert, describe, it } from "@effect/vitest";

import { SCIENT_DESKTOP_IDENTITY } from "./scientDesktopIdentity.ts";

describe("Scient desktop identity", () => {
  it("uses the canonical production identity while keeping development and data isolated", () => {
    assert.equal(SCIENT_DESKTOP_IDENTITY.baseName, "Scient");
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
      SCIENT_DESKTOP_IDENTITY.clientSettingsStorageKey,
      "scient-next:client-settings:v1",
    );
  });

  it("keeps cloud and telemetry closed while enabling the owned updater", () => {
    assert.isFalse(SCIENT_DESKTOP_IDENTITY.outboundTelemetryEnabled);
    assert.isTrue(SCIENT_DESKTOP_IDENTITY.autoUpdateEnabled);
    assert.isTrue(SCIENT_DESKTOP_IDENTITY.safetyEnvelopeEnabled);
    assert.isFalse(SCIENT_DESKTOP_IDENTITY.cloudEnabled);
  });
});
