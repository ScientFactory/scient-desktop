import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { buildWslRuntimeInstallScript } from "../apps/desktop/src/wsl/DesktopWslEnvironment.ts";
import {
  bindWslInstallScript,
  hashFile,
  WSL_INSTALL_BINDING,
  WSL_INSTALL_SCRIPT,
  WSL_QUALIFICATION_ARCHIVE,
} from "./scient-wsl-qualification.mjs";

// node scripts/write-scient-wsl-install-script.mjs <wsl-runtime.tar.gz> <sha256> <attempt>
// Writes production's install script and its binding beside the tarball; prints the script's SHA-256.
const [archive, archiveSha256, attempt] = process.argv.slice(2);
NodeAssert.ok(archive && archiveSha256 && attempt, "Pass the tarball, its SHA-256 and the attempt");
NodeAssert.equal(hashFile(archive), archiveSha256, "Tarball differs from its recorded SHA-256");
const script = buildWslRuntimeInstallScript(
  WSL_QUALIFICATION_ARCHIVE,
  `sha256-${archiveSha256}`,
  archiveSha256,
  null,
);
const binding = bindWslInstallScript({ script, archiveSha256, attempt });
const directory = NodePath.dirname(archive);
NodeFS.writeFileSync(NodePath.join(directory, WSL_INSTALL_SCRIPT), script);
NodeFS.writeFileSync(
  NodePath.join(directory, WSL_INSTALL_BINDING),
  `${JSON.stringify(binding, null, 2)}\n`,
);
console.log(binding.installScriptSha256);
