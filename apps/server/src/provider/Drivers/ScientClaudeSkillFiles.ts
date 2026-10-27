// @effect-diagnostics nodeBuiltinImport:off -- Bounded read-only discovery of native Claude skill files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { readContainedPluginText } from "../../scient/extensions/LocalPluginContents.ts";

export const readClaudeSkillText = (file: string) =>
  readContainedPluginText(NodePath.dirname(file), file).catch(() => undefined);

export async function claudeSkillEntries(root: string): Promise<string[]> {
  const realRoot = await NodeFSP.realpath(root).catch(() => undefined);
  if (!realRoot) return [];
  const pending = [{ directory: root, depth: 0 }];
  const visited = new Set<string>();
  const result: string[] = [];
  while (pending.length && visited.size < 2000) {
    const current = pending.shift()!;
    const real = await NodeFSP.realpath(current.directory).catch(() => undefined);
    if (!real || visited.has(real)) continue;
    const relative = NodePath.relative(realRoot, real);
    if (
      relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
    )
      continue;
    visited.add(real);
    if (
      current.depth > 0 &&
      (await readClaudeSkillText(NodePath.join(current.directory, "SKILL.md"))) !== undefined
    ) {
      result.push(NodePath.relative(root, current.directory));
      continue;
    }
    if (current.depth >= 8) continue;
    const entries = await NodeFSP.readdir(current.directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      if (pending.length + visited.size >= 2000) break;
      pending.push({
        directory: NodePath.join(current.directory, entry.name),
        depth: current.depth + 1,
      });
    }
  }
  return result;
}
