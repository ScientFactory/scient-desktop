import type {
  AgentSessionProjectCandidate,
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { CheckIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  partitionOnboardingProjects,
  resolveOnboardingLandingProject,
  resolveOnboardingProjectId,
} from "../../onboarding/projectImport.logic";
import { newProjectId } from "../../lib/utils";
import { agentSessionImport, agentSessionScan } from "../../state/agentSessions";
import { readProjects, useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { StepShell } from "./StepShell";

const SCAN_LIMIT_MESSAGE = "Scan limit reached. Some projects or conversations may be missing.";

/**
 * One-decision import (4B): a summary line with Import recent / Choose /
 * Skip. The default imports only projects touched in the last 30 days;
 * Choose expands a checklist including older ones. Imported projects also
 * receive Codex and Claude threads active within the last 30 days.
 */
export function ProjectImportStep({
  environmentId,
  machineLabel,
  onImportingChange,
  onBack,
  onDone,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly machineLabel: string;
  readonly onImportingChange?: (importing: boolean) => void;
  readonly onBack: () => void;
  readonly onDone: (projectRef?: ScopedProjectRef) => Promise<boolean>;
}) {
  const scan = useEnvironmentQuery(
    environmentId === null ? null : agentSessionScan({ environmentId, input: {} }),
  );
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const projects = useProjects();
  const [choosing, setChoosing] = useState(false);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [landingProject, setLandingProject] = useState<ScopedProjectRef | null>(null);
  useEffect(() => {
    // Hold modal dismissal only while commands or navigation are running.
    // A delayed shell snapshot after completed imports must not trap the user.
    onImportingChange?.(isImporting && landingProject === null);
  }, [isImporting, landingProject, onImportingChange]);
  // Keep project creation attempts separate from completed history imports so both can retry.
  const importedProjectsRef = useRef(new Map<string, ScopedProjectRef>());
  const projectsWithImportedHistoryRef = useRef(new Map<string, ScopedProjectRef>());
  const lastImportSelectionRef = useRef<ReadonlyArray<string>>([]);
  const projectAttemptsRef = useRef(
    new Map<string, { readonly projectId: ProjectId; readonly commandId: CommandId }>(),
  );
  const importGenerationRef = useRef(0);

  // Candidate paths are per-environment; a target switch would otherwise
  // leave stale entries in the deselection set (and stale success records).
  useEffect(() => {
    importGenerationRef.current += 1;
    setDeselected(new Set());
    setIsImporting(false);
    setImportError("");
    setLandingProject(null);
    importedProjectsRef.current = new Map();
    projectsWithImportedHistoryRef.current = new Map();
    lastImportSelectionRef.current = [];
    projectAttemptsRef.current = new Map();
    return () => {
      importGenerationRef.current += 1;
    };
  }, [environmentId]);

  useEffect(() => {
    if (
      landingProject !== null &&
      landingProject.environmentId === environmentId &&
      projects.some(
        (project) =>
          project.id === landingProject.projectId &&
          project.environmentId === landingProject.environmentId,
      )
    ) {
      setLandingProject(null);
      void onDone(landingProject).then((completed) => {
        if (!completed) setIsImporting(false);
      });
    }
  }, [environmentId, landingProject, onDone, projects]);

  const { available: candidates, recent } = useMemo(
    () => partitionOnboardingProjects(scan.data?.candidates ?? []),
    [scan.data],
  );
  const more = candidates.length - recent.length;
  const scanTruncated = scan.data?.truncated === true;
  const scanLimitNotice = scanTruncated ? (
    <p className="mt-3 text-sm text-muted-foreground" role="status">
      {SCAN_LIMIT_MESSAGE}
    </p>
  ) : null;

  const finishAfterImport = () => {
    const projectRef = resolveOnboardingLandingProject(
      lastImportSelectionRef.current,
      projectsWithImportedHistoryRef.current,
      importedProjectsRef.current,
    );
    if (projectRef === undefined) {
      void onDone();
      return;
    }
    setIsImporting(true);
    setLandingProject(projectRef);
  };

  const runImport = async (selection: ReadonlyArray<AgentSessionProjectCandidate>) => {
    if (environmentId === null || selection.length === 0) {
      void onDone();
      return;
    }
    setIsImporting(true);
    setImportError("");
    lastImportSelectionRef.current = selection.map((candidate) => candidate.path);
    const importGeneration = importGenerationRef.current;
    const importedProjects = importedProjectsRef.current;
    const projectAttempts = projectAttemptsRef.current;
    // Interrupted imports are neither failures nor successes — the command was
    // superseded or the environment dropped — but they still didn't land, so
    // they must not read as "imported everything". Retries skip paths that
    // already landed this session (re-creating them would only trip the
    // duplicate-root invariant and read as a failure).
    let importedProjectsCount =
      importedProjects.size > 0
        ? selection.filter((candidate) => importedProjects.has(candidate.path)).length
        : 0;
    let importedThreadCount = 0;
    let skippedThreadCount = 0;
    let shouldRefreshScan = false;
    for (const candidate of selection) {
      if (
        importGeneration !== importGenerationRef.current ||
        importedProjects !== importedProjectsRef.current
      ) {
        return;
      }
      if (importedProjects.has(candidate.path)) continue;
      let projectId = resolveOnboardingProjectId(readProjects(), environmentId, candidate);
      if (projectId === null) {
        let attempt = projectAttempts.get(candidate.path);
        if (attempt === undefined) {
          const nextProjectId = newProjectId();
          attempt = {
            projectId: nextProjectId,
            commandId: CommandId.make(`onboarding:project:create:${nextProjectId}`),
          };
          projectAttempts.set(candidate.path, attempt);
        }
        projectId = attempt.projectId;
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            commandId: attempt.commandId,
            title: candidate.title,
            workspaceRoot: candidate.path,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (
          importGeneration !== importGenerationRef.current ||
          importedProjects !== importedProjectsRef.current
        ) {
          return;
        }
        if (result._tag !== "Success") {
          if (!isAtomCommandInterrupted(result)) {
            projectAttempts.delete(candidate.path);
            shouldRefreshScan = true;
          }
          continue;
        }
      }

      const threadImportResult = await importThreads({
        environmentId,
        input: { projectId, expectedWorkspaceRoot: candidate.path },
      });
      if (
        importGeneration !== importGenerationRef.current ||
        importedProjects !== importedProjectsRef.current
      ) {
        return;
      }
      if (threadImportResult._tag === "Success") {
        importedThreadCount += threadImportResult.value.importedCount;
        skippedThreadCount += threadImportResult.value.skippedCount;
        if (threadImportResult.value.importedCount > 0) {
          projectsWithImportedHistoryRef.current.set(
            candidate.path,
            scopeProjectRef(environmentId, projectId),
          );
        }
        if (threadImportResult.value.skippedCount === 0) {
          importedProjectsCount += 1;
          importedProjects.set(candidate.path, scopeProjectRef(environmentId, projectId));
        }
      } else if (!isAtomCommandInterrupted(threadImportResult)) {
        projectAttempts.delete(candidate.path);
        shouldRefreshScan = true;
      }
    }
    if (shouldRefreshScan) scan.refresh();
    setIsImporting(false);
    if (importedProjectsCount < selection.length) {
      if (importedThreadCount > 0 && skippedThreadCount > 0) {
        setImportError(
          `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}. ${skippedThreadCount} ${skippedThreadCount === 1 ? "thread" : "threads"} could not be imported.`,
        );
      } else if (skippedThreadCount > 0) {
        setImportError(
          `${skippedThreadCount} ${skippedThreadCount === 1 ? "thread could" : "threads could"} not be imported.`,
        );
      } else if (importedThreadCount > 0) {
        setImportError(
          `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}. Some thread history could not be imported.`,
        );
      } else {
        setImportError("Could not import thread history.");
      }
      return;
    }
    finishAfterImport();
  };

  if (environmentId === null || (scan.isPending && scan.data === null)) {
    return (
      <StepShell
        title="Your projects"
        description="Looking for projects from Claude Code and Codex."
        onBack={onBack}
      >
        <div className="mt-6 flex justify-end">
          <Button variant="ghost-muted" onClick={() => void onDone()}>
            Skip
          </Button>
        </div>
      </StepShell>
    );
  }

  if (scan.error !== null || candidates.length === 0) {
    return (
      <StepShell
        title="Your projects"
        description={
          scan.error !== null
            ? "Could not check this computer for projects."
            : scanTruncated
              ? SCAN_LIMIT_MESSAGE
              : "No existing Claude Code or Codex projects found."
        }
        onBack={onBack}
      >
        {scan.error !== null ? (
          <p className="mt-3 text-xs text-muted-foreground">You can add projects later.</p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          {scan.error !== null ? (
            <Button variant="ghost" onClick={scan.refresh}>
              Retry
            </Button>
          ) : null}
          <Button
            variant={scan.error !== null || scanTruncated ? "ghost-muted" : "default"}
            onClick={() => void onDone()}
          >
            {scan.error !== null || scanTruncated ? "Skip" : "Start coding"}
          </Button>
        </div>
      </StepShell>
    );
  }

  if (choosing) {
    const selected = candidates.filter((candidate) => !deselected.has(candidate.path));
    return (
      <StepShell
        title="Choose your projects"
        onBack={() => setChoosing(false)}
        backDisabled={isImporting}
        description={`${candidates.length} found on ${machineLabel}.`}
      >
        {scanLimitNotice}
        <div className="mt-6 max-h-72 overflow-x-hidden overflow-y-auto border-y border-border">
          {candidates.map((candidate) => (
            <label
              key={candidate.path}
              className="flex min-h-12 cursor-pointer items-center gap-3 border-b border-border/60 px-1 py-2 last:border-b-0 hover:bg-accent/50"
            >
              <Checkbox
                disabled={isImporting}
                checked={!deselected.has(candidate.path)}
                onCheckedChange={(checked) => {
                  setDeselected((previous) => {
                    const next = new Set(previous);
                    if (checked === true) next.delete(candidate.path);
                    else next.add(candidate.path);
                    return next;
                  });
                }}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                {candidate.path}
              </span>
              <span className="hidden shrink-0 whitespace-nowrap text-[11px] text-muted-foreground sm:block">
                {candidate.sources.map(formatSource).join(", ")} · {candidate.threadCount}{" "}
                {candidate.threadCount === 1 ? "thread" : "threads"}
                {candidate.lastActiveAt
                  ? ` · ${formatRelativeTimeLabel(candidate.lastActiveAt)}`
                  : ""}
              </span>
            </label>
          ))}
        </div>
        {importError ? <p className="mt-3 text-sm text-destructive">{importError}</p> : null}
        <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="ghost-muted"
            disabled={isImporting}
            onClick={importError ? finishAfterImport : () => void onDone()}
          >
            {importError ? "Continue without the rest" : "Skip"}
          </Button>
          <Button
            disabled={isImporting || selected.length === 0}
            onClick={() => void runImport(selected)}
          >
            {isImporting ? "Importing..." : `Import ${selected.length}`}
          </Button>
        </div>
      </StepShell>
    );
  }

  return (
    <StepShell
      title="Your recent projects"
      description={`${recent.length} ${recent.length === 1 ? "project" : "projects"} found on ${machineLabel}.${more > 0 ? ` ${more} more available.` : ""}`}
      onBack={onBack}
      backDisabled={isImporting}
    >
      {scanLimitNotice}
      <div className="mt-6 border-y border-border">
        {recent.slice(0, 4).map((candidate) => (
          <div
            key={candidate.path}
            className="flex min-h-12 items-center gap-3 border-b border-border/60 px-1 py-2 last:border-b-0"
          >
            <CheckIcon className="size-3.5 shrink-0 text-success-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
              {candidate.path}
            </span>
            <span className="hidden shrink-0 whitespace-nowrap text-[11px] text-muted-foreground sm:block">
              {candidate.sources.map(formatSource).join(", ")}
            </span>
          </div>
        ))}
        {recent.length > 4 ? (
          <p className="px-1 py-3 text-xs text-muted-foreground">
            {recent.length - 4} more projects
          </p>
        ) : null}
      </div>
      {importError ? <p className="mt-3 text-sm text-destructive">{importError}</p> : null}
      <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="ghost-muted"
          disabled={isImporting}
          onClick={importError ? finishAfterImport : () => void onDone()}
        >
          {importError ? "Continue without the rest" : "Skip"}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" disabled={isImporting} onClick={() => setChoosing(true)}>
            Choose
          </Button>
          <Button
            disabled={isImporting || recent.length === 0}
            onClick={() => void runImport(recent)}
          >
            {isImporting
              ? "Importing..."
              : `Import ${recent.length} ${recent.length === 1 ? "project" : "projects"}`}
          </Button>
        </div>
      </div>
    </StepShell>
  );
}

function formatSource(source: "claudeAgent" | "codex"): string {
  return source === "claudeAgent" ? "Claude" : "Codex";
}
