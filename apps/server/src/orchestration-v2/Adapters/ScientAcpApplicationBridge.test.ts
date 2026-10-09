import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  scientAcpApplicationBridge,
  scientAcpAwarenessBridge,
  scientAcpReceiptBridge,
} from "./ScientAcpApplicationBridge.ts";

describe("Scient ACP application bridge", () => {
  it("builds awareness only from capabilities granted to this session", () => {
    const preview = scientAcpAwarenessBridge.scientAwareness?.(new Set(["preview"]));
    const coreOnly = scientAcpApplicationBridge.scientAwareness?.(new Set());

    assert.include(preview, "## Scient browser");
    assert.notInclude(coreOnly, "## Scient browser");
    assert.isFalse("scientAwareness" in scientAcpReceiptBridge);
  });

  it.effect("classifies native acceptance and pre-acceptance rejection consistently", () =>
    Effect.gen(function* () {
      const acceptedAt = yield* DateTime.now;
      assert.deepEqual(
        scientAcpReceiptBridge.nativeTurnAcceptance?.({ acceptedAt, promptOffered: true }),
        { nativeAcceptance: "accepted", acceptedAt },
      );
      assert.deepEqual(
        scientAcpReceiptBridge.nativeTurnAcceptance?.({ acceptedAt: null, promptOffered: true }),
        { nativeAcceptance: "unknown" },
      );
      assert.deepEqual(
        scientAcpReceiptBridge.nativeTurnAcceptance?.({ acceptedAt: null, promptOffered: false }),
        { nativeAcceptance: "pending" },
      );
      assert.isTrue(scientAcpReceiptBridge.isPreAcceptanceRejectionCode?.(-32602));
      assert.isFalse(scientAcpReceiptBridge.isPreAcceptanceRejectionCode?.(-32603));
    }),
  );
});
