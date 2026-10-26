// @effect-diagnostics nodeBuiltinImport:off -- Bounded, read-only access to provider-owned plugin files.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { parseDocument } from "yaml";
import * as Schema from "effect/Schema";
import { extensionIconData } from "./ExtensionIconData.ts";
import type { ExtensionPluginContents } from "@t3tools/contracts";

const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 200;
const Metadata = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  "user-invocable": Schema.optional(Schema.Boolean),
});
const decodeMetadata = Schema.decodeUnknownSync(Metadata);
const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

function isPluginPathContained(root: string, file: string): boolean {
  const relative = NodePath.relative(root, file);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
}

async function readContainedPluginBytes(root: string, file: string): Promise<Buffer> {
  const realRoot = await NodeFSP.realpath(root);
  const realFile = await NodeFSP.realpath(NodePath.resolve(root, file));
  if (!isPluginPathContained(realRoot, realFile))
    throw new Error("The skill is outside this plugin.");
  const handle = await NodeFSP.open(
    realFile,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES)
      throw new Error("The skill is not a file or exceeds 256 KB.");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const read = await handle.read(bytes, total, bytes.length - total, total);
      if (!read.bytesRead) break;
      total += read.bytesRead;
    }
    if (total > MAX_BYTES) throw new Error("The skill exceeds 256 KB.");
    if (
      (await NodeFSP.realpath(realFile)) !== realFile ||
      (await NodeFSP.realpath(root)) !== realRoot
    )
      throw new Error("The plugin changed while reading it.");
    return bytes.subarray(0, total);
  } finally {
    await handle.close();
  }
}

export async function readContainedPluginText(root: string, file: string): Promise<string> {
  return (await readContainedPluginBytes(root, file)).toString("utf8");
}

export async function readContainedPluginIcon(root: string, file: string) {
  return extensionIconData(await readContainedPluginBytes(root, file));
}

async function entries(root: string, folder: string): Promise<string[]> {
  const realRoot = await NodeFSP.realpath(root);
  const realFolder = await NodeFSP.realpath(NodePath.join(root, folder)).catch(() => undefined);
  if (!realFolder || !isPluginPathContained(realRoot, realFolder)) return [];
  const directory = await NodeFSP.opendir(realFolder);
  const names: string[] = [];
  for await (const entry of directory) {
    names.push(entry.name);
    if (names.length >= MAX_ENTRIES) break;
  }
  return names.sort();
}

function skillMetadata(text: string, fallback: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const document = match ? parseDocument(match[1] ?? "", { uniqueKeys: true }) : undefined;
  if (document?.errors.length) throw new Error("Invalid skill metadata.");
  const metadata = document ? decodeMetadata(document.toJS({ maxAliasCount: 20 })) : {};
  return {
    name: metadata.name?.trim() || fallback,
    description: metadata.description?.trim() ?? "",
    ...(metadata["user-invocable"] === undefined
      ? {}
      : { userInvocable: metadata["user-invocable"] }),
  };
}

export async function readLocalPluginContents(root: string): Promise<ExtensionPluginContents> {
  const skills: ExtensionPluginContents["skills"][number][] = [];
  for (const name of await entries(root, "skills")) {
    const id = NodePath.posix.join("skills", name, "SKILL.md");
    const text = await readContainedPluginText(root, id).catch(() => undefined);
    if (text === undefined) continue;
    try {
      skills.push({
        id,
        path: NodePath.join(root, id),
        ...skillMetadata(text, name),
        documentAvailable: true,
        enabled: true,
      });
    } catch {
      /* Invalid metadata is not a skill. */
    }
  }
  const servers = new Set<string>();
  for (const file of [
    ".mcp.json",
    "mcp.json",
    ".claude-plugin/plugin.json",
    ".omp-plugin/plugin.json",
    "plugin.json",
  ]) {
    const text = await readContainedPluginText(root, file).catch(() => undefined);
    if (text === undefined) continue;
    try {
      const data = decodeRecord(JSON.parse(text));
      const configured = data.mcpServers ?? (file.endsWith("mcp.json") ? data : {});
      const sources = Array.isArray(configured) ? configured.slice(0, MAX_ENTRIES) : [configured];
      for (const source of sources) {
        try {
          const manifest =
            typeof source === "string"
              ? decodeRecord(JSON.parse(await readContainedPluginText(root, source)))
              : decodeRecord(source);
          const record = decodeRecord(manifest.mcpServers ?? manifest);
          for (const name of Object.keys(record).slice(0, MAX_ENTRIES))
            if (servers.size < MAX_ENTRIES && name.trim()) servers.add(name);
        } catch {
          /* A missing or escaped server manifest contributes no names. */
        }
      }
    } catch {
      /* Invalid manifests do not provide server names. */
    }
  }
  return {
    apps: [],
    skills,
    mcpServers: [...servers].map((name) => ({ name })),
    commands: await entries(root, "commands"),
    agents: await entries(root, "agents"),
  };
}

export async function readLocalPluginSkill(root: string, skillId: string) {
  if (!/^skills\/[^/\\]+\/SKILL\.md$/.test(skillId))
    throw new Error("This skill is not in the plugin.");
  const text = await readContainedPluginText(root, skillId);
  return { instructions: text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim() };
}

export async function codexSkillRoot(
  sourceRoot: string | undefined,
  cacheRoot: string | undefined,
  file: string,
): Promise<string | undefined> {
  if (!NodePath.isAbsolute(file) || NodePath.basename(file) !== "SKILL.md") return undefined;
  sourceRoot = sourceRoot && NodePath.isAbsolute(sourceRoot) ? sourceRoot : undefined;
  const root = sourceRoot ?? (cacheRoot ? file.replace(/[\\/]skills[\\/].*$/, "") : undefined);
  if (!root || root === file) return undefined;
  const realRoot = await NodeFSP.realpath(root).catch(() => undefined);
  if (!realRoot) return undefined;
  if (!sourceRoot) {
    const realCache = cacheRoot
      ? await NodeFSP.realpath(cacheRoot).catch(() => undefined)
      : undefined;
    if (!realCache || !isPluginPathContained(realCache, realRoot) || realRoot === realCache)
      return undefined;
  }
  const realFile = await NodeFSP.realpath(file).catch(() => undefined);
  if (!realFile || !isPluginPathContained(realRoot, realFile)) return undefined;
  const stat = await NodeFSP.stat(realFile);
  return stat.isFile() && stat.size <= MAX_BYTES ? realRoot : undefined;
}
