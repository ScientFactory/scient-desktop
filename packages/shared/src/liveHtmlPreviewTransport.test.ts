import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { LiveHtmlPreviewPrepareResult } from "./liveHtmlPreviewTransport";

describe("live HTML preview RPC transport", () => {
  it("preserves watched paths through the versioned success codec", () => {
    const decoded = Schema.decodeUnknownSync(LiveHtmlPreviewPrepareResult)({
      mode: "static-document",
      warnings: [],
      previewUrl: "http://g-preview.preview.localhost:5000/report.html",
      sourceIdentity: "/workspace/report.html",
      sourceRoot: "/workspace",
      watchedPaths: ["/workspace/report.html", "/workspace/theme.css"],
      watchDiscoveryLimited: true,
      localHtmlCapabilityProof: "server-issued-proof",
      localHtmlNetworkPolicy: "reviewed-static",
    });
    const encoded = Schema.encodeSync(LiveHtmlPreviewPrepareResult)(decoded);
    const roundTripped = Schema.decodeUnknownSync(LiveHtmlPreviewPrepareResult)(encoded);

    expect(decoded.watchedPaths).toEqual(["/workspace/report.html", "/workspace/theme.css"]);
    expect(decoded.sourceIdentity).toBe("/workspace/report.html");
    expect(decoded.sourceRoot).toBe("/workspace");
    expect(decoded.watchDiscoveryLimited).toBe(true);
    expect(decoded.localHtmlCapabilityProof).toBe("server-issued-proof");
    expect(decoded.localHtmlNetworkPolicy).toBe("reviewed-static");
    expect(encoded.watchedPaths).toEqual(["/workspace/report.html", "/workspace/theme.css"]);
    expect(roundTripped.watchedPaths).toEqual(["/workspace/report.html", "/workspace/theme.css"]);
    expect(roundTripped.watchDiscoveryLimited).toBe(true);
    expect(roundTripped.localHtmlCapabilityProof).toBe("server-issued-proof");
    expect(roundTripped.localHtmlNetworkPolicy).toBe("reviewed-static");
  });
});
