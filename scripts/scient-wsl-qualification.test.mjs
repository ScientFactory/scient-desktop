import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { test } from "vitest";
import { buildWslRuntimeInstallScript } from "../apps/desktop/src/wsl/DesktopWslEnvironment.ts";
import {
  bindWslInstallScript,
  hashFile,
  verifyWslInstallScript,
  WSL_INSTALL_BINDING,
  WSL_INSTALL_SCRIPT,
  WSL_QUALIFICATION_ARCHIVE,
} from "./scient-wsl-qualification.mjs";

const archiveSha256 = "a".repeat(64);
const otherSha256 = "b".repeat(64);
const production = (sha) =>
  buildWslRuntimeInstallScript(WSL_QUALIFICATION_ARCHIVE, `sha256-${sha}`, sha, null);
const accepted = () => {
  const script = production(archiveSha256);
  const binding = bindWslInstallScript({ script, archiveSha256, attempt: 2 });
  return {
    script,
    binding,
    archiveSha256,
    attempt: "2",
    scriptSha256: binding.installScriptSha256,
  };
};

test("accepts production's script bound to this attempt and archive", () => {
  verifyWslInstallScript(accepted());
});

test("refuses a script from another attempt, archive, path or recording", () => {
  const cases = [
    (input) => ({ ...input, attempt: "3" }),
    (input) => ({ ...input, archiveSha256: otherSha256 }),
    (input) => ({ ...input, scriptSha256: otherSha256 }),
    (input) => ({ ...input, binding: { ...input.binding, archivePath: "/tmp/other.tar.gz" } }),
    (input) => ({ ...input, script: `${input.script}\n` }),
  ];
  for (const change of cases) {
    NodeAssert.throws(() => verifyWslInstallScript(change(accepted())));
  }
});

test("refuses a consistently rebound script for another archive or path", () => {
  for (const script of [
    production(otherSha256),
    buildWslRuntimeInstallScript(
      "/tmp/other.tar.gz",
      `sha256-${archiveSha256}`,
      archiveSha256,
      null,
    ),
  ]) {
    const binding = bindWslInstallScript({ script, archiveSha256, attempt: 2 });
    NodeAssert.throws(() =>
      verifyWslInstallScript({
        script,
        binding,
        archiveSha256,
        attempt: "2",
        scriptSha256: binding.installScriptSha256,
      }),
    );
  }
});

test("the installer job's writer emits production's script and its binding", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-wsl-writer-"));
  try {
    const archive = NodePath.join(directory, "wsl-runtime.tar.gz");
    NodeFS.writeFileSync(archive, "payload");
    const sha = hashFile(archive);
    const writer = NodePath.join(import.meta.dirname, "write-scient-wsl-install-script.mjs");
    const result = NodeChildProcess.spawnSync(process.execPath, [writer, archive, sha, "4"], {
      encoding: "utf8",
    });
    NodeAssert.equal(result.status, 0, result.stderr);
    const script = NodeFS.readFileSync(NodePath.join(directory, WSL_INSTALL_SCRIPT), "utf8");
    const binding = JSON.parse(
      NodeFS.readFileSync(NodePath.join(directory, WSL_INSTALL_BINDING), "utf8"),
    );
    NodeAssert.equal(script, production(sha));
    verifyWslInstallScript({
      script,
      binding,
      archiveSha256: sha,
      attempt: "4",
      scriptSha256: result.stdout.trim(),
    });
    const refused = NodeChildProcess.spawnSync(process.execPath, [
      writer,
      archive,
      otherSha256,
      "4",
    ]);
    NodeAssert.notEqual(refused.status, 0);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
