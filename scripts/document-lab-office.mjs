#!/usr/bin/env node
// Pinned LibreOffice for Document Lab jobs: `provision --dest <dir>`, `setup` (dev candidate
// receipt; `--use-installed <soffice>` for an unverified install of the pinned version) and
// `qualify --soffice <path> [--evidence <dir>]`. Archives with another size or digest are refused.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  OFFICE_TOOLCHAIN,
  isPinnedOfficeVersion,
  officePlatformArch,
} from "../apps/server/src/scient/documents/docxJob/officeToolchainManifest.ts";
import { resolveLocalDevAppPaths } from "./local-dev-app.mjs";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone script serves the real host.
const host = { platform: process.platform, arch: process.arch };
const repoRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const QUALIFICATION_CASES = 4;

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return NodePath.resolve(value);
}

function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${NodePath.basename(command)} exited with ${result.status ?? result.signal}: ${result.stderr}`,
    );
  }
  return result.stdout;
}

function currentAsset() {
  const platformArch = officePlatformArch(host.platform, host.arch);
  if (platformArch === undefined) {
    throw new Error(
      `No pinned LibreOffice for ${host.platform}-${host.arch}; jobs stay unavailable.`,
    );
  }
  return { platformArch, asset: OFFICE_TOOLCHAIN.assets[platformArch] };
}

async function sha256File(file) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function download(asset, file) {
  const response = await fetch(asset.url, { redirect: "error" });
  if (!response.ok || response.body === null)
    throw new Error(`Download failed: ${response.status}`);
  if (!OFFICE_TOOLCHAIN.allowedHosts.includes(new URL(response.url).hostname)) {
    throw new Error("The download came from an unexpected host.");
  }
  const out = NodeFS.createWriteStream(file, { flags: "wx", mode: 0o600 });
  for await (const chunk of response.body) {
    if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
  }
  await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
}

function findFile(root, relativeEnd, depth = 6) {
  const entries = NodeFS.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = NodePath.join(root, entry.name);
    if (entry.isFile() && path.replaceAll("\\", "/").endsWith(relativeEnd)) return path;
  }
  if (depth === 0) return undefined;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const found = findFile(NodePath.join(root, entry.name), relativeEnd, depth - 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function unpack(asset, archive, dest) {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-office-unpack-"));
  try {
    if (asset.archive === "dmg") {
      const mount = NodePath.join(scratch, "mount");
      NodeFS.mkdirSync(mount);
      run("hdiutil", [
        "attach",
        "-nobrowse",
        "-readonly",
        "-noautoopen",
        "-mountpoint",
        mount,
        archive,
      ]);
      try {
        run("ditto", [
          NodePath.join(mount, "LibreOffice.app"),
          NodePath.join(dest, "LibreOffice.app"),
        ]);
      } finally {
        run("hdiutil", ["detach", mount, "-force"]);
      }
      return findFile(dest, "LibreOffice.app/Contents/MacOS/soffice");
    }
    if (asset.archive === "msi") {
      // An administrative install only unpacks files into TARGETDIR; nothing is registered.
      run("msiexec", ["/a", archive, "/qn", `TARGETDIR=${dest}`]);
      return findFile(dest, "program/soffice.com");
    }
    run("tar", ["-xzf", archive, "-C", scratch]);
    const debs = listDebs(scratch);
    if (debs.length === 0) throw new Error("The archive holds no packages.");
    for (const deb of debs) run("dpkg-deb", ["-x", deb, dest]);
    return findFile(dest, "program/soffice");
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

function listDebs(root) {
  const found = [];
  for (const entry of NodeFS.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".deb"))
      found.push(NodePath.join(entry.parentPath, entry.name));
  }
  return found.sort();
}

/** `soffice --version` with a throwaway profile and no inherited environment, as jobs run it. */
function probe(soffice) {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-office-probe-"));
  try {
    const env =
      host.platform === "win32"
        ? {
            SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\Windows",
            PATH: `${process.env.SYSTEMROOT ?? "C:\\Windows"}\\System32`,
            USERPROFILE: scratch,
            APPDATA: scratch,
            LOCALAPPDATA: scratch,
            TEMP: scratch,
            TMP: scratch,
          }
        : { HOME: scratch, TMPDIR: scratch, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
    return run(
      soffice,
      [
        `-env:UserInstallation=${NodeURL.pathToFileURL(NodePath.join(scratch, "profile")).href}`,
        "--version",
      ],
      { env, timeout: 120_000 },
    ).trim();
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

async function provision(dest, archiveOption) {
  const { platformArch, asset } = currentAsset();
  NodeFS.mkdirSync(dest, { recursive: true });
  const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-office-"));
  try {
    const archive = archiveOption ?? NodePath.join(work, asset.fileName);
    if (archiveOption === undefined) await download(asset, archive);
    if (NodeFS.statSync(archive).size !== asset.sizeBytes)
      throw new Error("The archive size is not the pinned size.");
    const digest = await sha256File(archive);
    if (digest !== asset.sha256) throw new Error("The archive digest is not the pinned digest.");
    const soffice = unpack(asset, archive, dest);
    if (soffice === undefined) throw new Error("The unpacked archive has no soffice.");
    const printed = probe(soffice);
    if (!isPinnedOfficeVersion(printed)) throw new Error(`Unexpected engine: ${printed}`);
    return { platformArch, sofficePath: soffice, archiveSha256: digest, engine: printed };
  } finally {
    NodeFS.rmSync(work, { recursive: true, force: true });
  }
}

async function setup(args) {
  const { stateRoot } = resolveLocalDevAppPaths({ role: "candidate" });
  const officeRoot = NodePath.join(stateRoot, "document-lab", "office");
  NodeFS.mkdirSync(officeRoot, { recursive: true, mode: 0o700 });
  const installed = option(args, "--use-installed");
  let receipt;
  if (installed !== undefined) {
    const { platformArch } = currentAsset();
    const printed = probe(installed);
    if (!isPinnedOfficeVersion(printed)) throw new Error(`Not the pinned engine: ${printed}`);
    receipt = {
      platformArch,
      sofficePath: installed,
      archiveSha256: null,
      provisioning: "host-install",
    };
  } else {
    const dest = NodeFS.mkdtempSync(NodePath.join(officeRoot, "runtime-"));
    try {
      const done = await provision(dest, option(args, "--archive"));
      receipt = { ...done, provisioning: "pinned-archive" };
    } catch (error) {
      NodeFS.rmSync(dest, { recursive: true, force: true });
      throw error;
    }
  }
  const staged = NodePath.join(officeRoot, `active-${process.pid}.json`);
  NodeFS.writeFileSync(
    staged,
    JSON.stringify({
      version: 1,
      engine: OFFICE_TOOLCHAIN.engine,
      engineVersion: OFFICE_TOOLCHAIN.version,
      buildId: OFFICE_TOOLCHAIN.buildId,
      platformArch: receipt.platformArch,
      provisioning: receipt.provisioning,
      archiveSha256: receipt.archiveSha256,
      sofficePath: receipt.sofficePath,
    }),
    { flag: "wx", mode: 0o600 },
  );
  NodeFS.renameSync(staged, NodePath.join(officeRoot, "active.json"));
  console.log(`Document Lab office engine ready (${receipt.provisioning}): ${receipt.sofficePath}`);
  console.log("Start or restart the candidate so its server offers scient_docx_tracked_replace.");
}

function qualify(args) {
  const soffice = option(args, "--soffice");
  if (soffice === undefined) throw new Error("qualify needs --soffice <path>.");
  const evidence = option(args, "--evidence");
  const report = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-office-qualify-")),
    "report.json",
  );
  const result = NodeChildProcess.spawnSync(
    "pnpm",
    [
      "exec",
      "vp",
      "test",
      "run",
      "src/scient/documents/docxJob/DocxTrackedReplacement.integration.test.ts",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${report}`,
    ],
    {
      cwd: NodePath.join(repoRoot, "apps", "server"),
      stdio: "inherit",
      shell: host.platform === "win32",
      env: {
        ...process.env,
        SCIENT_DOCUMENT_LAB_SOFFICE: soffice,
        ...(evidence === undefined ? {} : { SCIENT_DOCUMENT_LAB_EVIDENCE_OUT: evidence }),
      },
    },
  );
  const summary = JSON.parse(NodeFS.readFileSync(report, "utf8"));
  if (
    result.status !== 0 ||
    summary.numPassedTests !== QUALIFICATION_CASES ||
    summary.numFailedTests !== 0
  ) {
    throw new Error(
      `Expected ${QUALIFICATION_CASES} real-engine cases to pass, got ${summary.numPassedTests}.`,
    );
  }
  console.log(`All ${QUALIFICATION_CASES} real-engine cases passed.`);
}

const [command, ...args] = process.argv.slice(2);
if (command === "provision") {
  const dest = option(args, "--dest");
  if (dest === undefined) throw new Error("provision needs --dest <dir>.");
  console.log(JSON.stringify(await provision(dest, option(args, "--archive"))));
} else if (command === "setup") {
  await setup(args);
} else if (command === "qualify") {
  qualify(args);
} else {
  throw new Error("Use provision, setup or qualify.");
}
