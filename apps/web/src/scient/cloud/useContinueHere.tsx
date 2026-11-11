import type { ThreadIndexRow } from "@scientfactory/scient-cloud/api";
import { EnvironmentId, ProjectId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useComposerDraftStore } from "~/composerDraftStore";
import { mergeEnvironmentSettings, useClientSettings } from "~/hooks/useSettings";
import { useProjects, useServerConfigs } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";

import { newChatModelSelection } from "../conversationImport/importDestination.logic";
import type { CloudApi } from "./cloudApi";
import { readCloudStatus, takeOverCloudThread } from "./serverCloud";

type Candidate = { readonly projectId: ProjectId; readonly title: string };

/** Conversations being continued here right now: a repeat click never takes a second lease. */
const inFlight = new Set<string>();

/**
 * "Continue on this computer": takes the conversation's lease for this computer, then imports the
 * copy into the matching local project as a new thread that continues it.
 */
export function useContinueHere(api: CloudApi) {
  const projects = useProjects();
  const configs = useServerConfigs();
  const providersByEnvironment = useEnvironmentProviders();
  const clientSettings = useClientSettings();
  const stickyModelSelectionByProvider = useComposerDraftStore(
    (store) => store.stickyModelSelectionByProvider,
  );
  const stickyActiveProvider = useComposerDraftStore((store) => store.stickyActiveProvider);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [choice, setChoice] = useState<{
    readonly candidates: ReadonlyArray<Candidate>;
    readonly resolve: (projectId: ProjectId | null) => void;
  } | null>(null);
  // A pending project choice; leaving the page cancels it, so its claim is released.
  const pendingChoice = useRef<((projectId: ProjectId | null) => void) | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases this page's entry in the module-level in-flight registry when it unmounts mid-choice
  useEffect(() => () => pendingChoice.current?.(null), []);

  const modelFor = (
    environmentId: EnvironmentId,
    projectId: ProjectId | null,
  ): ModelSelection | null => {
    const config = configs.get(environmentId);
    if (config === undefined) return null;
    const project =
      projects.find(
        (candidate) =>
          candidate.environmentId === environmentId &&
          (projectId === null || candidate.id === projectId),
      ) ?? null;
    return newChatModelSelection({
      providers: providersByEnvironment.get(environmentId),
      settings: mergeEnvironmentSettings(config.settings, clientSettings),
      project,
      carrySelection: null,
      sticky: {
        modelSelectionByProvider: stickyModelSelectionByProvider,
        activeProvider: stickyActiveProvider,
      },
    });
  };

  /** Runs `task` unless one for `key` is already running; a repeat gives null. */
  const once = async (key: string, task: () => Promise<string | null>): Promise<string | null> => {
    if (inFlight.has(key)) return null;
    inFlight.add(key);
    setRunning(true);
    return task().finally(() => {
      inFlight.delete(key);
      setRunning(false);
    });
  };

  const continueRow = async (row: ThreadIndexRow, here: string): Promise<string | null> => {
    const environmentId = EnvironmentId.make(here);
    setProblem(null);
    try {
      const status = await readCloudStatus(environmentId).catch(() => null);
      if (status !== null && (status.enrolledUserId === null || !status.enabled)) {
        setProblem("Turn on Cloud copy on this computer first, in Settings > Sharing & access.");
        return null;
      }
      const { generation } = await api.lease(row.environmentId, row.threadId, environmentId);
      let projectId: ProjectId | null = null;
      for (;;) {
        const modelSelection = modelFor(environmentId, projectId);
        if (modelSelection === null) {
          setProblem("Set up a model on this computer first.");
          return null;
        }
        const result = await takeOverCloudThread(environmentId, {
          source: { environmentId: row.environmentId, threadId: ThreadId.make(row.threadId) },
          generation,
          projectKey: row.projectKey,
          ...(row.relativePath ? { relativePath: row.relativePath } : {}),
          ...(projectId === null ? {} : { projectId }),
          modelSelection,
        });
        if (result._tag === "imported") return result.threadId;
        projectId = await new Promise<ProjectId | null>((resolve) => {
          pendingChoice.current = resolve;
          setChoice({ candidates: result.candidates, resolve });
        });
        pendingChoice.current = null;
        setChoice(null);
        if (projectId === null) return null;
      }
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : "The conversation couldn't be continued here.",
      );
      return null;
    }
  };

  /** Continues `row` here and gives the new thread's id, or null. */
  const run = (row: ThreadIndexRow, here: string) =>
    once(`${row.environmentId}/${row.threadId}`, () => continueRow(row, here));
  /** Like `run`, finding the row first inside the same guard, keyed by `key`. */
  const runFound = (key: string, find: () => Promise<ThreadIndexRow | null>, here: string) =>
    once(key, async () => {
      const row = await find();
      return row === null ? null : continueRow(row, here);
    });

  const chooser =
    choice === null ? null : (
      <ProjectChooser candidates={choice.candidates} onChoose={choice.resolve} />
    );
  return { run, runFound, running, problem, chooser };
}

function ProjectChooser({
  candidates,
  onChoose,
}: {
  candidates: ReadonlyArray<Candidate>;
  onChoose: (projectId: ProjectId | null) => void;
}) {
  const [selected, setSelected] = useState<ProjectId | null>(candidates[0]?.projectId ?? null);
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Continue in</span>
      <Select value={selected} onValueChange={(value) => setSelected(value)}>
        <SelectTrigger size="sm" className="w-auto max-w-56" aria-label="Project">
          <SelectValue>
            {(value: ProjectId | null) =>
              candidates.find((candidate) => candidate.projectId === value)?.title ??
              "Choose a project"
            }
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {candidates.map((candidate) => (
            <SelectItem hideIndicator key={candidate.projectId} value={candidate.projectId}>
              {candidate.title}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Button
        size="sm"
        variant="outline"
        disabled={selected === null}
        onClick={() => onChoose(selected)}
      >
        Continue
      </Button>
      <Button size="sm" variant="ghost-muted" onClick={() => onChoose(null)}>
        Cancel
      </Button>
    </div>
  );
}
