// @effect-diagnostics nodeBuiltinImport:off -- Real filesystem boundaries for plugin document reads.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import {
  codexSkillRoot,
  readContainedPluginText,
  readLocalPluginContents,
  readLocalPluginSkill,
} from "./LocalPluginContents.ts";

it("contains skill reads after symlink resolution and rejects oversized documents", async () => {
  await using cleanup = new AsyncDisposableStack();
  const temporary = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "scient-plugin-contents-"),
  );
  cleanup.defer(() => NodeFSP.rm(temporary, { recursive: true, force: true }));
  const root = NodePath.join(temporary, "plugin");
  await NodeFSP.mkdir(NodePath.join(root, "skills", "safe"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "skills", "safe", "SKILL.md"),
    "---\nname: safe\ndescription: A contained skill\n---\n# Instructions\nRead the project.",
  );
  await NodeFSP.writeFile(
    NodePath.join(root, ".mcp.json"),
    '{"mcpServers":{"search":{"command":"unused"}}}',
  );
  await NodeFSP.writeFile(NodePath.join(temporary, "outside.md"), "outside");
  await NodeFSP.symlink(
    NodePath.join(temporary, "outside.md"),
    NodePath.join(root, "outside-link"),
  );
  await NodeFSP.symlink(
    NodePath.join(root, "skills", "safe", "SKILL.md"),
    NodePath.join(root, "inside-link"),
  );
  expect(await readContainedPluginText(root, "inside-link")).toContain("# Instructions");
  await expect(readContainedPluginText(root, "../outside.md")).rejects.toThrow(
    "outside this plugin",
  );
  await expect(readContainedPluginText(root, "outside-link")).rejects.toThrow(
    "outside this plugin",
  );
  await expect(readLocalPluginSkill(root, "../outside.md")).rejects.toThrow();
  expect(await readLocalPluginSkill(root, "skills/safe/SKILL.md")).toEqual({
    instructions: "# Instructions\nRead the project.",
  });
  expect(await readLocalPluginContents(root)).toMatchObject({
    skills: [{ name: "safe", description: "A contained skill" }],
    mcpServers: [{ name: "search" }],
  });
  await NodeFSP.writeFile(NodePath.join(root, "large.md"), Buffer.alloc(256 * 1024 + 1));
  await expect(readContainedPluginText(root, "large.md")).rejects.toThrow("256 KB");
  const file = NodePath.join(root, "skills", "safe", "SKILL.md");
  expect(await codexSkillRoot(root, undefined, file)).toBe(await NodeFSP.realpath(root));
  expect(await codexSkillRoot(undefined, NodePath.join(root, "skills"), file)).toBeUndefined();
  expect(await codexSkillRoot(undefined, temporary, file)).toBe(await NodeFSP.realpath(root));
  await NodeFSP.symlink(temporary, NodePath.join(root, "skills", "escape"));
  expect((await readLocalPluginContents(root)).skills).toHaveLength(1);
});

it("bounds the skill listing to 200 entries", async () => {
  await using cleanup = new AsyncDisposableStack();
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-plugin-count-"));
  cleanup.defer(() => NodeFSP.rm(root, { recursive: true, force: true }));
  await Promise.all(
    Array.from({ length: 201 }, async (_, index) => {
      const name = `skill-${index}`;
      const directory = NodePath.join(root, "skills", name);
      await NodeFSP.mkdir(directory, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: A skill\n---\nInstructions`,
      );
    }),
  );
  expect((await readLocalPluginContents(root)).skills).toHaveLength(200);
});

it("parses multiline skill metadata and contained manifest references, skipping malformed entries", async () => {
  await using cleanup = new AsyncDisposableStack();
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-plugin-parsing-"));
  cleanup.defer(() => NodeFSP.rm(root, { recursive: true, force: true }));
  for (const name of ["valid", "duplicate", "wrong-type"]) {
    await NodeFSP.mkdir(NodePath.join(root, "skills", name), { recursive: true });
  }
  await NodeFSP.writeFile(
    NodePath.join(root, "skills/valid/SKILL.md"),
    "---\nname: Read Papers\ndescription: >-\n  Read and compare\n  papers.\n---\n# Instructions",
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "skills/duplicate/SKILL.md"),
    "---\nname: first\nname: second\n---\nInvalid",
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "skills/wrong-type/SKILL.md"),
    "---\nname: [invalid]\n---\nInvalid",
  );
  await NodeFSP.mkdir(NodePath.join(root, ".claude-plugin"));
  await NodeFSP.writeFile(
    NodePath.join(root, ".claude-plugin/plugin.json"),
    JSON.stringify({
      mcpServers: ["./servers.json", "../escape.json", { inline: { command: "unused" } }],
    }),
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "servers.json"),
    JSON.stringify({ mcpServers: { search: { command: "unused" } } }),
  );
  for (const folder of ["commands", "agents"]) {
    await NodeFSP.mkdir(NodePath.join(root, folder));
    await NodeFSP.writeFile(NodePath.join(root, folder, "review.md"), "Review");
  }
  const contents = await readLocalPluginContents(root);
  expect(contents.skills).toMatchObject([
    { name: "Read Papers", description: "Read and compare papers." },
  ]);
  expect(contents.mcpServers).toEqual([{ name: "search" }, { name: "inline" }]);
  expect(contents.commands).toEqual(["review.md"]);
  expect(contents.agents).toEqual(["review.md"]);
});
