// @effect-diagnostics nodeBuiltinImport:off -- Authenticode changes the executable before this hook.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { publicationDigest } from "@t3tools/shared/scientPublicationArtifact";
import { expect, it } from "vite-plus/test";
import afterSign from "./publication-after-sign.ts";

it("refreshes the receipt from the final Windows executable", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-signed-publication-"));
  const directory = NodePath.join(root, "resources/file-exchange");
  NodeFS.mkdirSync(directory, { recursive: true });
  const receipt = NodePath.join(directory, "publication-artifact.json");
  const bytes = Buffer.from("final signed executable");
  NodeFS.writeFileSync(receipt, JSON.stringify({ protocol: 1, sha256: "unsigned" }));
  NodeFS.writeFileSync(NodePath.join(directory, "scient-file-publication.exe"), bytes);
  try {
    afterSign({ appOutDir: root, electronPlatformName: "win32" });
    expect(JSON.parse(NodeFS.readFileSync(receipt, "utf8"))).toEqual({
      protocol: 1,
      sha256: publicationDigest(bytes),
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
