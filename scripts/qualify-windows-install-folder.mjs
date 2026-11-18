// Windows runner checks of the installer's install-folder protection against the real installer:
// `writable` (the app's rule refuses it as it is) and `identity` describe a folder before an upgrade, `installed` checks it after
// (same folder object, protected throughout), `fixtures` installs into a fresh folder
// (protected, then uninstalled), a shared one and a link (both left as they were).
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { securityDescriptorRefusal } from "../packages/shared/src/windowsSecurityDescriptor.ts";

// eslint-disable-next-line t3code/no-global-process-runtime -- Standalone target-host probe runs outside the Effect application runtime.
NodeAssert.equal(process.platform, "win32", "Run this probe on the target Windows host");
const [command, target, extra] = process.argv.slice(2);
NodeAssert.ok(command && target, "Usage: <writable|identity|installed|fixtures> <path> [file ID]");
const powershell = NodePath.join(
  process.env.SystemRoot,
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const whoami = /^"([^"\\]*)\\[^"]*","(S-1-\d+(?:-\d+)+)"\s*$/u.exec(
  NodeChildProcess.execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
  }).trim(),
);
NodeAssert.ok(whoami, "whoami did not report the user's SID");
// The app's own permission rule (packages/shared), as it judges the helper and its folder.
const user = {
  sid: whoami[2],
  local: whoami[1].toUpperCase() === process.env.COMPUTERNAME?.toUpperCase(),
};
const NATIVE_RESOURCE_MASK = 0xd0156;

// A pwsh step's module path keeps Windows PowerShell from loading Get-Acl (as in the app's check).
const windowsPowerShellEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"),
);

/** Each path under `root` (itself first) with its security descriptor, in one PowerShell run. */
function descriptors(root, recurse) {
  const script = `$ErrorActionPreference = 'Stop'
$items = @(Get-Item -LiteralPath $env:SCIENT_PROBE_PATH -Force)
if ($env:SCIENT_PROBE_RECURSE -eq '1') { $items += @(Get-ChildItem -LiteralPath $env:SCIENT_PROBE_PATH -Recurse -Force) }
foreach ($item in $items) { "$($item.FullName)\`t$((Get-Acl -LiteralPath $item.FullName).Sddl)" }`;
  const output = NodeChildProcess.execFileSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...windowsPowerShellEnv,
        SCIENT_PROBE_PATH: root,
        SCIENT_PROBE_RECURSE: recurse ? "1" : "0",
      },
    },
  );
  return output
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [path, descriptor] = line.split("\t");
      return { path, sddl: descriptor.trim() };
    });
}
const sddl = (path) => descriptors(path, false)[0].sddl;

/**
 * Every item passes the app's rule for a native resource; the root has exactly the installer's
 * protected list: the user, SYSTEM and Administrators, inheriting nothing.
 */
function assertProtected(root) {
  const items = descriptors(root, true);
  for (const { path, sddl: descriptor } of items) {
    const refusal = securityDescriptorRefusal(descriptor, NATIVE_RESOURCE_MASK, user);
    NodeAssert.equal(refusal, undefined, `${path}: ${refusal} (${descriptor})`);
  }
  // The root's list, entry by entry (type, flags, rights, principal), as the installer sets it.
  const rootDescriptor = items[0].sddl;
  const dacl = /D:([A-Z]*)((?:\([^)]*\))*)/u.exec(rootDescriptor);
  NodeAssert.ok(dacl?.[1].includes("P"), `${root} still inherits permissions: ${rootDescriptor}`);
  const entries = [...dacl[2].matchAll(/\(([^)]*)\)/gu)].map((match) => {
    const [type, flags, rights, , , principal] = match[1].split(";");
    // SDDL writes the machine's built-in Administrator as LA, as the app's rule reads it.
    const builtInUser = principal === "LA" && user.local && /-500$/u.test(user.sid);
    return `${type};${flags};${rights};${builtInUser ? user.sid : principal}`;
  });
  NodeAssert.deepEqual(
    entries.toSorted(),
    [`A;OICI;FA;${user.sid}`, "A;OICI;FA;BA", "A;OICI;FA;SY"].toSorted(),
    `${root} is not the installer's list: ${rootDescriptor}`,
  );
  return items.length;
}

/** A folder the app's rule refuses as it is: the condition the installer must repair. */
function assertWritableByOthers(path) {
  const descriptor = sddl(path);
  NodeAssert.equal(
    securityDescriptorRefusal(descriptor, NATIVE_RESOURCE_MASK, user),
    "Native resource is writable by another principal.",
    `${path} is not a real fixture: ${descriptor}`,
  );
}

const identity = (path) => String(NodeFS.statSync(path, { bigint: true }).ino);

function install(installer, directory) {
  const result = NodeChildProcess.spawnSync(installer, ["/S", `/D=${directory}`], {
    timeout: 10 * 60_000,
  });
  NodeAssert.equal(result.status, 0, `Installing into ${directory} exited ${result.status}`);
  NodeAssert.ok(NodeFS.existsSync(NodePath.join(directory, "Scient.exe")), "Scient.exe missing");
}

if (command === "writable") {
  assertWritableByOthers(target);
} else if (command === "identity") {
  process.stdout.write(identity(target));
} else if (command === "installed") {
  NodeAssert.ok(extra, "Pass the folder's file ID from before the upgrade");
  // The old uninstaller emptied the folder the installer held open instead of recreating it.
  NodeAssert.equal(identity(target), extra, "The upgrade replaced the install folder");
  const count = assertProtected(target);
  process.stdout.write(`Install folder ${target}: same folder, ${count} items protected.\n`);
} else if (command === "fixtures") {
  // Below the system drive, whose new folders other users may change.
  const root = NodeFS.mkdtempSync(
    NodePath.join(`${process.env.SystemDrive}\\`, "scient-fixtures-"),
  );
  // A fresh, empty folder that Users may add to is protected before anything lands.
  const fresh = NodePath.join(root, "fresh");
  NodeFS.mkdirSync(fresh);
  assertWritableByOthers(fresh);
  install(target, fresh);
  const count = assertProtected(fresh);
  // A protected install still uninstalls: the uninstaller copies itself out, then removes the
  // folder itself.
  const uninstall = NodeChildProcess.spawnSync(
    NodePath.join(fresh, "Uninstall Scient.exe"),
    ["/S"],
    {
      timeout: 5 * 60_000,
    },
  );
  NodeAssert.equal(uninstall.status, 0, `Uninstalling exited ${uninstall.status}`);
  for (let wait = 0; NodeFS.existsSync(fresh) && wait < 240; wait++)
    await new Promise((resolve) => setTimeout(resolve, 500));
  NodeAssert.equal(NodeFS.existsSync(fresh), false, "Uninstall left the protected folder");
  // A folder already holding someone's files keeps its own permissions.
  const shared = NodePath.join(root, "shared");
  NodeFS.mkdirSync(shared);
  NodeFS.writeFileSync(NodePath.join(shared, "notes.txt"), "not Scient's");
  const sharedBefore = sddl(shared);
  install(target, shared);
  NodeAssert.equal(
    sddl(shared),
    sharedBefore,
    "The installer changed a shared folder's permissions",
  );
  NodeAssert.equal(NodeFS.readFileSync(NodePath.join(shared, "notes.txt"), "utf8"), "not Scient's");
  // A link at the install path is not followed for permissions: its target stays as it was.
  const linkTarget = NodePath.join(root, "link-target");
  const link = NodePath.join(root, "link");
  NodeFS.mkdirSync(linkTarget);
  NodeFS.symlinkSync(linkTarget, link, "junction");
  const linkTargetBefore = sddl(linkTarget);
  install(target, link);
  NodeAssert.ok(NodeFS.lstatSync(link).isSymbolicLink(), "The installer replaced the junction");
  NodeAssert.equal(
    sddl(linkTarget),
    linkTargetBefore,
    "The installer changed a link target's permissions",
  );
  // A link above the install folder: the folder it reaches keeps its inherited permissions.
  const aboveTarget = NodePath.join(root, "above-target");
  const above = NodePath.join(root, "above");
  NodeFS.mkdirSync(aboveTarget);
  NodeFS.symlinkSync(aboveTarget, above, "junction");
  install(target, NodePath.join(above, "Scient"));
  NodeAssert.doesNotMatch(
    sddl(NodePath.join(aboveTarget, "Scient")),
    /D:P/u,
    "The installer changed permissions through a link above the install folder",
  );
  process.stdout.write(
    `Fresh folder protected (${count} items); shared folder, link and a folder below a link left as they were.\n`,
  );
} else {
  NodeAssert.fail(`Unknown command ${command}`);
}
