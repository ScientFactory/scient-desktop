import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";
import { useComposerDraftStore } from "../../composerDraftStore";
import { Button } from "../../components/ui/button";
import { randomUUID } from "../../lib/utils";
import { linkRecordingThread } from "../../rpc/transcription";
import { recordingTime } from "./recordingPresentation";
import { andFinally } from "../../lib/compilerSafe";

export function AskRecordingButton({
  threadRef,
  onRevealComposer,
  project,
  revision,
  name,
  segments,
}: {
  threadRef: ScopedThreadRef;
  onRevealComposer: () => void;
  project: string;
  revision: string;
  name: string;
  segments: readonly { start: number; end: number; text: string }[];
}) {
  const gt = useGT();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const ask = async () => {
    if (pending) return;
    const first = segments[0];
    const last = segments.at(-1);
    if (!first || !last) return;
    setPending(true);
    setError(false);
    const range = { start: first.start, end: last.end };
    const path = `Transcripts/${revision}/transcript.json`;
    const span = `${recordingTime(range.start)}–${recordingTime(range.end)}`;
    await andFinally(
      async () => {
        try {
          const drafts = useComposerDraftStore.getState();
          const target = drafts.getDraftIdByRef(threadRef) ?? threadRef;
          const text = [
            `# ${name}`,
            "Use the Transcripts skill to open the project transcript and answer about this time range.",
            `Transcript: ${path}`,
            `Revision: ${revision}`,
            `Source time: ${span}`,
          ].join("\n\n");
          const file = new File([text], `${name.slice(0, 160)}.transcript.md`, {
            type: "text/markdown",
          });
          drafts.addFiles(target, [
            {
              id: randomUUID(),
              type: "file",
              file,
              name: file.name,
              sizeBytes: file.size,
              mimeType: file.type,
              source: {
                _tag: "recording-transcript",
                name: name.slice(0, 255),
                revision,
                path,
                ...range,
              },
            },
          ]);
          onRevealComposer();
          await linkRecordingThread(project, revision, threadRef.threadId, range);
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
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={!segments.length || pending}
        onClick={() => void ask()}
      >
        {gt("Ask in chat")}
      </Button>
      {error && (
        <span className="text-xs text-muted-foreground" role="status">
          {gt("Could not prepare recording context.")}
        </span>
      )}
    </div>
  );
}
