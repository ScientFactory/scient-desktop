import { useGT, useLocale } from "gt-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { languageLabel } from "../../lib/languageLabel";
import { transcriptionCommand } from "../../rpc/transcription";
import { RecordingSelect } from "./RecordingSelect";
import { fileName, type Project } from "./recordingTypes";
import { useRecordingRead } from "./useRecordingRead";
import { andFinally } from "../../lib/compilerSafe";

export type TranscriptMedia = { project: Project; source: string; revision?: string };

export function ImportTranscriptDialog({
  file,
  projects,
  selectedProject,
  media,
  matched,
  copy,
  onClose,
  onImported,
}: {
  file: File;
  projects: readonly Project[];
  selectedProject?: Project | undefined;
  media: readonly TranscriptMedia[];
  matched?: TranscriptMedia | undefined;
  copy: (file: File, project: Project) => Promise<string>;
  onClose: () => void;
  onImported: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const [projectId, setProject] = useState(selectedProject?.id ?? "");
  const [zoomVtt, setZoomVtt] = useState(false);
  const [source, setSource] = useState(matched?.source ?? "");
  const [copied, setCopied] = useState<{ projectId: string; path: string }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const project = projects.find(({ id }) => id === projectId);
  const selection = media.find((item) => item.project.id === projectId && item.source === source);
  const path = copied?.projectId === projectId ? copied.path : undefined;
  const inventory = useRecordingRead(project && selection && path ? project.id : "", (signal) =>
    transcriptionCommand(
      "inventory",
      project!.workspaceRoot,
      { language: "auto", details: true },
      signal,
    ),
  );
  const model = inventory.data?.local.find((item) => item.installed)?.id;
  const format = /\.docx$/i.test(file.name) ? "teams-docx" : zoomVtt ? "zoom-vtt" : undefined;
  const subtitles: { file: string; format?: "teams-docx" | "zoom-vtt" } | undefined = path
    ? { file: path, ...(format ? { format } : {}) }
    : undefined;
  const check = useRecordingRead(
    selection && subtitles && model ? JSON.stringify([source, subtitles.file, model, format]) : "",
    (signal) =>
      transcriptionCommand(
        "assess-subtitles",
        project!.workspaceRoot,
        { source, model: model!, subtitles: subtitles! },
        signal,
      ),
  );
  const quality = check.data?.assessment.quality;
  const checking = Boolean(
    selection &&
    path &&
    ((!inventory.data && !inventory.isError) || (model && !check.data && !check.isError)),
  );
  const submit = async () => {
    if (!project || pending || checking) return;
    setPending(true);
    setError(false);
    await andFinally(
      async () => {
        try {
          const imported = path ?? (await copy(file, project));
          setCopied({ projectId, path: imported });
          if (selection && !path) return;
          await transcriptionCommand("import-transcript", project.workspaceRoot, {
            file: imported,
            ...(format ? { format } : {}),
            ...(selection ? { source: selection.source } : {}),
            ...(selection?.revision ? { previousId: selection.revision } : {}),
          });
          onImported();
        } catch {
          setError(true);
        }
      },
      () => {
        setPending(false);
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{gt("Import transcript")}</DialogTitle>
          <DialogDescription>{file.name}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            {!matched && (
              <div className="flex items-center justify-between gap-2 text-sm">
                {gt("Project")}
                <RecordingSelect
                  label={gt("Project")}
                  variant="outline"
                  value={projectId}
                  options={projects.map(({ id, title }) => ({ value: id, label: title }))}
                  onChange={(id) => {
                    setProject(id);
                    setSource("");
                  }}
                />
              </div>
            )}
            <div className="flex items-center justify-between gap-2 text-sm">
              {gt("Matching recording")}
              {matched ? (
                <bdi>{fileName(matched.source)}</bdi>
              ) : (
                <RecordingSelect
                  label={gt("Matching recording")}
                  variant="outline"
                  value={source}
                  options={[
                    { value: "", label: gt("No media") },
                    ...media
                      .filter((item) => item.project.id === projectId)
                      .map((item) => ({
                        value: item.source,
                        label: fileName(item.source),
                      })),
                  ]}
                  onChange={setSource}
                />
              )}
            </div>
            {/\.vtt$/i.test(file.name) && (
              <div className="flex items-center justify-between gap-2 text-sm">
                {gt("Transcript format")}
                <RecordingSelect
                  label={gt("Transcript format")}
                  variant="outline"
                  value={zoomVtt ? "zoom" : "standard"}
                  options={[
                    { value: "standard", label: gt("WebVTT") },
                    { value: "zoom", label: gt("Zoom VTT") },
                  ]}
                  onChange={(value) => setZoomVtt(value === "zoom")}
                />
              </div>
            )}
            {!selection && (
              <p className="text-xs text-muted-foreground">
                {gt("The transcript will open as a recording without playback.")}
              </p>
            )}
            {checking && (
              <p role="status" className="text-xs text-muted-foreground">
                {gt("Checking the transcript against the audio…")}
              </p>
            )}
            {selection && path && !checking && (
              <p role="status" className="text-xs text-muted-foreground">
                {quality
                  ? [
                      quality.subtitleLanguage && languageLabel(quality.subtitleLanguage, locale),
                      quality.coverage != null &&
                        gt("{percent}% speech coverage", {
                          percent: Math.round(100 * quality.coverage),
                        }),
                      quality.wordErrorRate != null &&
                        gt("{percent}% sample word error", {
                          percent: Math.round(100 * quality.wordErrorRate),
                        }),
                      quality.recommendation === "use-subtitles"
                        ? gt("The sampled text closely matches the audio.")
                        : gt("The sampled text differs from the audio."),
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : gt("Transcript quality could not be checked.")}
              </p>
            )}
            {error && (
              <p role="status" className="text-sm text-muted-foreground">
                {gt("Could not import the transcript.")}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {gt("Cancel")}
          </Button>
          <Button disabled={!project || pending || checking} onClick={() => void submit()}>
            {selection && !path ? gt("Check quality") : gt("Import transcript")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
