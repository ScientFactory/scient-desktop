import type {
  ExtensionPluginContentsInput,
  ExtensionPluginSkill,
  ServerProvider,
} from "@t3tools/contracts";
import { isProviderSkillUserInvocable } from "@t3tools/client-runtime/providerSkills";

export function nativePluginSkill(
  provider: ServerProvider | undefined,
  input: ExtensionPluginContentsInput,
  skill: ExtensionPluginSkill,
) {
  if (
    !provider?.enabled ||
    !provider.installed ||
    provider.instanceId !== input.instanceId ||
    !isProviderSkillUserInvocable(skill) ||
    !skill.path
  )
    return undefined;
  const inventory = input.cwd
    ? provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === input.cwd)
    : provider;
  const installed = inventory?.plugins?.find(
    (plugin) =>
      plugin.enabled &&
      (plugin.id === input.pluginId ||
        plugin.id === input.entryId ||
        plugin.name === input.entryId),
  );
  if (!installed) return undefined;
  const candidate = inventory?.skills.find((candidate) => candidate.path === skill.path);
  if (candidate) return isProviderSkillUserInvocable(candidate) ? candidate : undefined;
  const namespace = installed.name.split("@")[0];
  if (provider.driver === "codex" && skill.name.startsWith(`${namespace}:`))
    return { name: skill.name };
  if (provider.driver === "claudeAgent" || provider.driver === "scient")
    return { name: skill.name.includes(":") ? skill.name : `${namespace}:${skill.name}` };
  return undefined;
}
