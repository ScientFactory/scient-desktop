import {
  ConnectorId,
  isActionableThreadMcpStatus,
  isProminentThreadMcpIssue,
  type EnvironmentId,
  type ThreadId,
  type ThreadMcpServerObservation,
  type ThreadMcpServerStatusKind,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import { AlertCircleIcon, ChevronRightIcon, PlugIcon } from "lucide-react";
import { useState } from "react";

import { McpSignInAction } from "../../components/chat/McpSignInAction";
import { Button, InlineButton } from "../../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../components/ui/popover";
import { toastManager } from "../../components/ui/toast";
import {
  formatEnvironmentQueryError,
  useEnvironmentQuery,
  useEnvironmentSubscription,
} from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectorSignInButton, ManageConnectorsLink } from "./ConnectorRecoveryAction";
import { extensionsDeliveryReceipt, testConnector, threadMcpStatus } from "./extensionsState";
import { SKIP_REASON_LABELS } from "./extensionsView";

function statusLabel(status: ThreadMcpServerStatusKind, gt: ReturnType<typeof useGT>): string {
  switch (status) {
    case "ready":
      return gt("Ready");
    case "checking":
      return gt("Checking…");
    case "needs-sign-in":
      return gt("Needs sign-in");
    case "credential-rejected":
      return gt("Credential rejected");
    case "permissions-required":
      return gt("Permissions needed");
    case "unreachable":
      return gt("Unavailable");
    case "unavailable":
      return gt("Off");
    case "unknown":
      return gt("Unknown");
  }
}

function ManagedServerAction({
  environmentId,
  server,
}: {
  readonly environmentId: EnvironmentId;
  readonly server: ThreadMcpServerObservation;
}) {
  const gt = useGT();
  const canTest = useAtomValue(testConnector.permissionAtom(environmentId));
  const runTest = useAtomCommand(testConnector, { reportFailure: false });
  const [busy, setBusy] = useState(false);

  if (!server.managedId) return null;
  const connectorId = ConnectorId.make(server.managedId);

  if (server.action === "sign-in") {
    return (
      <ConnectorSignInButton
        environmentId={environmentId}
        connectorId={connectorId}
        displayName={server.displayName}
      />
    );
  }

  if (server.action === "retry" && canTest) {
    return (
      <InlineButton
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void runTest({ environmentId, input: { connectorId } }).then((result) => {
            setBusy(false);
            if (result._tag === "Failure") {
              toastManager.add({
                type: "error",
                title: gt("Check failed"),
                description: formatEnvironmentQueryError(result.cause),
              });
            } else if (result.value.outcome === "ok") {
              toastManager.add({
                type: "success",
                title: gt("{name} is connected", { name: server.displayName }),
              });
            }
          });
        }}
      >
        {busy ? <T>Checking…</T> : <T>Retry</T>}
      </InlineButton>
    );
  }

  return <ManageConnectorsLink environmentId={environmentId} />;
}

function LiveServerRow({
  environmentId,
  threadId,
  server,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly server: ThreadMcpServerObservation;
}) {
  const gt = useGT();
  const actionable = isActionableThreadMcpStatus(server.status);
  const noticeAt = Date.parse(server.observedAt) || 0;

  return (
    <li
      data-mcp-server-status={server.status}
      data-mcp-server-source={server.source}
      className="grid gap-1"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-medium text-foreground">{server.displayName}</span>
        <div className="flex shrink-0 items-center gap-2">
          <span className={actionable ? "text-warning-foreground" : "text-muted-foreground"}>
            {statusLabel(server.status, gt)}
          </span>
          {server.source === "managed" && actionable ? (
            <ManagedServerAction environmentId={environmentId} server={server} />
          ) : server.source !== "managed" &&
            server.status === "needs-sign-in" &&
            server.sessionActive &&
            server.providerThreadId !== undefined ? (
            <McpSignInAction
              environmentId={environmentId}
              threadId={threadId}
              providerThreadId={server.providerThreadId}
              server={server.name}
              noticeAt={noticeAt}
            />
          ) : null}
        </div>
      </div>
      {server.detail ? <p className="text-muted-foreground break-words">{server.detail}</p> : null}
      {server.source !== "managed" && server.status === "needs-sign-in" && !server.sessionActive ? (
        <p className="text-muted-foreground">
          <T>Send a message to wake this session, then sign in here.</T>
        </p>
      ) : null}
    </li>
  );
}

/**
 * Live MCP and connected-services status for the thread: shows both Scient-managed connectors
 * (delivered, skipped, and live health) and native provider MCP servers without polluting chat.
 */
export function ExtensionsReceiptIndicator({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const messages = useMessages();
  const receipt = useEnvironmentQuery(
    extensionsDeliveryReceipt({ environmentId, input: { threadId } }),
  ).data?.receipt;
  const liveSnapshot = useEnvironmentSubscription(
    threadMcpStatus({ environmentId, input: { threadId } }),
  ).data;

  const liveServers = liveSnapshot?.servers ?? [];
  const delivered = receipt?.delivered.length ?? 0;
  const skipped = receipt?.skipped.length ?? 0;
  if (delivered === 0 && skipped === 0 && liveServers.length === 0) return null;

  const prominentIssues = liveServers.filter(isProminentThreadMcpIssue);
  const ambientIssues = liveServers.filter(
    (server) => isActionableThreadMcpStatus(server.status) && !isProminentThreadMcpIssue(server),
  );
  const nativeServers = liveServers.filter(
    (server) =>
      server.source !== "managed" &&
      !isProminentThreadMcpIssue(server) &&
      !ambientIssues.includes(server),
  );
  const issueCount = prominentIssues.length;
  // A skipped connector already listed as needing attention is not repeated below.
  const attentionIds = new Set(prominentIssues.flatMap((server) => server.managedId ?? []));
  const skippedEntries =
    receipt?.skipped.filter(({ entry }) => !attentionIds.has(entry.connectorId)) ?? [];
  const liveManaged = liveServers.some((server) => server.source === "managed");
  // Live health when the thread has it; the delivery receipt otherwise.
  const connectedCount =
    liveServers.filter((server) => server.status === "ready").length +
    (liveManaged ? 0 : delivered);

  const ariaLabel =
    issueCount > 0
      ? gt("Connected services: {connected} ready, {issues} need attention", {
          connected: connectedCount,
          issues: issueCount,
        })
      : receipt !== undefined
        ? gt("Connected services: {delivered} delivered, {skipped} skipped", {
            delivered,
            skipped,
          })
        : gt("Connected services: {count} active", { count: liveServers.length });

  return (
    <Popover>
      <PopoverTrigger
        aria-label={ariaLabel}
        data-extensions-receipt=""
        render={<Button variant="outline" size="micro" className="shrink-0" />}
      >
        <PlugIcon aria-hidden className="size-3" />
        <span>{connectedCount}</span>
        {issueCount > 0 ? (
          <span className="inline-flex items-center gap-1 text-warning-foreground">
            <AlertCircleIcon aria-hidden className="size-3" />
            <T>
              <Var>{issueCount}</Var> attention
            </T>
          </span>
        ) : skipped > 0 ? (
          <span className="text-warning-foreground">
            <T>
              · <Var>{skipped}</Var> skipped
            </T>
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="md" padding="comfortable">
        <div className="grid gap-3 text-xs">
          <PopoverTitle>
            <T>Connected services</T>
          </PopoverTitle>
          {prominentIssues.length > 0 ? (
            <section className="grid gap-2" aria-label={gt("Needs attention")}>
              <h3 className="text-warning-foreground font-medium">
                <T>Needs attention</T>
              </h3>
              <ul className="grid gap-2">
                {prominentIssues.map((server) => (
                  <LiveServerRow
                    key={server.id}
                    environmentId={environmentId}
                    threadId={threadId}
                    server={server}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {receipt !== undefined ? (
            <section className="grid gap-1" aria-label={gt("Delivered")}>
              <h3 className="text-muted-foreground">
                <T>Delivered to this session</T>
              </h3>
              {delivered === 0 ? (
                <p className="text-muted-foreground">
                  <T>None</T>
                </p>
              ) : (
                <ul className="grid gap-1">
                  {receipt.delivered.map((entry) => (
                    <li
                      key={entry.connectorId}
                      className="flex items-baseline justify-between gap-3"
                    >
                      <span className="truncate text-foreground">{entry.displayName}</span>
                      <span className="shrink-0 font-mono text-muted-foreground">
                        {entry.serverName}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
          {nativeServers.length > 0 ? (
            <section className="grid gap-1.5" aria-label={gt("Agent MCP servers")}>
              <h3 className="text-muted-foreground">
                <T>Agent MCP servers</T>
              </h3>
              <ul className="grid gap-1.5">
                {nativeServers.map((server) => (
                  <LiveServerRow
                    key={server.id}
                    environmentId={environmentId}
                    threadId={threadId}
                    server={server}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {skippedEntries.length > 0 ? (
            <section className="grid gap-1" aria-label={gt("Skipped")}>
              <h3 className="text-muted-foreground">
                <T>Skipped</T>
              </h3>
              <ul className="grid gap-1">
                {skippedEntries.map(({ entry, reason }) => (
                  <li
                    key={entry.connectorId}
                    data-skip-reason={reason}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span className="truncate text-foreground">{entry.displayName}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {messages(SKIP_REASON_LABELS[reason])}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {ambientIssues.length > 0 ? (
            <Collapsible data-ambient-mcp-issues={ambientIssues.length}>
              <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 text-left text-muted-foreground">
                <T>
                  Optional servers not signed in: <Var>{ambientIssues.length}</Var>
                </T>
                <ChevronRightIcon
                  aria-hidden
                  className="size-3 shrink-0 transition-transform group-data-[panel-open]:rotate-90"
                />
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <ul className="grid gap-1.5 pt-1.5">
                  {ambientIssues.map((server) => (
                    <LiveServerRow
                      key={server.id}
                      environmentId={environmentId}
                      threadId={threadId}
                      server={server}
                    />
                  ))}
                </ul>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
          <Button
            size="xs"
            variant="ghost-muted"
            className="-ms-2 justify-self-start"
            render={
              <Link to="/settings/extensions/installed" search={{ machine: environmentId }} />
            }
          >
            <T>Manage connected services</T>
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
