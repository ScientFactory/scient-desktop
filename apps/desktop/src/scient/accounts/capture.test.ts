// @effect-diagnostics nodeBuiltinImport:off -- Generate ephemeral synthetic values instead of credential fixtures.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "vite-plus/test";
import { createCaptureDeduplicator } from "./capture.ts";

it("suppresses the click/Enter/submit duplicate with a controlled clock, then permits a changed sign-in or later retry", () => {
  const accept = createCaptureDeduplicator();
  const capture = {
    url: "https://example.test",
    username: NodeCrypto.randomBytes(16).toString("hex"),
    password: NodeCrypto.randomBytes(16).toString("hex"),
  };
  expect(accept(capture, 0)).toBe(true);
  expect(accept({ ...capture }, 4_999)).toBe(false);
  expect(accept(capture, 5_000)).toBe(true);
  expect(accept({ ...capture, password: NodeCrypto.randomBytes(16).toString("hex") }, 5_001)).toBe(
    true,
  );
  expect(accept({ ...capture, username: NodeCrypto.randomBytes(16).toString("hex") }, 5_002)).toBe(
    true,
  );
  expect(accept({ ...capture, url: "https://other.test" }, 5_003)).toBe(true);
});
