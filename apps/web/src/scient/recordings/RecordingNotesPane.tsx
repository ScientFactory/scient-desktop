import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  listRecordingNotes,
  makeRecordingNotes,
  type RecordingNoteRecipe,
} from "../../rpc/transcription";
import { CorrectionModelPicker } from "./CorrectionModelPicker";
import { RecordingSelect } from "./RecordingSelect";
import { useRecordingRead } from "./useRecordingRead";
import { andFinally } from "../../lib/compilerSafe";

const Markdown = lazy(() => import("../../components/ChatMarkdown"));

const RECIPES = ["summary", "study-notes", "action-items"] as const;

export function RecordingNotesPane({
  project,
  id,
  environmentId,
  completed,
}: {
  project: string;
  id: string;
  environmentId: EnvironmentId;
  completed: boolean;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const [recipe, setRecipe] = useState<RecordingNoteRecipe>("summary");
  const [needsModel, setNeedsModel] = useState(false);
  const [model, setModel] = useState<ModelSelection>();
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState("");
  const notes = useRecordingRead(
    id,
    (signal) => listRecordingNotes(project, id, signal),
    5000,
    refresh,
  );
  const current = notes.data?.find((note) => note.threadId === selected) ?? notes.data?.[0];
  const labels: Record<RecordingNoteRecipe, string> = {
    summary: gt("Summary"),
    "study-notes": gt("Study notes"),
    "action-items": gt("Action items"),
    lesson: gt("Lesson notes"),
  };
  const make = async (next: RecordingNoteRecipe) => {
    setRecipe(next);
    setWaiting(true);
    setError(false);
    await andFinally(
      async () => {
        try {
          const result = model
            ? await makeRecordingNotes(project, id, next, model)
            : await makeRecordingNotes(project, id, next);
          if (result && "needsModel" in result) {
            setNeedsModel(true);
            setModel(undefined);
          } else {
            setNeedsModel(false);
            setSelected("");
            setRefresh((value) => value + 1);
          }
        } catch {
          setError(true);
        }
      },
      () => {
        setWaiting(false);
      },
    );
  };
  const blocked = !completed || waiting || (needsModel && !model);
  const status =
    notes.isError || error ? (
      <p role="status" className="text-xs text-muted-foreground">
        {gt("Could not load or make notes")}
      </p>
    ) : null;
  const modelPicker = needsModel ? (
    <div className="flex flex-wrap items-center gap-2">
      <CorrectionModelPicker
        selection={model}
        onChange={setModel}
        label={gt("Choose a model for notes")}
        providerOnly
      />
      <Button size="sm" disabled={blocked} onClick={() => void make(recipe)}>
        {gt("Make notes")}
      </Button>
    </div>
  ) : null;

  if (!notes.data?.length) {
    return (
      <div
        role="region"
        aria-label={gt("Recording notes")}
        tabIndex={-1}
        data-recording-focus
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto py-4"
      >
        {notes.data ? (
          <>
            <div>
              <h2 className="text-sm font-medium">{gt("Make notes from this transcript")}</h2>
              <p className="text-sm text-muted-foreground">
                {completed
                  ? gt("Notes are saved as a document in the project.")
                  : gt("Available when the transcription finishes.")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {RECIPES.map((value) => (
                <Button
                  key={value}
                  variant="outline"
                  size="sm"
                  disabled={!completed || waiting}
                  onClick={() => void make(value)}
                >
                  {labels[value]}
                </Button>
              ))}
            </div>
            {modelPicker}
          </>
        ) : notes.isError ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            {gt("Loading notes…")}
          </p>
        )}
        {status}
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label={gt("Recording notes")}
      tabIndex={-1}
      data-recording-focus
      className="flex min-h-0 flex-1 flex-col overflow-auto"
    >
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <RecordingSelect
          label={gt("Notes version")}
          value={current?.threadId ?? ""}
          onChange={setSelected}
          options={notes.data.map((note, index) => ({
            value: note.threadId,
            label: `${labels[note.recipe]} · ${notes.data!.length - index}`,
          }))}
        />
        <div className="ms-auto flex items-center gap-1">
          {current?.text && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const threadId = ThreadId.make(current.threadId);
                useRightPanelStore
                  .getState()
                  .openFile(scopeThreadRef(environmentId, threadId), current.path);
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId },
                });
              }}
            >
              {gt("Open as document")}
            </Button>
          )}
          <Menu>
            <MenuTrigger
              render={<Button variant="outline" size="sm" disabled={!completed || waiting} />}
            >
              {gt("New notes")}
              <ChevronDownIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {RECIPES.map((value) => (
                <MenuItem key={value} onClick={() => void make(value)}>
                  {labels[value]}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {modelPicker}
      {status}
      {current?.text ? (
        <Suspense fallback={null}>
          <Markdown text={current.text} cwd={project} />
        </Suspense>
      ) : (
        <p role="status" className="py-3 text-sm text-muted-foreground">
          {gt("Writing notes…")}
        </p>
      )}
    </div>
  );
}
