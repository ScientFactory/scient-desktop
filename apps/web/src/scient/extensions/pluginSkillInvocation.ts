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
    !skill.enabled ||
    !skill.path
  )
    return undefined;
  const inventory = input.cwd
    ? provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === input.cwd)
    : provider;
  const installed = inventory?.plugins?.some(
    (plugin) =>
      plugin.enabled &&
      (plugin.id === input.pluginId ||
        plugin.id === input.entryId ||
        plugin.name === input.entryId),
  );
  return installed
    ? inventory?.skills.find(
        (candidate) => candidate.path === skill.path && isProviderSkillUserInvocable(candidate),
      )
    : undefined;
}
