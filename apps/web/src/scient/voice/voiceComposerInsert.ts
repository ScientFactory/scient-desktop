export interface VoiceDraftReplacement {
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly replacement: string;
}

function composeDraft(base: string, addition: string): string {
  const trimmedBase = base.replace(/\s+$/u, "");
  const trimmedAddition = addition.trim();
  if (trimmedAddition.length === 0) return base;
  return trimmedBase.length > 0 ? `${trimmedBase}\n${trimmedAddition}` : trimmedAddition;
}

export function buildVoiceDraftReplacement(
  currentDraft: string,
  transcript: string,
): VoiceDraftReplacement {
  return {
    rangeStart: 0,
    rangeEnd: currentDraft.length,
    replacement: composeDraft(currentDraft, transcript),
  };
}

export function applyVoiceTranscript(
  currentDraft: string,
  transcript: string,
  replaceDraft: (rangeStart: number, rangeEnd: number, replacement: string) => boolean,
): boolean {
  const { rangeStart, rangeEnd, replacement } = buildVoiceDraftReplacement(
    currentDraft,
    transcript,
  );
  return replaceDraft(rangeStart, rangeEnd, replacement);
}
