import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ExtensionPluginSkill,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { nativePluginSkill } from "./pluginSkillInvocation";

it("offers only the installed plugin's invocable skill in the selected instance and workspace", () => {
  const skill: ExtensionPluginSkill = {
    id: "search",
    name: "search",
    description: "",
    enabled: true,
    documentAvailable: true,
    path: "/plugin/skills/search/SKILL.md",
  };
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    status: "ready",
    version: null,
    checkedAt: "2026-10-26T00:00:00Z",
    auth: { status: "authenticated" },
    models: [],
    slashCommands: [],
    plugins: [{ id: "plugin", name: "plugin", enabled: true, source: "local" }],
    skills: [{ name: "plugin:search", path: skill.path!, enabled: true }],
  };
  const input = { instanceId: provider.instanceId, pluginId: "plugin" };
  expect(nativePluginSkill(provider, input, skill)?.name).toBe("plugin:search");
  const catalogSkill = { ...skill, name: "plugin:search" };
  expect(nativePluginSkill({ ...provider, skills: [] }, input, catalogSkill)?.name).toBe(
    "plugin:search",
  );
  for (const driver of ["claudeAgent", "scient"]) {
    expect(
      nativePluginSkill(
        { ...provider, driver: ProviderDriverKind.make(driver), skills: [] },
        input,
        skill,
      )?.name,
    ).toBe("plugin:search");
  }
  expect(
    nativePluginSkill({ ...provider, skills: [] }, input, {
      ...catalogSkill,
      userInvocable: false,
    }),
  ).toBeUndefined();

  expect(nativePluginSkill(provider, { ...input, cwd: "/other-project" }, skill)).toBeUndefined();
  expect(
    nativePluginSkill(provider, { ...input, instanceId: ProviderInstanceId.make("other") }, skill),
  ).toBeUndefined();
  expect(
    nativePluginSkill(provider, input, { ...skill, path: "/other-plugin/skills/search/SKILL.md" }),
  ).toBeUndefined();
  expect(nativePluginSkill(provider, input, { ...skill, enabled: false })).toBeUndefined();
  expect(
    nativePluginSkill(
      { ...provider, plugins: [{ ...provider.plugins![0]!, enabled: false }] },
      input,
      skill,
    ),
  ).toBeUndefined();
  expect(
    nativePluginSkill(
      { ...provider, skills: [{ ...provider.skills[0]!, userInvocable: false }] },
      input,
      skill,
    ),
  ).toBeUndefined();
  expect(
    nativePluginSkill(
      { ...provider, skills: [{ ...provider.skills[0]!, enabled: false }] },
      input,
      skill,
    ),
  ).toBeUndefined();
});
