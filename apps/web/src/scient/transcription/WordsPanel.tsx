import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  WS_METHODS,
  type EnvironmentId,
  type ProjectId,
  type WordsCommand,
  type WordsCommandResult,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { useSearchableSetting } from "~/components/settings/settingsSearch";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useProjects } from "~/state/entities";
import { localEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { TranscriptionSelect } from "../voice/TranscriptionSelect";
import { WordsEditor, WordsScopes } from "./WordsEditor";

const manageWords = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice:manage-words",
  tag: WS_METHODS.voiceManageWords,
  concurrency: { mode: "parallel" },
});

function useWordsRequest(environmentId: EnvironmentId, input: WordsCommand) {
  const run = useStableCallback(useAtomCommand(manageWords, { reportFailure: false }));
  const [initial] = useState(() => input);
  const [data, setData] = useState<WordsCommandResult>();
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const request = useStableCallback(async (command: WordsCommand, signal?: AbortSignal) => {
    setPending(true);
    setFailed(false);
    const response = await run({ environmentId, input: command }, { signal });
    if (signal?.aborted) return false;
    setPending(false);
    if (response._tag === "Success") {
      setData(response.value);
      return true;
    }
    setFailed(true);
    return false;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the scope this keyed editor represents
  useEffect(() => {
    const controller = new AbortController();
    void request(initial, controller.signal);
    return () => controller.abort();
  }, [initial, request]);

  return { data, failed, pending, request };
}

function ScopeEditor({
  environmentId,
  projectId,
  revisionId,
  level,
  leading,
}: {
  environmentId: EnvironmentId;
  projectId?: ProjectId;
  revisionId?: string;
  level: "global" | "project" | "recording";
  leading?: React.ReactNode;
}) {
  const gt = useGT();
  const target = {
    level,
    ...(projectId ? { projectId } : {}),
    ...(revisionId ? { id: revisionId } : {}),
  };
  const { data, failed, pending, request } = useWordsRequest(environmentId, {
    action: "words-list",
    ...target,
  });
  return (
    <>
      {failed && <p role="status">{gt("Could not open or save Words.")}</p>}
      <WordsEditor
        leading={leading}
        label={gt("word list")}
        words={data?.words ?? []}
        disabled={data === undefined || pending}
        onSave={(word) => void request({ action: "words-add", ...target, word })}
        onRemove={(word) => void request({ action: "words-remove", ...target, word })}
      />
      {revisionId && projectId && (
        <WordSuggestions
          environmentId={environmentId}
          projectId={projectId}
          revisionId={revisionId}
          onAccept={async (word) =>
            request({ action: "words-accept", ...target, suggestionRevision: revisionId, word })
          }
        />
      )}
    </>
  );
}

function WordSuggestions({
  environmentId,
  projectId,
  revisionId,
  onAccept,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  revisionId: string;
  onAccept: (word: NonNullable<WordsCommandResult["words"]>[number]) => Promise<boolean>;
}) {
  const gt = useGT();
  const { data } = useWordsRequest(environmentId, {
    action: "suggestions-list",
    projectId,
    id: revisionId,
  });
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  return (data?.words ?? []).map((word) => {
    const key = JSON.stringify([word.term, word.language]);
    return accepted.has(key) ? null : (
      <Button
        key={key}
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          void onAccept(word).then((saved) => {
            if (saved) setAccepted((previous) => new Set([...previous, key]));
          });
        }}
      >
        {gt("Accept {word}", { word: word.preferred ?? word.term })}
      </Button>
    );
  });
}

/** @public Shared Words surface for the Recordings view and Settings. */
export function RecordingWordsEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly revisionId: string;
}) {
  return (
    <WordsScopes
      key={JSON.stringify([props.environmentId, props.projectId, props.revisionId])}
      initialScope="recording"
      yours={<ScopeEditor {...props} level="global" />}
      project={<ScopeEditor {...props} level="project" />}
      recording={<ScopeEditor {...props} level="recording" />}
    />
  );
}

function RecordingPicker({
  environmentId,
  projectId,
  revisionId,
  onSelect,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  revisionId: string;
  onSelect: (id: string) => void;
}) {
  const gt = useGT();
  const { data, failed } = useWordsRequest(environmentId, { action: "recordings-list", projectId });
  if (failed) return <p role="status">{gt("Could not open recordings.")}</p>;
  if (!data?.recordings?.length) return null;
  return (
    <TranscriptionSelect
      label={gt("Recording")}
      value={revisionId}
      options={[
        { value: "", label: gt("Whole project") },
        ...data.recordings.map(({ id, title }) => ({ value: id, label: title })),
      ]}
      onChange={onSelect}
    />
  );
}

/** Whose Words to edit: yours, a project's, or one recording's, then that list. */
function WordsSettings() {
  const gt = useGT();
  const projects = useProjects().filter((project) => !project.isScratch);
  const local = useAtomValue(localEnvironmentIdAtom);
  const [selection, setSelection] = useState("");
  const [revisionId, setRevisionId] = useState("");
  const keyOf = ({ environmentId, id }: { environmentId: EnvironmentId; id: ProjectId }) =>
    JSON.stringify([environmentId, id]);
  const project = projects.find((candidate) => keyOf(candidate) === selection);
  const environmentId = project?.environmentId ?? local;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canReadFiles = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canWriteFiles = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const canEditProject = canWrite && canOperate && canReadFiles && canWriteFiles;
  const pickers =
    projects.length > 0 ? (
      <div className="flex shrink-0 flex-wrap items-center gap-2 *:w-auto">
        <TranscriptionSelect
          label={gt("Project for Words")}
          value={selection}
          options={[
            { value: "", label: gt("Personal") },
            ...projects.map((item) => ({ value: keyOf(item), label: item.title })),
          ]}
          onChange={(next) => {
            setSelection(next);
            setRevisionId("");
          }}
        />
        {project && canEditProject && (
          <RecordingPicker
            key={`recordings:${selection}`}
            environmentId={project.environmentId}
            projectId={project.id}
            revisionId={revisionId}
            onSelect={setRevisionId}
          />
        )}
      </div>
    ) : null;
  // One recording's Words keep their three lists, so its suggestions can go to any of them.
  if (project && canEditProject && revisionId)
    return (
      <div className="space-y-3">
        {pickers}
        <RecordingWordsEditor
          environmentId={project.environmentId}
          projectId={project.id}
          revisionId={revisionId}
        />
      </div>
    );
  return project && canEditProject ? (
    <ScopeEditor
      key={selection}
      leading={pickers}
      environmentId={project.environmentId}
      projectId={project.id}
      level="project"
    />
  ) : environmentId && canWrite ? (
    <ScopeEditor key="personal" leading={pickers} environmentId={environmentId} level="global" />
  ) : (
    pickers
  );
}

export function WordsSettingsSection() {
  const gt = useGT();
  const setting = useSearchableSetting();
  return (
    <SettingsSection id="voice-dictionary" title={gt("Words")}>
      <SettingsRow
        {...setting("speech-dictionary")}
        title={gt("Names and terms")}
        description={gt("Spellings transcription should use, for you or for one project.")}
      >
        <div className="mt-3">
          <WordsSettings />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

export function ProjectRecordingStorage({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const gt = useGT();
  const { data } = useWordsRequest(environmentId, { action: "recordings-list", projectId });
  return (
    <SettingsRow
      title={gt("Project recordings")}
      description={
        data?.storageBytes !== undefined
          ? gt("{count} audio files · {size} MB at transcription", {
              count: data.sourceCount ?? 0,
              size: Math.round(data.storageBytes / 1_000_000),
            })
          : gt("Recording storage is unavailable.")
      }
    />
  );
}
