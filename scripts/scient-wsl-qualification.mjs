import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

// The installer job writes production's install script for this archive path; the Linux
// verifier places the downloaded tarball here, so it needs no workspace to generate the script.
export const WSL_QUALIFICATION_ARCHIVE = "/tmp/scient-wsl-qualification/wsl-runtime.tar.gz";
export const WSL_INSTALL_SCRIPT = "wsl-runtime-install.sh";
export const WSL_INSTALL_BINDING = "wsl-runtime-install.json";

const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const ATTEMPT = /^[1-9][0-9]*$/u;
const sha256 = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export const hashFile = (path) => sha256(NodeFS.readFileSync(path));

export function bindWslInstallScript({ script, archiveSha256, attempt }) {
  NodeAssert.match(archiveSha256, HEX_SHA256, "The WSL archive SHA-256 must be 64 hex digits");
  NodeAssert.match(String(attempt), ATTEMPT, "The run attempt must be a positive integer");
  return {
    attempt: String(attempt),
    archivePath: WSL_QUALIFICATION_ARCHIVE,
    archiveSha256,
    installScriptSha256: sha256(script),
  };
}

// Refuses a script from another attempt, another archive or another archive path before it runs.
export function verifyWslInstallScript({ script, binding, archiveSha256, attempt, scriptSha256 }) {
  NodeAssert.match(archiveSha256, HEX_SHA256, "Pass the installer's recorded WSL SHA-256");
  NodeAssert.match(
    scriptSha256,
    HEX_SHA256,
    "Pass the installer's recorded install-script SHA-256",
  );
  NodeAssert.equal(binding.attempt, String(attempt), "Install script is from another attempt");
  NodeAssert.equal(
    binding.archivePath,
    WSL_QUALIFICATION_ARCHIVE,
    "Install script targets another path",
  );
  NodeAssert.equal(
    binding.archiveSha256,
    archiveSha256,
    "Install script is bound to another archive",
  );
  const actual = sha256(script);
  NodeAssert.equal(binding.installScriptSha256, actual, "Install script differs from its binding");
  NodeAssert.equal(
    actual,
    scriptSha256,
    "Install script differs from the one the installer recorded",
  );
  NodeAssert.deepEqual(
    [...new Set(script.match(/[0-9a-f]{64}/gu))],
    [archiveSha256],
    "Install script must embed exactly the archive's SHA-256",
  );
  NodeAssert.ok(
    script.includes(shellQuote(WSL_QUALIFICATION_ARCHIVE)),
    "Install script must read the fixed qualification archive",
  );
}
