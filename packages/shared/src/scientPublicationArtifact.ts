// @effect-diagnostics nodeBuiltinImport:off -- Installed native resource validation.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as HostProcess from "./HostProcess.ts";
import { securityDescriptorRefusal, type WindowsUser } from "./windowsSecurityDescriptor.ts";

/** How long one native check (PowerShell's permission check, a capability inquiry) may run. */
export const NATIVE_CHECK_DEADLINE_MS = 10_000;
/** A native check stopped by its own deadline: it neither passed nor refused. */
// @effect-diagnostics-next-line extendsNativeError:off -- Plain-Promise validation; callers test it with instanceof.
export class NativeCheckDeadlineError extends Error {
  readonly check: "permissions" | "capabilities";
  constructor(check: "permissions" | "capabilities") {
    super(`The native ${check} check did not finish within ${NATIVE_CHECK_DEADLINE_MS / 1000} s.`);
    this.check = check;
  }
}

/**
 * Stops `child` at the native check deadline unless it has already exited. The returned
 * function, called once the child has closed, says whether that deadline ended it.
 */
export function armNativeCheckDeadline(child: NodeChildProcess.ChildProcess): () => boolean {
  let pastDeadline = false;
  // @effect-diagnostics-next-line globalTimers:off -- The child owns this plain-Promise lifecycle.
  const timer = setTimeout(() => {
    pastDeadline = true;
    child.kill();
  }, NATIVE_CHECK_DEADLINE_MS);
  child.once("exit", () => clearTimeout(timer));
  return () => {
    clearTimeout(timer);
    return pastDeadline;
  };
}

export const publicationDigest = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Validate before executing: a receipt cannot make a project/PATH candidate authoritative. */
export function validatePublicationArtifact(helper: string) {
  return validateArtifact(helper, 1);
}
async function validateArtifact(helper: string, attempt: number): Promise<string> {
  const platform = HostProcess.Platform.defaultValue();
  const arch = HostProcess.Architecture.defaultValue();
  const binary = platform === "win32" ? "scient-file-publication.exe" : "scient-file-publication";
  if (!NodePath.isAbsolute(helper) || NodePath.basename(helper) !== binary)
    throw new Error("Native publication requires an absolute host-owned resource path.");
  for (let path = helper; ; path = NodePath.dirname(path)) {
    const stat = await NodeFSP.lstat(path);
    if (stat.isSymbolicLink() || (path === helper ? !stat.isFile() : !stat.isDirectory()))
      throw new Error("Native publication resource cannot traverse links.");
    if (platform !== "win32" && stat.uid !== 0 && stat.uid !== HostProcess.UserId.defaultValue())
      throw new Error("Native publication resource has an unexpected owner.");
    if (platform !== "win32" && (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
      throw new Error("Native publication resource is writable by another user.");
    if (path === NodePath.dirname(path)) break;
  }
  const receiptPath = NodePath.join(NodePath.dirname(helper), "publication-artifact.json");
  const receiptStat = await NodeFSP.lstat(receiptPath);
  if (
    !receiptStat.isFile() ||
    receiptStat.isSymbolicLink() ||
    (platform !== "win32" &&
      ((receiptStat.mode & 0o022) !== 0 ||
        (receiptStat.uid !== 0 && receiptStat.uid !== HostProcess.UserId.defaultValue())))
  )
    throw new Error("Native publication receipt is not host-owned.");
  const receipt = JSON.parse(await NodeFSP.readFile(receiptPath, "utf8"));
  if (
    receipt.protocol !== 1 ||
    receipt.platform !== platform ||
    receipt.probe !== false ||
    receipt.executable !== binary ||
    (receipt.arch !== arch && !(platform === "darwin" && receipt.arch === "universal"))
  )
    throw new Error("Native publication receipt has the wrong host, architecture or protocol.");
  const bytes = await NodeFSP.readFile(helper);
  if (receipt.sha256 !== publicationDigest(bytes))
    throw new Error("Native publication resource hash differs from its receipt.");
  if (platform === "linux") {
    if (
      bytes.subarray(0, 4).toString("hex") !== "7f454c46" ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== (arch === "arm64" ? 183 : 62)
    )
      throw new Error("Native publication is not a host ELF executable.");
  } else if (platform === "win32") {
    const pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
    if (
      bytes.subarray(0, 2).toString() !== "MZ" ||
      pe < 0 ||
      pe + 6 > bytes.length ||
      bytes.subarray(pe, pe + 4).toString("hex") !== "50450000" ||
      bytes.readUInt16LE(pe + 4) !== (arch === "arm64" ? 0xaa64 : 0x8664)
    )
      throw new Error("Native publication is not a host PE executable.");
  } else {
    const cpu = arch === "arm64" ? 0x0100000c : 0x01000007;
    const magic = bytes.subarray(0, 4).toString("hex");
    const slices = magic === "cafebabe" && bytes.length >= 8 ? bytes.readUInt32BE(4) : 0;
    const matches =
      magic === "cffaedfe" && bytes.length >= 8
        ? bytes.readUInt32LE(4) === cpu
        : slices > 0 &&
          slices <= 8 &&
          bytes.length >= 8 + slices * 20 &&
          Array.from({ length: slices }, (_, index) => bytes.readUInt32BE(8 + index * 20)).includes(
            cpu,
          );
    if (!matches) throw new Error("Native publication is not a host Mach-O executable.");
  }
  if (platform === "win32") {
    const permissionsKey = await windowsPermissionsKey(helper, receiptPath);
    // Asynchronous: PowerShell takes a second or more to start, and a synchronous launch
    // would hold the whole server for that long. Checks asked meanwhile share this one.
    const running = `${helper}\0${permissionsKey}`;
    let check = runningWindowsChecks.get(running);
    if (!check) {
      check = checkWindowsPermissions(helper).finally(() => runningWindowsChecks.delete(running));
      runningWindowsChecks.set(running, check);
    }
    await check;
    // A file replaced while PowerShell looked was not the one checked, nor the one hashed.
    if ((await windowsPermissionsKey(helper, receiptPath)) !== permissionsKey) {
      if (attempt >= 3) throw new Error("Native publication resource kept changing while checked.");
      return validateArtifact(helper, attempt + 1);
    }
  }
  await NodeFSP.access(
    helper,
    platform === "win32" ? NodeFSP.constants.F_OK : NodeFSP.constants.X_OK,
  );
  return helper;
}
/**
 * What the Windows permission check reads: the helper, its folder and its receipt, which no
 * other principal may change, then every folder above, from which none may delete them.
 */
export function windowsPermissionTargets(helper: string) {
  const directory = NodePath.dirname(helper);
  const targets = [helper, directory, NodePath.join(directory, "publication-artifact.json")].map(
    (path) => ({ path, mask: 0xd0156 }),
  );
  for (let path = directory; path !== NodePath.dirname(path);) {
    path = NodePath.dirname(path);
    targets.push({ path, mask: 0xd0040 });
  }
  return targets;
}
/**
 * Prints each path's security descriptor on its own line. Only a cmdlet and a property
 * read, so Constrained Language Mode (AppLocker, WDAC) runs it as it is.
 */
export const WINDOWS_PERMISSIONS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"
foreach ($path in $env:SCIENT_PUBLICATION_ACL_PATHS -split '\\n') { (Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $path).Sddl }`;
/**
 * Why the descriptors PowerShell printed for `targets` refuse the helper: an owner or a
 * write right outside the user, SYSTEM, Administrators and TrustedInstaller.
 */
export function windowsPermissionsRefusal(
  targets: ReadonlyArray<{ readonly path: string; readonly mask: number }>,
  output: string,
  user: WindowsUser,
) {
  const descriptors = output.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (descriptors.length !== targets.length)
    return "Native resource permissions were not read for every folder.";
  for (const [index, { path, mask }] of targets.entries()) {
    const refusal = securityDescriptorRefusal(descriptors[index]!.trim(), mask, user);
    if (refusal !== undefined) return `${refusal} (${path})`;
  }
  return undefined;
}
const runningWindowsChecks = new Map<string, Promise<unknown>>();
/** What changes when the helper, its receipt or its folder is replaced or re-permissioned. */
const windowsPermissionsKey = async (helper: string, receiptPath: string) =>
  (
    await Promise.all(
      [helper, receiptPath, NodePath.dirname(helper)].map(async (path) => {
        const stat = await NodeFSP.lstat(path, { bigint: true });
        return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      }),
    )
  ).join("|");
/** Settles only once the program has closed, so a retry never overlaps it. */
const runPermissionsProgram = (
  file: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
) =>
  new Promise<string>((resolve, reject) => {
    // PowerShell 7 points PSModulePath at its own modules, which Windows PowerShell can't
    // load, so a server started from a pwsh terminal would find no Get-Acl.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"),
    );
    const child = NodeChildProcess.execFile(
      NodePath.join(process.env.SystemRoot ?? "C:/Windows", "System32", file),
      args,
      { env: { ...inherited, ...env }, windowsHide: true },
      (error, stdout) => {
        // Too much output is a refusal, whenever it was noticed.
        const overflow =
          (error as { code?: unknown } | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        if (pastDeadline() && !overflow) reject(new NativeCheckDeadlineError("permissions"));
        else if (error) reject(error);
        else resolve(stdout);
      },
    );
    const pastDeadline = armNativeCheckDeadline(child);
  });
let currentUser: Promise<WindowsUser> | undefined;
/** The user's SID, which `whoami` gives without .NET, and whether it is a local account. */
export function windowsUserSid() {
  currentUser ??= runPermissionsProgram("whoami.exe", ["/user", "/fo", "csv", "/nh"]).then(
    (output) => {
      const found = /^"([^"\\]*)\\[^"]*","(S-1-\d+(?:-\d+)+)"\s*$/u.exec(output.trim());
      if (found === undefined || found === null)
        throw new Error("whoami did not report the user's SID.");
      const computer = process.env.COMPUTERNAME;
      return {
        sid: found[2]!,
        local: computer !== undefined && found[1]!.toUpperCase() === computer.toUpperCase(),
      };
    },
  );
  currentUser.catch(() => {
    currentUser = undefined;
  });
  return currentUser;
}
/**
 * The permissions were read and refuse the helper: asking again soon costs another PowerShell
 * launch for the same answer. A failed launch, a failed read or a deadline is not one.
 */
// @effect-diagnostics-next-line extendsNativeError:off -- Plain-Promise validation; callers test it with instanceof.
export class WindowsPermissionsRefusedError extends Error {}
async function checkWindowsPermissions(helper: string) {
  const targets = windowsPermissionTargets(helper);
  const [user, output] = await Promise.all([
    windowsUserSid(),
    runPermissionsProgram(
      "WindowsPowerShell/v1.0/powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_PERMISSIONS_SCRIPT, "utf16le").toString("base64"),
      ],
      { SCIENT_PUBLICATION_ACL_PATHS: targets.map(({ path }) => path).join("\n") },
    ),
  ]);
  const refusal = windowsPermissionsRefusal(targets, output, user);
  if (refusal !== undefined) throw new WindowsPermissionsRefusedError(refusal);
}
