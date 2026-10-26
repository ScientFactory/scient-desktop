// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";

const absent = (cause: unknown) =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");
const text = async (path: string) =>
  NodeFSP.readFile(path, "utf8").catch((cause: unknown) => {
    if (absent(cause)) return null;
    throw cause;
  });
const children = async (path: string) =>
  NodeFSP.readdir(path).catch((cause: unknown) => {
    if (absent(cause)) return [];
    throw cause;
  });
function configuredPaths(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    [
      "path",
      "sync_dir",
      "UserFolder",
      "MountPoint",
      "DefaultMountPoint",
      "user_default_mount_point",
    ].includes(key) &&
    typeof item === "string" &&
    NodePath.isAbsolute(item)
      ? [item]
      : configuredPaths(item),
  );
}
async function plist(path: string) {
  if ((await text(path)) === null) return [];
  const result = await new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", path],
      { maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
  return configuredPaths(JSON.parse(result));
}
/** Known desktop-client registrations only; unknown sync tools remain outside detection. */
export async function detectableOverleafCloudRoots(
  home = NodeOS.homedir(),
  platform = HostProcess.Platform.defaultValue(),
) {
  const roots: string[] = [];
  if (platform === "darwin") {
    const storage = NodePath.join(home, "Library/CloudStorage");
    roots.push(...(await children(storage)).map((name) => NodePath.join(storage, name)));
    roots.push(NodePath.join(home, "Library/Mobile Documents"));
    roots.push(...(await plist("/Library/Preferences/com.google.drivefs.settings.plist")));
    const preferences = NodePath.join(home, "Library/Preferences");
    for (const name of await children(preferences))
      if (
        /^com\.microsoft\.OneDrive.*\.plist$/u.test(name) ||
        name === "com.google.drivefs.settings.plist"
      )
        roots.push(...(await plist(NodePath.join(preferences, name))));
  }
  if (platform === "darwin" || platform === "linux") {
    for (const file of [
      ".dropbox/info.json",
      "Library/Application Support/Dropbox/info.json",
      ".config/Dropbox/info.json",
    ]) {
      const content = await text(NodePath.join(home, file));
      if (content !== null) roots.push(...configuredPaths(JSON.parse(content)));
    }
    const config = NodePath.join(home, ".config/onedrive");
    const files = [
      NodePath.join(config, "config"),
      ...(await children(config)).map((name) => NodePath.join(config, name, "config")),
    ];
    for (const file of files) {
      const content = await text(file);
      const directory = content?.match(/^\s*sync_dir\s*=\s*"([^"\n]+)"\s*(?:#.*)?$/mu)?.[1];
      if (directory !== undefined)
        roots.push(
          directory.startsWith("~/") ? NodePath.join(home, directory.slice(2)) : directory,
        );
    }
    for (const file of [
      ".config/Google/DriveFS/settings.json",
      "Library/Application Support/Google/DriveFS/settings.json",
    ]) {
      const content = await text(NodePath.join(home, file));
      if (content !== null) roots.push(...configuredPaths(JSON.parse(content)));
    }
  }
  return [...new Set(roots.filter((root) => NodePath.isAbsolute(root)))];
}
/** Canonicalize even an absent candidate through its nearest existing ancestor. */
async function actualPath(path: string): Promise<string> {
  try {
    return await NodeFSP.realpath(path);
  } catch (cause) {
    if (!absent(cause)) throw cause;
    const parent = NodePath.dirname(path);
    if (parent === path) throw cause;
    return NodePath.join(await actualPath(parent), NodePath.basename(path));
  }
}
/** Windows supplies Cloud Files registration roots through this same boundary. */
export async function overleafCloudRoot(
  path: string,
  roots?: ReadonlyArray<string>,
): Promise<string | null> {
  const candidate = await actualPath(NodePath.resolve(path));
  const containing: string[] = [];
  for (const root of roots ?? (await detectableOverleafCloudRoots())) {
    const canonical = await actualPath(root);
    const relative = NodePath.relative(canonical, candidate);
    const rootIdentity = await NodeFSP.stat(canonical, { bigint: true }).catch((cause: unknown) => {
      if (absent(cause)) return null;
      throw cause;
    });
    let physicallyInside = false;
    if (rootIdentity !== null) {
      for (let current = candidate; ; current = NodePath.dirname(current)) {
        const identity = await NodeFSP.stat(current, { bigint: true }).catch((cause: unknown) => {
          if (absent(cause)) return null;
          throw cause;
        });
        if (identity?.dev === rootIdentity.dev && identity.ino === rootIdentity.ino) {
          physicallyInside = true;
          break;
        }
        if (NodePath.dirname(current) === current) break;
      }
    }
    if (
      physicallyInside ||
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${NodePath.sep}`) &&
        !NodePath.isAbsolute(relative))
    )
      containing.push(canonical);
  }
  return containing.sort((a, b) => a.length - b.length)[0] ?? null;
}
