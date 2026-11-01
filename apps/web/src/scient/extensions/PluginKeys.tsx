import { useAtomValue } from "@effect/atom-react";
import {
  VaultSecretRef,
  type ExtensionPluginContentsInput,
  type PluginKeyState,
  type PluginKeyTarget,
  type ServerProvider,
} from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useProjects } from "~/state/entities";
import { AccountDialog } from "../accounts/AccountDialog";
import { ApiKeyAccountPicker } from "../accounts/ApiKeyAccountPicker";
import { useAccounts } from "../accounts/useAccounts";
import { useExtensionsEnvironment } from "./ExtensionsPage";
import { DetailSection } from "./ExtensionDetailPages";
import { bindPluginKey, extensionsPluginKeys, unbindPluginKey } from "./extensionsState";

// oxlint-disable-next-line t3code/no-em-dash-copy -- Explicit product copy for this feature.
const SCIENT_KEYS_UNAVAILABLE = "Needs a key — not available for Scient Agent yet";

export function pluginKeyStatusLabel(state: PluginKeyState | null, provider?: ServerProvider) {
  if (!state || !state.keys.length) return null;
  if (state.commandLineBlocked)
    // oxlint-disable-next-line t3code/no-em-dash-copy -- Explicit product explanation for refused secret argv.
    return "Needs a key — this plugin passes its key on the command line, which Scient doesn't allow";
  if (provider?.driver === "scient") return SCIENT_KEYS_UNAVAILABLE;
  return state.status === "needs-key" ? "Needs a key" : null;
}

export function usePluginKeys(input: ExtensionPluginContentsInput) {
  const { environmentId, providerInventory } = useExtensionsEnvironment();
  const projects = useProjects();
  const installed =
    providerInventory?.providers
      .find((provider) => provider.instanceId === input.instanceId)
      ?.plugins?.filter((plugin) => plugin.id === input.entryId || plugin.name === input.entryId) ??
    [];
  const pluginId = input.pluginId ?? (installed.length === 1 ? installed[0]?.id : undefined);
  const project = projects.find(
    (project) => project.environmentId === environmentId && project.workspaceRoot === input.cwd,
  );
  const target: PluginKeyTarget | null = pluginId
    ? {
        pluginId,
        ...(input.instanceId ? { agent: input.instanceId } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(project ? { projectId: project.id } : {}),
      }
    : null;
  const query = useEnvironmentQuery(
    target ? extensionsPluginKeys({ environmentId, input: target }) : null,
  );
  return { ...query, target };
}

export function PluginKeys({
  input,
  provider,
  pluginName,
}: {
  readonly input: ExtensionPluginContentsInput;
  readonly pluginName: string;
  readonly provider?: ServerProvider | undefined;
}) {
  const { environmentId, canWrite } = useExtensionsEnvironment();
  const keys = usePluginKeys(input);
  const accounts = useAccounts(environmentId);
  const permitted = useAtomValue(bindPluginKey.permissionAtom(environmentId));
  const canBind = canWrite && permitted && keys.data?.writable === true;
  const bind = useAtomCommand(bindPluginKey, { reportFailure: true });
  const unbind = useAtomCommand(unbindPluginKey, { reportFailure: true });
  const [adding, setAdding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{
    scope: string;
    envName: string;
    ref: string;
    name: string;
  } | null>(null);
  const scope = JSON.stringify([environmentId, keys.target]);
  const selection = created?.scope === scope ? created : null;
  // Once the query acknowledges this binding, it owns selection again (including later revocation).
  if (
    selection &&
    keys.data?.keys.some(
      (key) => key.envName === selection.envName && key.accountRef === selection.ref,
    )
  )
    setCreated(null);
  if (!keys.target || !keys.data?.keys.length) return null;
  const target = keys.target;
  const change = async (envName: string, ref: string, createdName?: string) => {
    if (!canBind || busy) return;
    setBusy(true);
    setCreated(createdName ? { scope, envName, ref, name: createdName } : null);
    // No `finally`: React Compiler can't lower it, so both paths clear busy themselves.
    try {
      if (ref) {
        const result = await bind({
          environmentId,
          input: { ...target, envName, accountRef: VaultSecretRef.make(ref) },
        });
        if (result._tag !== "Success") setCreated(null);
      } else await unbind({ environmentId, input: { ...target, envName } });
    } catch (error) {
      setCreated(null);
      setBusy(false);
      throw error;
    }
    setBusy(false);
  };
  const label = pluginKeyStatusLabel(keys.data, provider);
  return (
    <DetailSection title="Keys" count={keys.data.keys.length} status={label}>
      {keys.data.keys.map((key) => (
        <div key={key.envName} className="flex min-h-14 flex-wrap items-center gap-3 px-3 py-3">
          <span className="min-w-0 flex-1 text-sm">{key.envName}</span>
          <span className="text-sm text-muted-foreground">Uses</span>
          <div className="w-52">
            <ApiKeyAccountPicker
              aria-label={`${key.envName} account`}
              size="sm"
              disabled={!canBind || busy}
              value={selection?.envName === key.envName ? selection.ref : (key.accountRef ?? "")}
              options={[
                ...(selection?.envName === key.envName &&
                !keys.data!.accounts.some((account) => account.ref === selection.ref)
                  ? [{ value: selection.ref, name: selection.name }]
                  : []),
                ...keys.data!.accounts.map((account) => ({
                  value: account.ref,
                  name: account.name,
                })),
                ...(key.accountRef &&
                !keys.data!.accounts.some((account) => account.ref === key.accountRef)
                  ? [{ value: key.accountRef, name: "Unavailable account" }]
                  : []),
              ]}
              onChange={(event) => void change(key.envName, event.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={!canBind || busy || !accounts.canWrite}
            onClick={() => setAdding(key.envName)}
          >
            Add key
          </Button>
        </div>
      ))}
      {adding && accounts.data ? (
        <AccountDialog
          environmentId={environmentId}
          snapshot={accounts.data}
          account={null}
          canWrite={accounts.canWrite}
          initialApiKey={{
            name: pluginName,
            envName: adding,
            sites: keys.data.keys.find((key) => key.envName === adding)?.origins ?? [],
          }}
          onSaved={(accountId) => void change(adding, `account:${accountId}:token`, pluginName)}
          onClose={() => setAdding(null)}
        />
      ) : null}
    </DetailSection>
  );
}
