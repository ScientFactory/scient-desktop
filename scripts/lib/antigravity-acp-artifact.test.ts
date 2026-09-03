import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { inspectAntigravityAcpArtifact } from "./antigravity-acp-artifact.ts";

const completeArchive = Buffer.from(
  "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWzLyU9OzFHISCzKSy0u5gIAUEsBAhQDFAAAAAgAAAAiXXMTL+gUAAAAFAAAABIAAAAAAAAAAAAAAO2BAAAAAGFneV9hY3Bfc2VydmVyLnBhclBLAQIUAxQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAAAAAAAAAAADtgUQAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwUGAAAAAAIAAgCDAAAAhwAAAAAA",
  "base64",
);

describe("Antigravity ACP artifact inspection", () => {
  it("streams the full ZIP and returns immutable archive and member facts", async () => {
    await expect(
      inspectAntigravityAcpArtifact(
        new Response(completeArchive),
        "agy_acp_server.par",
        "localharness_external",
      ),
    ).resolves.toEqual({
      digest: NodeCrypto.createHash("sha256").update(completeArchive).digest("hex"),
      size: completeArchive.byteLength,
      executableBytes: 20,
      harnessBytes: 14,
    });
  });

  it("rejects malformed archives and unexpected members", async () => {
    await expect(
      inspectAntigravityAcpArtifact(
        new Response("not a zip"),
        "agy_acp_server.par",
        "localharness_external",
      ),
    ).rejects.toThrow();
    await expect(
      inspectAntigravityAcpArtifact(
        new Response(completeArchive),
        "unexpected-server",
        "localharness_external",
      ),
    ).rejects.toThrow(/unexpected or unsafe member/u);
  });
});
