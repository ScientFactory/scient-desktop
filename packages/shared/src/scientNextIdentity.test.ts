import { assert, describe, it } from "@effect/vitest";

import { SCIENT_NEXT_IDENTITY } from "./scientNextIdentity.ts";

describe("Scient desktop identity", () => {
  it("uses the canonical production identity while keeping development and data isolated", () => {
    assert.equal(SCIENT_NEXT_IDENTITY.baseName, "Scient");
    assert.equal(SCIENT_NEXT_IDENTITY.developmentName, "Scient (Dev)");
    assert.equal(SCIENT_NEXT_IDENTITY.appId, "com.scientfactory.scient");
    assert.equal(SCIENT_NEXT_IDENTITY.developmentAppId, "com.scientfactory.scient.next.dev");
    assert.equal(SCIENT_NEXT_IDENTITY.productionScheme, "scient");
    assert.equal(SCIENT_NEXT_IDENTITY.developmentScheme, "scient-next-dev");
    assert.equal(SCIENT_NEXT_IDENTITY.productionUserDataDirName, "scient-next");
    assert.equal(SCIENT_NEXT_IDENTITY.developmentUserDataDirName, "scient-next-dev");
    assert.equal(SCIENT_NEXT_IDENTITY.serviceUnitName, "scient.service");
    assert.equal(SCIENT_NEXT_IDENTITY.serviceLaunchdLabel, "com.scientfactory.scient.service");
    assert.equal(SCIENT_NEXT_IDENTITY.previewPartitionPrefix, "persist:scient-next-preview-");
    assert.equal(SCIENT_NEXT_IDENTITY.clientSettingsStorageKey, "scient-next:client-settings:v1");
  });

  it("keeps cloud and telemetry closed while enabling the owned updater", () => {
    assert.isFalse(SCIENT_NEXT_IDENTITY.outboundTelemetryEnabled);
    assert.isTrue(SCIENT_NEXT_IDENTITY.autoUpdateEnabled);
    assert.isTrue(SCIENT_NEXT_IDENTITY.safetyEnvelopeEnabled);
    assert.isFalse(SCIENT_NEXT_IDENTITY.cloudEnabled);
  });
});
