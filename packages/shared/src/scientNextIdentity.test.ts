import { assert, describe, it } from "@effect/vitest";

import { SCIENT_NEXT_IDENTITY } from "./scientNextIdentity.ts";

describe("Scient Next D4 identity", () => {
  it("keeps product, protocol, state, and preview namespaces distinct from T3", () => {
    assert.equal(SCIENT_NEXT_IDENTITY.baseName, "Scient Next");
    assert.equal(SCIENT_NEXT_IDENTITY.developmentName, "Scient Next (Dev)");
    assert.equal(SCIENT_NEXT_IDENTITY.appId, "com.scientfactory.scient.next");
    assert.equal(SCIENT_NEXT_IDENTITY.developmentAppId, "com.scientfactory.scient.next.dev");
    assert.equal(SCIENT_NEXT_IDENTITY.productionScheme, "scient-next");
    assert.equal(SCIENT_NEXT_IDENTITY.developmentScheme, "scient-next-dev");
    assert.equal(SCIENT_NEXT_IDENTITY.productionUserDataDirName, "scient-next");
    assert.equal(SCIENT_NEXT_IDENTITY.developmentUserDataDirName, "scient-next-dev");
    assert.equal(SCIENT_NEXT_IDENTITY.previewPartitionPrefix, "persist:scient-next-preview-");
    assert.equal(SCIENT_NEXT_IDENTITY.clientSettingsStorageKey, "scient-next:client-settings:v1");
  });

  it("fails closed for D4 outbound telemetry and update publication", () => {
    assert.isFalse(SCIENT_NEXT_IDENTITY.outboundTelemetryEnabled);
    assert.isFalse(SCIENT_NEXT_IDENTITY.autoUpdateEnabled);
    assert.isTrue(SCIENT_NEXT_IDENTITY.safetyEnvelopeEnabled);
    assert.isFalse(SCIENT_NEXT_IDENTITY.cloudEnabled);
  });
});
