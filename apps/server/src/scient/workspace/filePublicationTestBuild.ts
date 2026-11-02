// @effect-diagnostics nodeBuiltinImport:off -- Builds the native helper for tests and CI, no server runtime.
/**
 * Builds the file publication helper through the shipped staging script, so a test
 * helper carries the production receipt and flags. Shared by the test fixtures and
 * the CI platform jobs, which build it once and pass it on in the environment.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import { publicationDigest } from "@t3tools/shared/scientPublicationArtifact";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const repository = NodePath.resolve(import.meta.dirname, "../../../../..");
const stage = NodePath.join(repository, "scripts/stage-file-exchange.ts");
const sources = NodePath.join(repository, "native/file-exchange");

/** The helper's sources as they are now: what a build next to this file came from. */
const sourceDigest = () => {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of [
    stage,
    ...NodeFS.readdirSync(sources)
      .sort()
      .map((name) => NodePath.join(sources, name)),
  ]) {
    hash.update(NodePath.basename(file));
    hash.update(NodeFS.readFileSync(file));
  }
  return hash.digest("hex");
};
const sourcesPath = (helper: string) => NodePath.join(NodePath.dirname(helper), "sources.sha256");

const helperBinary = () =>
  HostProcess.Platform.defaultValue() === "win32"
    ? "scient-file-publication.exe"
    : "scient-file-publication";

/** Compiles into `directory` and returns the helper's path. */
export function buildFilePublicationHelper(requested: string, probe: boolean) {
  NodeFS.mkdirSync(requested, { recursive: true });
  // The server refuses a helper reached through a link, such as macOS's /tmp.
  const directory = NodeFS.realpathSync(requested);
  const args = [stage, `--destination=${directory}`, ...(probe ? ["--probe=true"] : [])];
  if (HostProcess.Platform.defaultValue() === "win32") {
    const installer = NodePath.join(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft Visual Studio/Installer/vswhere.exe",
    );
    const installation = NodeChildProcess.execFileSync(
      installer,
      [
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
      ],
      { encoding: "utf8" },
    ).trim();
    const vcvars = NodePath.join(installation, "VC/Auxiliary/Build/vcvars64.bat");
    const build = NodePath.join(directory, "build.cmd");
    NodeFS.writeFileSync(
      build,
      `@echo off\r\ncall "${vcvars}" >nul\r\n"${process.execPath}" ${args.map((arg) => `"${arg}"`).join(" ")}\r\n`,
    );
    NodeChildProcess.execFileSync("cmd.exe", ["/d", "/c", build], {
      cwd: directory,
      stdio: "inherit",
    });
  } else NodeChildProcess.execFileSync(process.execPath, args, { stdio: "inherit" });
  const helper = NodePath.join(directory, helperBinary());
  NodeFS.writeFileSync(sourcesPath(helper), sourceDigest());
  return helper;
}

/**
 * Whether `helper` is a build of this checkout's sources of the asked kind: its receipt
 * matches its bytes and its recorded sources match the sources as they are now, so a
 * build of other sources (an older commit, another worktree) is never reused.
 */
export function builtFromThisCheckout(helper: string, probe: boolean) {
  try {
    if (NodePath.basename(helper) !== helperBinary() || NodeFS.realpathSync(helper) !== helper)
      return false;
    const receiptPath = NodePath.join(NodePath.dirname(helper), "publication-artifact.json");
    const receipt = JSON.parse(NodeFS.readFileSync(receiptPath, "utf8"));
    return (
      receipt.probe === probe &&
      receipt.sha256 === publicationDigest(NodeFS.readFileSync(helper)) &&
      NodeFS.readFileSync(sourcesPath(helper), "utf8") === sourceDigest()
    );
  } catch {
    return false;
  }
}
