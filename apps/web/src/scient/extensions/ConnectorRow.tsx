import type {
  ConnectorProjectPolicy,
  ConnectorProjectSelection,
  ConnectorSummary,
  ConnectorTestResult,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { SettingsRow } from "../../components/settings/settingsLayout";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { NativeSelect } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { ensureLocalApi } from "../../localApi";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  removeConnector,
  setConnectorProjectSelection,
  startConnectorSignIn,
  testConnector,
  updateConnector,
} from "./extensionsState";
import { ActionError, commandFailureMessage, SignInBlockedNotice } from "./ExtensionsFeedback";
import { CONNECTOR_STATUS_PRESENTATION, connectorActions } from "./extensionsView";
import { openAuthorizationPage } from "./openAuthorizationPage";

const PROJECT_POLICY_LABELS: Readonly<Record<ConnectorProjectPolicy, string>> = {
  "all-projects": "All projects",
  "selected-projects": "Selected projects",
};

const TEST_OUTCOME_LABELS: Readonly<Record<ConnectorTestResult["outcome"], string>> = {
  ok: "Reachable",
  "needs-auth": "Needs sign-in",
  unreachable: "Unreachable",
  error: "Error",
};

function sourceLabel(source: ConnectorSummary["source"]): string {
  switch (source.type) {
    case "registry":
      return `MCP Registry · ${source.name}`;
    case "url":
      return "Added by URL";
    case "plugin":
      return `From plugin ${source.pluginId}`;
  }
}

function authLabel(auth: ConnectorSummary["auth"]): string {
  switch (auth.type) {
    case "none":
      return "No sign-in";
    case "oauth":
      return auth.usesOwnClient ? "OAuth · own client" : "OAuth";
    case "credential": {
      const kind =
        auth.strategy === "bearer"
          ? "Bearer token"
          : auth.strategy === "basic"
            ? "Basic auth"
            : `Header ${auth.headerName ?? ""}`.trim();
      return auth.storage === "bound" ? `${kind} from Secrets` : kind;
    }
  }
}

type RowAction = "enable" | "policy" | "project" | "test" | "sign-in" | "remove";

export interface ConnectorRowProject {
  readonly id: ProjectId;
  readonly title: string;
}

export function ConnectorRow({
  environmentId,
  connector,
  projects,
  selections,
  canWrite,
  callbackOrigin,
}: {
  readonly environmentId: EnvironmentId;
  readonly connector: ConnectorSummary;
  readonly projects: ReadonlyArray<ConnectorRowProject>;
  /** This connector's per-project choices. */
  readonly selections: ReadonlyArray<ConnectorProjectSelection>;
  readonly canWrite: boolean;
  /** Origin of the server as this client reaches it; null while unknown. */
  readonly callbackOrigin: string | null;
}) {
  const update = useAtomCommand(updateConnector, { reportFailure: true });
  const setSelection = useAtomCommand(setConnectorProjectSelection, { reportFailure: true });
  const remove = useAtomCommand(removeConnector, { reportFailure: true });
  const test = useAtomCommand(testConnector, { reportFailure: true });
  const startSignIn = useAtomCommand(startConnectorSignIn, { reportFailure: true });
  const [busy, setBusy] = useState<RowAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [blockedSignInUrl, setBlockedSignInUrl] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ConnectorTestResult | null>(null);
  const [signInStartedAt, setSignInStartedAt] = useState<string | null>(null);
  const actions = connectorActions(connector);
  const status = CONNECTOR_STATUS_PRESENTATION[connector.status];
  const name = connector.displayName;
  const locked = !canWrite || busy !== null;
  const connectorId = connector.connectorId;

  const run = async <A,>(
    action: RowAction,
    execute: () => Promise<AtomCommandResult<A, unknown>>,
  ): Promise<AtomCommandResult<A, unknown> | null> => {
    if (locked) return null;
    setBusy(action);
    setActionError(null);
    try {
      const result = await execute();
      setActionError(commandFailureMessage(result));
      return result;
    } finally {
      setBusy(null);
    }
  };

  const signIn = async () => {
    if (locked || callbackOrigin === null) return;
    setBusy("sign-in");
    setActionError(null);
    setBlockedSignInUrl(null);
    try {
      const opening = await openAuthorizationPage(async () => {
        const result = await startSignIn({
          environmentId,
          input: { connectorId, callbackOrigin },
        });
        setActionError(commandFailureMessage(result));
        return result._tag === "Success" ? result.value.authorizationUrl : null;
      });
      if (opening.outcome === "not-started") return;
      setSignInStartedAt(connector.updatedAt);
      if (opening.outcome === "blocked") setBlockedSignInUrl(opening.url);
    } finally {
      setBusy(null);
    }
  };

  const confirmRemove = async () => {
    if (locked) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Remove ${name}? Its stored sign-in or key is deleted and agents stop receiving it.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    await run("remove", () => remove({ environmentId, input: { connectorId } }));
  };

  const waitingForSignIn = signInStartedAt !== null && signInStartedAt === connector.updatedAt;

  return (
    <SettingsRow
      data-connector-id={connectorId}
      title={name}
      description={connector.description ?? connector.url}
      status={
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant={status.tone} data-connector-status={connector.status}>
            {status.label}
          </Badge>
          <span>
            {sourceLabel(connector.source)} · {authLabel(connector.auth)}
          </span>
        </span>
      }
      control={
        <Switch
          checked={connector.enabled}
          disabled={locked}
          aria-label={`${connector.enabled ? "Turn off" : "Turn on"} ${name}`}
          onCheckedChange={(checked) =>
            void run("enable", () =>
              update({ environmentId, input: { connectorId, enabled: Boolean(checked) } }),
            )
          }
        />
      }
    >
      <div className="grid gap-3 pb-2 pt-2">
        {connector.description ? (
          <p className="truncate font-mono text-xs text-muted-foreground">{connector.url}</p>
        ) : null}
        {connector.lastError ? (
          <p className="text-xs text-destructive-foreground">{connector.lastError}</p>
        ) : null}
        {connector.status === "needs-credential" ? (
          <p className="text-xs text-muted-foreground">
            {connector.auth.type === "credential" && connector.auth.storage === "bound"
              ? "The secret this service used is no longer available."
              : "The stored key is gone. Remove this service and add it again."}
          </p>
        ) : null}
        {waitingForSignIn ? (
          blockedSignInUrl !== null ? (
            <SignInBlockedNotice url={blockedSignInUrl} />
          ) : (
            <p className="text-xs text-muted-foreground">
              Finish signing in in your browser. This updates when the service confirms.
            </p>
          )
        ) : null}
        <ActionError message={actionError} />
        <div className="flex flex-wrap items-center gap-2">
          {actions.signIn ? (
            <Button
              size="xs"
              variant={actions.signIn === "sign-in" ? "default" : "outline"}
              disabled={locked || callbackOrigin === null}
              title={callbackOrigin === null ? "Connect to the environment to sign in." : undefined}
              onClick={() => void signIn()}
            >
              {actions.signIn === "sign-in" ? "Sign in" : "Reconnect"}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={locked || !actions.canTest}
            onClick={async () => {
              const result = await run("test", () =>
                test({ environmentId, input: { connectorId } }),
              );
              if (result?._tag === "Success") setTestResult(result.value);
            }}
          >
            {busy === "test" ? "Testing…" : "Test"}
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={locked}
            onClick={() => void confirmRemove()}
          >
            Remove
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="text-muted-foreground" htmlFor={`connector-policy-${connectorId}`}>
            Available in
          </label>
          <span className="w-44">
            <NativeSelect
              id={`connector-policy-${connectorId}`}
              size="sm"
              value={connector.projectPolicy}
              disabled={locked}
              onChange={(event) => {
                const projectPolicy = event.target.value as ConnectorProjectPolicy;
                void run("policy", () =>
                  update({ environmentId, input: { connectorId, projectPolicy } }),
                );
              }}
            >
              {(Object.keys(PROJECT_POLICY_LABELS) as ConnectorProjectPolicy[]).map((policy) => (
                <option key={policy} value={policy}>
                  {PROJECT_POLICY_LABELS[policy]}
                </option>
              ))}
            </NativeSelect>
          </span>
        </div>
        {connector.projectPolicy === "selected-projects" ? (
          projects.length === 0 ? (
            <p className="text-xs text-muted-foreground">No projects yet.</p>
          ) : (
            <ul className="grid gap-1.5" aria-label={`Projects for ${name}`}>
              {projects.map((project) => {
                const enabled =
                  selections.find((selection) => selection.projectId === project.id)?.enabled ??
                  false;
                return (
                  <li key={project.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate">{project.title}</span>
                    <Switch
                      size="sm"
                      checked={enabled}
                      disabled={locked}
                      aria-label={`${enabled ? "Turn off" : "Turn on"} ${name} in ${project.title}`}
                      onCheckedChange={(checked) =>
                        void run("project", () =>
                          setSelection({
                            environmentId,
                            input: {
                              connectorId,
                              projectId: project.id,
                              enabled: Boolean(checked),
                            },
                          }),
                        )
                      }
                    />
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
        {testResult ? (
          <div className="grid gap-1 rounded-lg border border-border/60 p-2 text-xs" role="status">
            <p>
              <span className="font-medium">{TEST_OUTCOME_LABELS[testResult.outcome]}</span>
              {testResult.serverName ? (
                <span className="text-muted-foreground">
                  {" "}
                  · {testResult.serverName}
                  {testResult.serverVersion ? ` ${testResult.serverVersion}` : ""}
                </span>
              ) : null}
              {testResult.message ? (
                <span className="text-muted-foreground"> · {testResult.message}</span>
              ) : null}
            </p>
            {testResult.tools.length > 0 ? (
              <ul className="grid gap-0.5" aria-label={`Tools of ${name}`}>
                {testResult.tools.map((tool) => (
                  <li key={tool.name} className="flex gap-2">
                    <span className="font-mono">{tool.name}</span>
                    {tool.destructive ? (
                      <span className="text-destructive-foreground">changes data</span>
                    ) : tool.readOnly ? (
                      <span className="text-muted-foreground">read-only</span>
                    ) : null}
                    {tool.description ? (
                      <span className="truncate text-muted-foreground">{tool.description}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : testResult.outcome === "ok" ? (
              <p className="text-muted-foreground">No tools reported.</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </SettingsRow>
  );
}
