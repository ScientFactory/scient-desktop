// @effect-diagnostics nodeBuiltinImport:off -- Installed native resource validation.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as HostProcess from "./HostProcess.ts";

const checkedWindowsPermissions = new Map<string, string>();

export const publicationDigest = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Validate before executing: a receipt cannot make a project/PATH candidate authoritative. */
export async function validatePublicationArtifact(helper: string) {
  const platform = HostProcess.Platform.defaultValue();
  const arch = HostProcess.Architecture.defaultValue();
  const binary = platform === "win32" ? "scient-file-publication.exe" : "scient-file-publication";
  if (!NodePath.isAbsolute(helper) || NodePath.basename(helper) !== binary)
    throw new Error("Native publication requires an absolute host-owned resource path.");
  const authority = [];
  for (let path = helper; ; path = NodePath.dirname(path)) {
    const stat = await NodeFSP.lstat(path);
    authority.push(`${path}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`);
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
  const permissionsKey = `${authority.join("\0")}:${receiptStat.ctimeMs}:${receiptStat.mtimeMs}:${receiptStat.size}`;
  if (platform === "win32" && checkedWindowsPermissions.get(helper) !== permissionsKey) {
    const command = `
$ErrorActionPreference = 'Stop'
$allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$directory = Split-Path $env:SCIENT_PUBLICATION_VALIDATE
$files = @($env:SCIENT_PUBLICATION_VALIDATE, $directory, (Join-Path $directory 'publication-artifact.json'))
$ancestor = Split-Path $directory
while ($ancestor) {
  $files += $ancestor
  $parent = Split-Path $ancestor
  if ($parent -eq $ancestor) { break }
  $ancestor = $parent
}
foreach ($file in $files) {
  $mask = if ($file -in $files[0..2]) { 0xD0156 } else { 0xD0040 }
  $acl = Get-Acl -LiteralPath $file
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -notin $allowed) { throw 'Unexpected native resource owner' }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and !($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and $rule.IdentityReference.Value -notin $allowed -and ($rule.FileSystemRights -band $mask)) { throw 'Native resource is writable by another principal' }
  }
}`;
    NodeChildProcess.execFileSync(
      NodePath.join(
        process.env.SystemRoot ?? "C:/Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ],
      {
        env: { ...process.env, SCIENT_PUBLICATION_VALIDATE: helper },
        stdio: "pipe",
        timeout: 10_000,
      },
    );
    checkedWindowsPermissions.set(helper, permissionsKey);
  }
  await NodeFSP.access(
    helper,
    platform === "win32" ? NodeFSP.constants.F_OK : NodeFSP.constants.X_OK,
  );
  return helper;
}
