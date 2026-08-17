import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ScientOverleafConnection,
  ScientOverleafOperationSnapshot,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangleIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { useProjects } from "../../state/entities";
import { overleafClient } from "./client";

const BUSY = new Set<ScientOverleafOperationSnapshot["phase"]>([
  "preparing",
  "fetching",
  "rebasing",
  "pushing",
  "projecting",
  "publishing",
]);

function mapsFile(connection: ScientOverleafConnection, relativePath: string): boolean {
  const folder = connection.relativeFolder.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const path = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  return folder === "" || path === folder || path.startsWith(`${folder}/`);
}

export function OverleafLatexToolbarControl(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly onBlockingChange: (blocked: boolean) => void;
}) {
  const navigate = useNavigate();
  const projects = useProjects();
  const [connection, setConnection] = useState<ScientOverleafConnection | null>(null);
  const [operation, setOperation] = useState<ScientOverleafOperationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const projectKey = useMemo(() => {
    const project = projects.find(
      (candidate) =>
        candidate.environmentId === props.environmentId &&
        candidate.workspaceRoot === props.workspaceRoot,
    );
    return project === undefined
      ? null
      : scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
  }, [projects, props.environmentId, props.workspaceRoot]);

  const readPersisted = useCallback(async () => {
    const overview = await overleafClient.overview(props.environmentId, props.workspaceRoot);
    const mapped =
      overview.connections
        .filter((candidate) => mapsFile(candidate, props.relativePath))
        .toSorted((left, right) => right.relativeFolder.length - left.relativeFolder.length)[0] ??
      null;
    setConnection(mapped);
    if (mapped) {
      setOperation(
        overview.operations
          .toSorted((left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs)
          .find(
            (candidate) =>
              candidate.connectionId === mapped.connectionId &&
              !["succeeded", "cancelled", "failed"].includes(candidate.phase),
          ) ?? null,
      );
    } else setOperation(null);
  }, [props.environmentId, props.relativePath, props.workspaceRoot]);

  useEffect(() => {
    void readPersisted().catch(() => undefined);
  }, [readPersisted]);

  useEffect(() => {
    const blocked =
      operation?.phase === "awaiting_conflicts" || operation?.phase === "awaiting_local_conflicts";
    props.onBlockingChange(blocked);
  }, [operation?.phase, props.onBlockingChange]);

  useEffect(() => {
    if (!polling || operation === null) return;
    const timer = window.setInterval(() => {
      void overleafClient
        .operation(props.environmentId, operation.operationId)
        .then((next) => {
          setOperation(next);
          if (!BUSY.has(next.phase)) {
            setPolling(false);
            void readPersisted();
          }
        })
        .catch((cause) => {
          setPolling(false);
          setError(cause instanceof Error ? cause.message : "Could not read Overleaf progress.");
        });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [operation, polling, props.environmentId, readPersisted]);

  if (connection === null) return null;
  const needsAttention =
    operation !== null &&
    !BUSY.has(operation.phase) &&
    !["succeeded", "cancelled"].includes(operation.phase);
  const busy = operation !== null && BUSY.has(operation.phase);

  const openSettings = () => {
    if (projectKey === null) return;
    void navigate({ to: "/projects/$projectKey", params: { projectKey } });
  };

  const sync = async () => {
    setError(null);
    try {
      const next = await overleafClient.startSync(props.environmentId, {
        connectionId: connection.connectionId,
      });
      setOperation(next);
      setPolling(BUSY.has(next.phase));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start Overleaf Sync.");
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<span className="scient-latex-chip" />}>Overleaf</TooltipTrigger>
        <TooltipPopup side="top">{connection.relativeFolder || "Workspace root"}</TooltipPopup>
      </Tooltip>
      {error ? (
        <Tooltip>
          <TooltipTrigger render={<span className="scient-latex-chip scient-latex-chip-error" />}>
            Sync failed
          </TooltipTrigger>
          <TooltipPopup side="top">{error}</TooltipPopup>
        </Tooltip>
      ) : null}
      {needsAttention ? (
        <button
          type="button"
          className="scient-latex-action text-warning"
          disabled={projectKey === null}
          onClick={openSettings}
        >
          <AlertTriangleIcon className="size-3.5" /> Review Sync
        </button>
      ) : (
        <button
          type="button"
          className="scient-latex-action"
          disabled={busy}
          onClick={() => void sync()}
        >
          {busy ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
          {busy ? "Syncing…" : "Sync"}
        </button>
      )}
      <button
        type="button"
        className="scient-latex-action"
        disabled={projectKey === null}
        onClick={openSettings}
      >
        Settings
      </button>
    </>
  );
}
