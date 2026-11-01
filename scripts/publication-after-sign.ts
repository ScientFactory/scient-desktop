// @effect-diagnostics nodeBuiltinImport:off -- electron-builder hook runs after Authenticode.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { publicationDigest } from "@t3tools/shared/scientPublicationArtifact";

export default function afterSign(context: { appOutDir: string; electronPlatformName: string }) {
  if (context.electronPlatformName !== "win32") return;
  const directory = NodePath.join(context.appOutDir, "resources/file-exchange");
  const receipt = NodePath.join(directory, "publication-artifact.json");
  NodeFS.writeFileSync(
    receipt,
    JSON.stringify({
      ...JSON.parse(NodeFS.readFileSync(receipt, "utf8")),
      sha256: publicationDigest(
        NodeFS.readFileSync(NodePath.join(directory, "scient-file-publication.exe")),
      ),
    }) + "\n",
  );
}
