// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the remote asset seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const contractSource = NodeFS.readFileSync(
  new URL("../../../../../packages/contracts/src/environmentHttp.ts", import.meta.url),
  "utf8",
);
const serverSource = NodeFS.readFileSync(
  new URL("../../../../server/src/scient/markdown/http.ts", import.meta.url),
  "utf8",
);
const clientSource = NodeFS.readFileSync(
  new URL(
    "../../../../../packages/client-runtime/src/state/scientMarkdownHttp.ts",
    import.meta.url,
  ),
  "utf8",
);
const fileSurfaceSource = NodeFS.readFileSync(
  new URL("./ScientMarkdownFileSurface.tsx", import.meta.url),
  "utf8",
);

describe("Scient Markdown image asset seam", () => {
  it("uses one authenticated operate-scoped multipart endpoint", () => {
    expect(contractSource.match(/\/api\/scient\/markdown\/images\/upload/gu)).toHaveLength(1);
    expect(serverSource).toContain("requireEnvironmentScope(AuthOrchestrationOperateScope)");
    expect(clientSource).toContain("const payload = new FormData()");
    expect(clientSource).toContain("client.scientMarkdown.imageUpload({ headers, payload })");
  });

  it("inserts only the portable server-returned Markdown path", () => {
    expect(fileSurfaceSource).toContain("src: result.markdownSource");
    expect(fileSurfaceSource).not.toContain("URL.createObjectURL");
  });
});
