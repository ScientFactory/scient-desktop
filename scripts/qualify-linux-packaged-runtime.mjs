import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { extractFile, listPackage, statFile } from "@electron/asar";
import { runDesktopSmoke } from "../apps/desktop/scripts/smoke-test.mjs";

const runtimeFiles = [
  "resource-monitor/t3-resource-monitor",
  "whisper-runtime/whisper-server",
  "synctex-runtime/synctex",
  "kde-capture/t3-kde-snap-shot",
  "hyprland-capture/t3-hyprland-snap-shot",
];
const stagingPrefix = "apps/desktop/prod-resources/";
const runtimeDirectories = runtimeFiles.map((file) => file.split("/")[0]);
const iconMember = `${stagingPrefix}icon.png`;
const digest = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const members = (archive) => listPackage(archive).map((name) => name.replace(/^\//, ""));
const isDuplicate = (name) =>
  runtimeDirectories.some(
    (dir) => name === `${stagingPrefix}${dir}` || name.startsWith(`${stagingPrefix}${dir}/`),
  );

/** Inspect the extracted AppImage rather than the checkout or linux-unpacked stage. */
export function inspectLinuxPayload(root) {
  const resources = NodePath.join(root, "resources");
  const archive = NodePath.join(resources, "app.asar");
  const entries = members(archive);
  NodeAssert.deepEqual(
    entries.filter(isDuplicate),
    [],
    "Duplicate runtime staging trees in app.asar",
  );
  NodeAssert.deepEqual(
    entries.filter((name) => name.endsWith(".map")),
    [],
    "Source maps in app.asar",
  );
  NodeAssert.ok(entries.includes(iconMember), "Archived Linux registration icon is required");
  NodeAssert.equal(
    extractFile(archive, iconMember).subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
  );
  for (const file of runtimeFiles) {
    const stat = NodeFS.statSync(NodePath.join(resources, file));
    NodeAssert.ok(
      stat.isFile() && stat.size > 0,
      `Required external binary is missing or empty: ${file}`,
    );
    NodeAssert.ok(stat.mode & 0o111, `Required external binary is not executable: ${file}`);
  }
  for (const dir of ["synctex-runtime", "whisper-runtime"]) {
    NodeAssert.ok(
      NodeFS.readdirSync(NodePath.join(resources, dir)).some((name) =>
        /license|copying/i.test(name),
      ),
      `${dir} license is required`,
    );
    NodeAssert.ok(
      NodeFS.readdirSync(NodePath.join(resources, dir)).some((name) => name.endsWith(".json")),
      `${dir} provenance is required`,
    );
  }
  NodeAssert.ok(
    NodeFS.readdirSync(NodePath.join(resources, "whisper-runtime")).some((name) =>
      name.includes(".so"),
    ),
    "Whisper shared libraries are required",
  );
  return { resources, archive, entries };
}

/** Same-stage AppImages differ only in the five explicitly restored ASAR trees. */
export function compareLinuxPayloads(cleanRoot, baselineRoot) {
  const clean = inspectLinuxPayload(cleanRoot);
  const baselineArchive = NodePath.join(baselineRoot, "resources/app.asar");
  const baselineEntries = members(baselineArchive);
  NodeAssert.deepEqual(
    baselineEntries.filter((name) => !isDuplicate(name)).sort(),
    [...clean.entries].sort(),
  );
  let restoredBytes = 0;
  for (const name of clean.entries) {
    // listPackage includes directories. Only leaves have byte content.
    if (statFile(clean.archive, name).files) continue;
    NodeAssert.equal(
      digest(extractFile(clean.archive, name)),
      digest(extractFile(baselineArchive, name)),
      `Retained ASAR bytes changed: ${name}`,
    );
  }
  for (const dir of runtimeDirectories) {
    const source = NodePath.join(clean.resources, dir);
    for (const file of NodeFS.readdirSync(source, { recursive: true })) {
      const path = NodePath.join(source, file);
      const stat = NodeFS.statSync(path);
      if (!stat.isFile()) continue;
      const member = `${stagingPrefix}${dir}/${file}`;
      NodeAssert.ok(baselineEntries.includes(member), `Baseline did not restore ${member}`);
      NodeAssert.equal(
        digest(extractFile(baselineArchive, member)),
        digest(NodeFS.readFileSync(path)),
        `Baseline staging bytes changed: ${member}`,
      );
      restoredBytes += stat.size;
    }
  }
  // The external runtime owners, other resources, and executable modes must be identical.
  const resourceFiles = NodeFS.readdirSync(clean.resources, { recursive: true }).filter(
    (name) => name !== "app.asar",
  );
  NodeAssert.deepEqual(
    NodeFS.readdirSync(NodePath.join(baselineRoot, "resources"), { recursive: true })
      .filter((name) => name !== "app.asar")
      .sort(),
    [...resourceFiles].sort(),
  );
  for (const file of resourceFiles) {
    const path = NodePath.join(clean.resources, file);
    const stat = NodeFS.statSync(path);
    if (!stat.isFile()) continue;
    const baselinePath = NodePath.join(baselineRoot, "resources", file);
    NodeAssert.equal(
      digest(NodeFS.readFileSync(path)),
      digest(NodeFS.readFileSync(baselinePath)),
      `External bytes changed: ${file}`,
    );
    NodeAssert.equal(
      stat.mode & 0o777,
      NodeFS.statSync(baselinePath).mode & 0o777,
      `External mode changed: ${file}`,
    );
  }
  return { restoredBytes, retainedArchiveBytesVerified: true, externalBytesAndModesVerified: true };
}

async function qualify() {
  // eslint-disable-next-line t3code/no-global-process-runtime -- Standalone target-host qualification, not application runtime policy.
  NodeAssert.equal(process.platform, "linux", "Run on the target Linux host");
  const [image, root, reportPath, baselineImage, baselineRoot] = process.argv
    .slice(2)
    .map((value) => NodePath.resolve(value));
  NodeAssert.ok(
    image && root && reportPath && baselineImage && baselineRoot,
    "Pass AppImage, extracted root, report, baseline AppImage and extracted baseline root",
  );
  const { resources, archive } = inspectLinuxPayload(root);
  const profile = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-linux-qualification-"));
  const env = {
    ...process.env,
    SCIENT_NEXT_HOME: NodePath.join(profile, "state"),
    XDG_CONFIG_HOME: NodePath.join(profile, "config"),
    XDG_DATA_HOME: NodePath.join(profile, "data"),
    XDG_CACHE_HOME: NodePath.join(profile, "cache"),
    XDG_RUNTIME_DIR: NodePath.join(profile, "runtime"),
    XDG_CURRENT_DESKTOP: "",
    T3CODE_DISABLE_AUTO_UPDATE: "true",
    ELECTRON_ENABLE_LOGGING: "1",
    APPIMAGE: image,
    APPDIR: root,
  };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_NO_ASAR",
    "NODE_OPTIONS",
    "NODE_PATH",
    "VITE_DEV_SERVER_URL",
    "HYPRLAND_INSTANCE_SIGNATURE",
  ])
    delete env[key];
  NodeFS.mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  const run = (file, args, options = {}) => {
    const result = NodeChildProcess.spawnSync(file, args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    });
    NodeAssert.equal(result.error, undefined, result.error?.message);
    return result;
  };
  const binary = (file) => NodePath.join(resources, file);
  try {
    for (const file of runtimeFiles) {
      const linked = run("ldd", [binary(file)]);
      NodeAssert.equal(linked.status, 0, linked.stderr);
      NodeAssert.doesNotMatch(linked.stdout, /not found/, `Missing dynamic library: ${file}`);
    }
    const synctex = run(binary("synctex-runtime/synctex"), ["help"]);
    NodeAssert.equal(synctex.status, 0, synctex.stderr);
    NodeAssert.match(synctex.stdout + synctex.stderr, /SyncTeX/i);
    const whisper = run(binary("whisper-runtime/whisper-server"), ["--help"]);
    NodeAssert.equal(whisper.status, 0, whisper.stderr);
    NodeAssert.match(whisper.stdout + whisper.stderr, /--request-path/);
    const monitor = run(binary("resource-monitor/t3-resource-monitor"), [], {
      input:
        [
          {
            version: 3,
            type: "configure",
            rootPid: process.pid,
            sampleIntervalMs: 0,
            externalProcesses: [],
          },
          { version: 3, type: "sampleNow", requestId: "qualification" },
          { version: 3, type: "shutdown" },
        ]
          .map((command) => JSON.stringify(command))
          .join("\n") + "\n",
    });
    NodeAssert.equal(monitor.status, 0, monitor.stderr);
    const events = monitor.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    NodeAssert.ok(
      events.some(
        (event) => event.type === "hello" && event.platform === "linux" && event.version === 3,
      ),
    );
    const sample = events.find((event) => event.requestId === "qualification");
    NodeAssert.ok(
      sample?.processes.some((entry) => entry.pid === process.pid),
      "Resource monitor must sample this synthetic process",
    );
    NodeAssert.ok(!events.some((event) => event.type === "error"), monitor.stdout);
    const kde = run(binary("kde-capture/t3-kde-snap-shot"), ["qualification-invalid-command"]);
    NodeAssert.equal(kde.status, 1);
    NodeAssert.match(kde.stderr, /Expected check, capture/);
    const hyprland = run(binary("hyprland-capture/t3-hyprland-snap-shot"), ["check"]);
    NodeAssert.equal(hyprland.status, 1);
    NodeAssert.match(hyprland.stderr, /requires a native Hyprland session/);
    const smoke = await runDesktopSmoke({
      executable: NodePath.join(root, "scient"),
      args: ["--no-sandbox"],
      cwd: root,
      env,
    });
    NodeFS.writeFileSync(`${reportPath}.launch.log`, smoke.output);
    NodeAssert.ok(smoke.passed, `Packaged desktop launch/shutdown failed: ${smoke.output}`);
    const icon = NodePath.join(env.XDG_DATA_HOME, "icons/scient.desktop.png");
    NodeAssert.equal(
      digest(NodeFS.readFileSync(icon)),
      digest(extractFile(archive, iconMember)),
      "Registration must consume the archived icon",
    );
    const entry = NodeFS.readFileSync(
      NodePath.join(env.XDG_DATA_HOME, "applications/scient.desktop"),
      "utf8",
    );
    NodeAssert.ok(entry.includes(image), "Registration must launch the AppImage");
    NodeAssert.match(entry, /x-scheme-handler\/scient/);
    const comparison = compareLinuxPayloads(root, baselineRoot);
    const cleanBytes = NodeFS.statSync(image).size;
    const baselineBytes = NodeFS.statSync(baselineImage).size;
    NodeAssert.ok(
      baselineBytes > cleanBytes,
      "Same-stage baseline must establish a compressed saving",
    );
    const report = {
      sourceSha: process.env.GITHUB_SHA ?? null,
      prHeadSha: process.env.QUALIFICATION_PR_HEAD ?? null,
      platform: "linux-x64",
      imageSha256: digest(NodeFS.readFileSync(image)),
      cleanAppImageBytes: cleanBytes,
      baselineAppImageBytes: baselineBytes,
      compressedSavingBytes: baselineBytes - cleanBytes,
      ...comparison,
      passed: [
        "extracted archive/resources",
        "dynamic library resolution",
        "SyncTeX CLI",
        "Whisper CLI",
        "resource monitor protocol/sample/shutdown",
        "capture helper execution/session rejection",
        "desktop survival/shutdown",
        "archived icon registration",
      ],
      limitations: [
        "Xvfb launch smoke does not establish renderer/backend readiness or visual acceptance",
        "Live KDE/Hyprland compositor capture and voice transcription remain separate acceptance",
        "Unsigned CI artifacts are not release or updater qualification",
      ],
    };
    NodeFS.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    NodeFS.rmSync(profile, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href)
  await qualify();
