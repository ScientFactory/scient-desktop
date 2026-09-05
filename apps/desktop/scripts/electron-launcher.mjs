// Keep these launcher values synchronized with
// packages/shared/src/scientDesktopIdentity.ts. This file runs before the TS
// bundle exists, so it intentionally has no TypeScript import.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  resolveDevelopmentAppDisplayName as resolveDevAppDisplayName,
  SCIENT_DEV_APP_ENV_FILE_ENV,
  SCIENT_DEV_APP_PID_FILE_ENV,
} from "./dev-app-process.mjs";
import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const desktopDir = NodePath.resolve(__dirname, "..");
const repoRoot = NodePath.resolve(desktopDir, "..", "..");
const devBundleIdSuffix = NodePath.basename(repoRoot)
  .toLowerCase()
  .replaceAll(/[^a-z0-9]+/g, "");
export function resolveDevelopmentAppDisplayName(environment = process.env, root = repoRoot) {
  return resolveDevAppDisplayName(environment, root);
}
export const APP_DISPLAY_NAME = isDevelopment ? resolveDevelopmentAppDisplayName() : "Scient";
export const APP_BUNDLE_ID = isDevelopment
  ? `com.scientfactory.scient.next.dev.${devBundleIdSuffix || "local"}`
  : "com.scientfactory.scient.next";
const APP_PROTOCOL_SCHEMES = isDevelopment ? ["scient-next-dev"] : ["scient-next"];
const LAUNCHER_VERSION = 18;
const developmentMacIconPngPath = NodePath.join(
  repoRoot,
  "assets",
  "dev",
  "blueprint-macos-1024.png",
);
const productionMacIconPngPath = NodePath.join(repoRoot, "assets", "prod", "black-macos-1024.png");
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher script has no Effect runtime.
const hostPlatform = NodeOS.platform();

function setPlistString(plistPath, key, value) {
  const replaceResult = NodeChildProcess.spawnSync(
    "plutil",
    ["-replace", key, "-string", value, plistPath],
    {
      encoding: "utf8",
    },
  );
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = NodeChildProcess.spawnSync(
    "plutil",
    ["-insert", key, "-string", value, plistPath],
    {
      encoding: "utf8",
    },
  );
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function setPlistJson(plistPath, key, value) {
  const serialized = JSON.stringify(value);
  const replaceResult = NodeChildProcess.spawnSync(
    "plutil",
    ["-replace", key, "-json", serialized, plistPath],
    {
      encoding: "utf8",
    },
  );
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = NodeChildProcess.spawnSync(
    "plutil",
    ["-insert", key, "-json", serialized, plistPath],
    {
      encoding: "utf8",
    },
  );
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function runChecked(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) {
    return;
  }

  const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to run ${command} ${args.join(" ")}: ${details}`.trim());
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function makeDevelopmentLauncherScript({
  electronBinaryPath,
  mainEntryPath,
  desktopRoot,
  environment,
}) {
  const envEntries = [
    ["VITE_DEV_SERVER_URL", environment.VITE_DEV_SERVER_URL],
    ["T3CODE_PORT", environment.T3CODE_PORT],
    ["T3CODE_HOME", environment.T3CODE_HOME],
    ["SCIENT_NEXT_HOME", environment.SCIENT_NEXT_HOME],
    ["SCIENT_DEV_APP_ROLE", environment.SCIENT_DEV_APP_ROLE],
    ["SCIENT_NEXT_SAFETY_ENVELOPE", "true"],
    ["T3CODE_COMMIT_HASH", environment.T3CODE_COMMIT_HASH],
    ["T3CODE_OTLP_TRACES_URL", environment.T3CODE_OTLP_TRACES_URL],
    ["T3CODE_OTLP_EXPORT_INTERVAL_MS", environment.T3CODE_OTLP_EXPORT_INTERVAL_MS],
    ["T3CODE_DESKTOP_APP_USER_MODEL_ID", APP_BUNDLE_ID],
  ].filter((entry) => typeof entry[1] === "string" && entry[1].trim().length > 0);
  return [
    "#!/bin/sh",
    'if [ "${SCIENT_NEXT_DEV_RUNNER_ACTIVE:-}" != "1" ]; then',
    '  launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    '  exec "$launcher_dir/../Resources/run-scient-next-dev.command"',
    "fi",
    `if [ -n "\${${SCIENT_DEV_APP_ENV_FILE_ENV}:-}" ]; then`,
    `  if [ ! -f "\$${SCIENT_DEV_APP_ENV_FILE_ENV}" ]; then`,
    `    echo "Missing development environment file: \$${SCIENT_DEV_APP_ENV_FILE_ENV}" >&2`,
    "    exit 78",
    "  fi",
    `  . "\$${SCIENT_DEV_APP_ENV_FILE_ENV}"`,
    `  rm -f "\$${SCIENT_DEV_APP_ENV_FILE_ENV}"`,
    `  unset ${SCIENT_DEV_APP_ENV_FILE_ENV}`,
    "fi",
    ...envEntries.map(([name, value]) =>
      name === "SCIENT_NEXT_SAFETY_ENVELOPE"
        ? `export ${name}=${shellSingleQuote(value)}`
        : `if [ -z "\${${name}:-}" ]; then export ${name}=${shellSingleQuote(value)}; fi`,
    ),
    `if [ -n "\${${SCIENT_DEV_APP_PID_FILE_ENV}:-}" ]; then`,
    "  umask 077",
    `  dev_pid_file_tmp="\$${SCIENT_DEV_APP_PID_FILE_ENV}.tmp.$$"`,
    '  printf "%s\\n" "$$" > "$dev_pid_file_tmp"',
    `  mv -f "$dev_pid_file_tmp" "\$${SCIENT_DEV_APP_PID_FILE_ENV}"`,
    "fi",
    `exec ${shellSingleQuote(electronBinaryPath)} --t3code-dev-root=${shellSingleQuote(desktopRoot)} ${shellSingleQuote(mainEntryPath)} "$@"`,
    "",
  ].join("\n");
}

export function resolveDevelopmentCodeSigningIdentity({
  environment = process.env,
  spawnSync = NodeChildProcess.spawnSync,
} = {}) {
  const configured = environment.SCIENT_DEV_CODESIGN_IDENTITY?.trim();
  if (configured) return configured;

  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return "-";
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = line.match(/^\s*\d+\)\s+([A-F0-9]{40})\s+"Apple Development:/u);
    if (match?.[1]) return match[1];
  }
  return "-";
}

export function makeDevelopmentCodeSigningCommand({ appBundlePath, identity, signerScriptPath }) {
  return {
    command: process.execPath,
    args: [signerScriptPath, appBundlePath, identity],
  };
}

function hasValidDevelopmentCodeIdentity(appBundlePath) {
  const verification = NodeChildProcess.spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", appBundlePath],
    { encoding: "utf8" },
  );
  if (verification.status !== 0) return false;

  const requirement = NodeChildProcess.spawnSync(
    "/usr/bin/codesign",
    ["--display", "--requirements", "-", appBundlePath],
    { encoding: "utf8" },
  );
  return (
    requirement.status === 0 &&
    `${requirement.stdout}${requirement.stderr}`.includes(`identifier "${APP_BUNDLE_ID}"`)
  );
}

function signDevelopmentAppBundle(appBundlePath, identity) {
  if (identity === "-") {
    console.warn(
      "[desktop-launcher] No Apple Development signing identity is available. The app will run with an ad hoc identity, so macOS may ask for microphone access again after the bundle changes.",
    );
  }
  const signing = makeDevelopmentCodeSigningCommand({
    appBundlePath,
    identity,
    signerScriptPath: NodePath.join(__dirname, "sign-development-app.mjs"),
  });
  runChecked(signing.command, signing.args);
  if (!hasValidDevelopmentCodeIdentity(appBundlePath)) {
    throw new Error(`Failed to establish a valid development identity for ${appBundlePath}.`);
  }
}

export function makeDevelopmentCommandScript({ desktopRoot, environment }) {
  const launcherRepoRoot = NodePath.resolve(desktopRoot, "..", "..");
  const logRoot =
    environment.SCIENT_DEV_APP_ROLE === "stable" && environment.SCIENT_NEXT_HOME
      ? environment.SCIENT_NEXT_HOME
      : NodePath.join(launcherRepoRoot, ".scient-next");
  const logPath = NodePath.join(logRoot, "local-dev-app.log");
  const nodeBinDir = NodePath.dirname(process.execPath);
  const pnpmExecPath = environment.npm_execpath?.trim();
  const localDevInvocation = pnpmExecPath
    ? `${shellSingleQuote(process.execPath)} ${shellSingleQuote(pnpmExecPath)} dev:app:start`
    : "pnpm dev:app:start";
  const roleExport = environment.SCIENT_DEV_APP_ROLE
    ? `export SCIENT_DEV_APP_ROLE=${shellSingleQuote(environment.SCIENT_DEV_APP_ROLE)}`
    : "";
  const homeExport = environment.SCIENT_NEXT_HOME
    ? `export SCIENT_NEXT_HOME=${shellSingleQuote(environment.SCIENT_NEXT_HOME)}`
    : "";
  return [
    "#!/bin/sh",
    `mkdir -p ${shellSingleQuote(NodePath.dirname(logPath))}`,
    `export PATH=${shellSingleQuote(nodeBinDir)}:"$PATH"`,
    `cd ${shellSingleQuote(launcherRepoRoot)}`,
    roleExport,
    homeExport,
    `exec ${localDevInvocation} >> ${shellSingleQuote(logPath)} 2>&1`,
    "",
  ].join("\n");
}

function writeDevelopmentLauncherScript(targetBinaryPath, electronBinaryPath) {
  NodeFS.writeFileSync(
    targetBinaryPath,
    makeDevelopmentLauncherScript({
      electronBinaryPath,
      mainEntryPath: NodePath.join(desktopDir, "dist-electron", "main.cjs"),
      desktopRoot: desktopDir,
      environment: process.env,
    }),
  );
  NodeFS.chmodSync(targetBinaryPath, 0o755);
  const appBundlePath = NodePath.resolve(targetBinaryPath, "..", "..", "..");
  const commandPath = NodePath.join(
    appBundlePath,
    "Contents",
    "Resources",
    "run-scient-next-dev.command",
  );
  NodeFS.writeFileSync(
    commandPath,
    makeDevelopmentCommandScript({ desktopRoot: desktopDir, environment: process.env }),
  );
  NodeFS.chmodSync(commandPath, 0o755);
}

function registerMacLauncherBundle(appBundlePath) {
  runChecked(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", appBundlePath],
  );

  if (!isDevelopment) {
    return;
  }

  for (const scheme of APP_PROTOCOL_SCHEMES) {
    runChecked("osascript", [
      "-l",
      "JavaScript",
      "-e",
      [
        'ObjC.import("CoreServices");',
        `const scheme = $.NSString.alloc.initWithUTF8String(${JSON.stringify(scheme)});`,
        `const bundle = $.NSString.alloc.initWithUTF8String(${JSON.stringify(APP_BUNDLE_ID)});`,
        "const status = $.LSSetDefaultHandlerForURLScheme(scheme, bundle);",
        "if (status !== 0) throw new Error(`LSSetDefaultHandlerForURLScheme failed: ${status}`);",
      ].join(" "),
    ]);
  }
}

// Bundle-internal paths are macOS paths whatever host builds them.
export function resolveMacLauncherIconPaths(runtimeDir, development = isDevelopment) {
  return {
    sourceIconPath: development ? developmentMacIconPngPath : productionMacIconPngPath,
    generatedIconPath: NodePath.posix.join(
      runtimeDir,
      development ? "icon-dev.icns" : "icon-prod.icns",
    ),
  };
}

function ensureMacIconIcns(runtimeDir) {
  const { sourceIconPath, generatedIconPath } = resolveMacLauncherIconPaths(runtimeDir);
  NodeFS.mkdirSync(runtimeDir, { recursive: true });

  if (!NodeFS.existsSync(sourceIconPath)) {
    throw new Error(`Desktop macOS icon source is missing at ${sourceIconPath}`);
  }

  const sourceMtimeMs = NodeFS.statSync(sourceIconPath).mtimeMs;
  if (
    NodeFS.existsSync(generatedIconPath) &&
    NodeFS.statSync(generatedIconPath).mtimeMs >= sourceMtimeMs
  ) {
    return generatedIconPath;
  }

  const iconsetRoot = NodeFS.mkdtempSync(NodePath.join(runtimeDir, "dev-iconset-"));
  const iconsetDir = NodePath.join(iconsetRoot, "icon.iconset");
  NodeFS.mkdirSync(iconsetDir, { recursive: true });

  try {
    for (const size of [16, 32, 128, 256, 512]) {
      runChecked("sips", [
        "-z",
        String(size),
        String(size),
        sourceIconPath,
        "--out",
        NodePath.join(iconsetDir, `icon_${size}x${size}.png`),
      ]);

      const retinaSize = size * 2;
      runChecked("sips", [
        "-z",
        String(retinaSize),
        String(retinaSize),
        sourceIconPath,
        "--out",
        NodePath.join(iconsetDir, `icon_${size}x${size}@2x.png`),
      ]);
    }

    runChecked("iconutil", ["-c", "icns", iconsetDir, "-o", generatedIconPath]);
    return generatedIconPath;
  } finally {
    NodeFS.rmSync(iconsetRoot, { recursive: true, force: true });
  }
}

function patchMainBundleInfoPlist(appBundlePath, iconPath, executableName) {
  const infoPlistPath = NodePath.join(appBundlePath, "Contents", "Info.plist");
  setPlistString(infoPlistPath, "CFBundleDisplayName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleIdentifier", APP_BUNDLE_ID);
  setPlistString(infoPlistPath, "CFBundleExecutable", executableName);
  setPlistString(infoPlistPath, "CFBundleIconFile", "icon.icns");
  setPlistJson(infoPlistPath, "CFBundleURLTypes", [
    {
      CFBundleURLName: APP_BUNDLE_ID,
      CFBundleURLSchemes: APP_PROTOCOL_SCHEMES,
    },
  ]);

  const resourcesDir = NodePath.join(appBundlePath, "Contents", "Resources");
  NodeFS.copyFileSync(iconPath, NodePath.join(resourcesDir, "icon.icns"));
  NodeFS.copyFileSync(iconPath, NodePath.join(resourcesDir, "electron.icns"));
}

function patchHelperBundleInfoPlists(appBundlePath) {
  const helperBundleNames = [
    ["Electron Helper.app", "helper", `${APP_DISPLAY_NAME} Helper`],
    ["Electron Helper (GPU).app", "helper.gpu", `${APP_DISPLAY_NAME} Helper (GPU)`],
    ["Electron Helper (Plugin).app", "helper.plugin", `${APP_DISPLAY_NAME} Helper (Plugin)`],
    ["Electron Helper (Renderer).app", "helper.renderer", `${APP_DISPLAY_NAME} Helper (Renderer)`],
  ];

  for (const [bundleName, bundleIdentifierSuffix, bundleDisplayName] of helperBundleNames) {
    const infoPlistPath = NodePath.join(
      appBundlePath,
      "Contents",
      "Frameworks",
      bundleName,
      "Contents",
      "Info.plist",
    );
    if (!NodeFS.existsSync(infoPlistPath)) {
      continue;
    }

    setPlistString(infoPlistPath, "CFBundleDisplayName", bundleDisplayName);
    setPlistString(infoPlistPath, "CFBundleName", bundleDisplayName);
    setPlistString(
      infoPlistPath,
      "CFBundleIdentifier",
      `${APP_BUNDLE_ID}.${bundleIdentifierSuffix}`,
    );
  }
}

function readJson(path) {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function resolveMacLauncherPaths(appBundlePath, displayName = APP_DISPLAY_NAME) {
  const executableDir = NodePath.posix.join(appBundlePath, "Contents", "MacOS");
  const launcherExecutableName = `${displayName} Launcher`;
  return {
    launcherExecutableName,
    launcherBinaryPath: NodePath.posix.join(executableDir, launcherExecutableName),
    runtimeElectronBinaryPath: NodePath.posix.join(executableDir, "Electron"),
  };
}

function buildMacLauncher(electronBinaryPath) {
  const sourceAppBundlePath = NodePath.resolve(NodePath.dirname(electronBinaryPath), "../..");
  const runtimeDir = NodePath.join(desktopDir, ".electron-runtime");
  const targetAppBundlePath = NodePath.join(runtimeDir, `${APP_DISPLAY_NAME}.app`);
  const developmentPaths = resolveMacLauncherPaths(targetAppBundlePath);
  const runtimeElectronBinaryPath = developmentPaths.runtimeElectronBinaryPath;
  const launcherBinaryPath = isDevelopment
    ? developmentPaths.launcherBinaryPath
    : runtimeElectronBinaryPath;
  const iconPath = ensureMacIconIcns(runtimeDir);
  const metadataPath = NodePath.join(runtimeDir, "metadata.json");
  const signingIdentity = isDevelopment ? resolveDevelopmentCodeSigningIdentity() : undefined;

  NodeFS.mkdirSync(runtimeDir, { recursive: true });

  const expectedMetadata = {
    launcherVersion: LAUNCHER_VERSION,
    sourceAppBundlePath,
    sourceAppMtimeMs: NodeFS.statSync(sourceAppBundlePath).mtimeMs,
    iconMtimeMs: NodeFS.statSync(iconPath).mtimeMs,
    appBundleId: APP_BUNDLE_ID,
    appProtocolSchemes: APP_PROTOCOL_SCHEMES,
    signingIdentity,
  };

  const currentMetadata = readJson(metadataPath);
  if (
    NodeFS.existsSync(launcherBinaryPath) &&
    (!isDevelopment || NodeFS.existsSync(runtimeElectronBinaryPath)) &&
    currentMetadata &&
    JSON.stringify(currentMetadata) === JSON.stringify(expectedMetadata) &&
    (!isDevelopment || hasValidDevelopmentCodeIdentity(targetAppBundlePath))
  ) {
    return launcherBinaryPath;
  }

  NodeFS.rmSync(targetAppBundlePath, { recursive: true, force: true });
  // verbatimSymlinks keeps the framework's relative symlinks intact
  // (e.g. Resources -> Versions/Current/Resources). Without it cpSync
  // rewrites them to absolute paths into node_modules, which escape the
  // bundle and crash sandboxed helper processes (icudtl.dat not found).
  NodeFS.cpSync(sourceAppBundlePath, targetAppBundlePath, {
    recursive: true,
    verbatimSymlinks: true,
  });
  patchMainBundleInfoPlist(
    targetAppBundlePath,
    iconPath,
    isDevelopment ? developmentPaths.launcherExecutableName : "Electron",
  );
  patchHelperBundleInfoPlists(targetAppBundlePath);
  if (isDevelopment) {
    // Keep Electron's native executable inside the branded bundle. Launching the
    // node_modules copy makes macOS associate the process (and Dock label) with
    // Electron.app even though this bundle's Info.plist has the Scient name.
    // Its conventional executable name also keeps Electron's default-app runtime
    // in development mode instead of making app.isPackaged report true.
    writeDevelopmentLauncherScript(launcherBinaryPath, runtimeElectronBinaryPath);
    signDevelopmentAppBundle(targetAppBundlePath, signingIdentity ?? "-");
  }
  NodeFS.writeFileSync(metadataPath, `${JSON.stringify(expectedMetadata, null, 2)}\n`);
  registerMacLauncherBundle(targetAppBundlePath);

  return launcherBinaryPath;
}

function isLinuxSetuidSandboxConfigured(electronBinaryPath) {
  if (hostPlatform !== "linux") {
    return true;
  }

  const sandboxPath = NodePath.join(NodePath.dirname(electronBinaryPath), "chrome-sandbox");
  try {
    const sandboxStat = NodeFS.statSync(sandboxPath);
    return sandboxStat.uid === 0 && (sandboxStat.mode & 0o4777) === 0o4755;
  } catch {
    return false;
  }
}

function resolveLinuxSandboxArgs(electronBinaryPath) {
  if (isLinuxSetuidSandboxConfigured(electronBinaryPath)) {
    return [];
  }

  console.warn(
    "[desktop-launcher] Electron chrome-sandbox is not root-owned with mode 4755; launching local Electron with --no-sandbox.",
  );
  return ["--no-sandbox"];
}

export function resolveElectronPath() {
  const electronBinaryPath = resolveElectronBinaryPath();

  if (hostPlatform !== "darwin") {
    return electronBinaryPath;
  }

  return buildMacLauncher(electronBinaryPath);
}

export function resolveElectronLaunchCommand(args = []) {
  const electronPath = resolveElectronPath();
  return {
    electronPath,
    args: [...resolveLinuxSandboxArgs(electronPath), ...args],
  };
}

export function resolveElectronBinaryPath({
  ensureRuntime = ensureElectronRuntime,
  createRequire = NodeModule.createRequire,
  moduleUrl = import.meta.url,
} = {}) {
  ensureRuntime();

  const require = createRequire(moduleUrl);
  return require("electron");
}

export function resolveDevProtocolClient() {
  if (hostPlatform !== "darwin" || !isDevelopment) {
    return null;
  }

  const electronBinaryPath = resolveElectronBinaryPath();
  const launcherBinaryPath = buildMacLauncher(electronBinaryPath);
  return {
    appBundlePath: NodePath.resolve(launcherBinaryPath, "..", "..", ".."),
    appBundleId: APP_BUNDLE_ID,
  };
}
