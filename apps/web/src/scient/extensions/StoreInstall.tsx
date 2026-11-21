import { useAtomValue } from "@effect/atom-react";
import type { ProviderStoreEntry, ServerProvider, ServerProviderPlugin } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { PlusIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { ensureLocalApi } from "../../localApi";
import { useAtomCommand } from "../../state/use-atom-command";
import { useActionLock, useProviderPluginActions } from "./extensionActions";
import { PrimaryAction } from "./ExtensionDetailPages";
import { ActionFeedback } from "./ExtensionItems";
import { MutedLine, useExtensionsEnvironment } from "./ExtensionsPage";
import { actOnProviderPlugin } from "./extensionsState";
import { providerAvailable } from "./extensionsView";

/**
 * Antigravity's partner catalog lists plugins other developers make; Google's own are not. An
 * entry known only by id (a service page's route) says which catalog listed it.
 */
export function isThirdPartyPlugin(
  entry: Pick<ProviderStoreEntry, "kind" | "id" | "publisherType">,
) {
  return (
    entry.kind === "antigravity" &&
    (entry.publisherType === "third-party" || entry.id.endsWith("@antigravity-plugins-partners"))
  );
}

function useThirdPartyNoticeText(publisher: string | undefined) {
  const gt = useGT();
  return publisher
    ? gt(
        "{developer} makes this plugin, not Google. It can run its own code and connect to {developer}’s services. Add it only if you trust {developer}.",
        { developer: publisher },
      )
    : gt(
        "A third-party developer makes this plugin, not Google. It can run its own code and connect to that developer’s services. Add it only if you trust them.",
      );
}

export function ThirdPartyNotice({ entry }: { readonly entry: ProviderStoreEntry }) {
  return <MutedLine>{useThirdPartyNoticeText(entry.publisher)}</MutedLine>;
}

/**
 * Installs a store entry into the agent that keeps it: a Claude plugin for Scient Agent goes into
 * a Claude instance, whose plugins Scient Agent loads. Every Add, from a list, a plugin page or a
 * service page, shows a third-party plugin's notice first.
 */
export function useStoreInstall(
  provider: ServerProvider,
  entry: Pick<ProviderStoreEntry, "kind" | "id"> &
    Partial<Pick<ProviderStoreEntry, "publisher" | "publisherType">>,
  refresh: () => void,
) {
  const { environmentId, providers } = useExtensionsEnvironment();
  const target =
    entry.kind === "shared" && provider.driver === "scient"
      ? (providers.find((item) => providerAvailable(item) && item.driver === "claudeAgent") ??
        provider)
      : provider;
  const plugin = target.plugins?.find(
    (plugin) => plugin.id === entry.id || plugin.name === entry.id,
  );
  const allowed = useAtomValue(actOnProviderPlugin.permissionAtom(environmentId));
  const act = useAtomCommand(actOnProviderPlugin);
  const lock = useActionLock(JSON.stringify(["store", provider.instanceId, entry.id]));
  const notice = useThirdPartyNoticeText(entry.publisher);
  return {
    target,
    plugin,
    allowed,
    lock,
    install: () =>
      void (async () => {
        if (isThirdPartyPlugin(entry) && !(await ensureLocalApi().dialogs.confirm(notice))) return;
        await lock.run("install", async () => {
          const result = await act({
            environmentId,
            input: {
              instanceId: target.instanceId,
              action: {
                type: "install",
                entryId: entry.id,
                ...(target.instanceId !== provider.instanceId
                  ? { sourceInstanceId: provider.instanceId }
                  : {}),
              },
            },
          });
          refresh();
          return result;
        });
      })(),
  };
}

export function StoreInstall({
  provider,
  entry,
  refresh,
  compact = false,
}: {
  readonly provider: ServerProvider;
  readonly entry: ProviderStoreEntry;
  readonly refresh: () => void;
  /** In a list under the store's own heading: "Add" and "Remove", the agent goes without saying. */
  readonly compact?: boolean;
}) {
  const gt = useGT();
  const { target, plugin, allowed, lock, install } = useStoreInstall(provider, entry, refresh);
  const installed = entry.installed || plugin !== undefined;
  if (installed && plugin?.canUninstall)
    return <StoreRemove provider={target} plugin={plugin} refresh={refresh} compact={compact} />;
  if (compact && installed)
    return (
      <span className="text-sm text-muted-foreground">
        <T>Added</T>
      </span>
    );
  return (
    <>
      <PrimaryAction
        icon={PlusIcon}
        disabled={!allowed || lock.locked || installed || Boolean(entry.disabledReason)}
        onClick={install}
      >
        {lock.busy
          ? gt("Adding…")
          : compact
            ? gt("Add", { $context: "verb, adds an extension" })
            : installed
              ? gt("Added")
              : target.driver === "codex"
                ? gt("Add to Codex")
                : target.driver === "antigravity"
                  ? gt("Add to Antigravity")
                  : target.driver === "claudeAgent"
                    ? gt("Add to Claude Code")
                    : gt("Add to Scient Agent")}
      </PrimaryAction>
      {installed ? (
        <MutedLine>
          {target.displayName === undefined ? (
            <T>Remove this plugin in the agent’s plugin manager.</T>
          ) : (
            <T>
              Remove this plugin in <Var>{target.displayName}</Var>’s plugin manager.
            </T>
          )}
        </MutedLine>
      ) : null}
      <ActionFeedback feedback={lock.feedback} />
    </>
  );
}

function StoreRemove({
  provider,
  plugin,
  refresh,
  compact,
}: {
  readonly provider: ServerProvider;
  readonly plugin: ServerProviderPlugin;
  readonly refresh: () => void;
  readonly compact: boolean;
}) {
  const gt = useGT();
  const actions = useProviderPluginActions(
    provider,
    provider.displayName ?? gt("this agent"),
    plugin,
    undefined,
  );
  return (
    <>
      <Button
        variant="destructive-outline"
        {...(compact ? { size: "sm" as const } : {})}
        disabled={actions.locked}
        onClick={() => void actions.uninstall().then(refresh)}
      >
        {actions.busy
          ? gt("Removing…")
          : compact
            ? gt("Remove")
            : provider.displayName === undefined
              ? gt("Remove from this agent")
              : gt("Remove from {agent}", { agent: provider.displayName })}
      </Button>
      <ActionFeedback feedback={actions.feedback} />
    </>
  );
}
