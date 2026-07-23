// FILE: useGitProgressToastPreview.ts
// Purpose: Cycle representative Git states through Activity during local styling work.
// Layer: UI helpers
// Exports: useGitProgressToastPreview

import { useEffect, useRef } from "react";

import type { ActivityStatus, ActivityTone } from "../notifications/activityStore";
import { activityManager } from "../notifications/activityStore";

interface PreviewStage {
  status: ActivityStatus;
  tone: ActivityTone;
  title: string;
  description?: string;
}

const PREVIEW_STAGES: PreviewStage[] = [
  { status: "in_progress", tone: "info", title: "Generating commit message..." },
  { status: "in_progress", tone: "info", title: "Pushing..." },
  { status: "recent", tone: "success", title: "Committed to codex/redesign" },
  { status: "recent", tone: "success", title: "Pushed 3a1f2c to main" },
  {
    status: "needs_attention",
    tone: "warning",
    title: "Awaiting input",
    description: "Refactor DB layer needs confirmation.",
  },
  {
    status: "needs_attention",
    tone: "error",
    title: "Git action failed",
    description: "Unable to access the upstream remote.",
  },
  {
    status: "recent",
    tone: "info",
    title: "Already up to date",
    description: "main is already synchronized.",
  },
  {
    status: "needs_attention",
    tone: "warning",
    title: "Branch is behind upstream",
  },
];

const STAGE_DURATION_MS = 3_000;
const PREVIEW_ACTIVITY_KEY = "debug:git-progress-preview";

export function useGitProgressToastPreview(enabled: boolean): void {
  const stageIndexRef = useRef(0);
  const stageStartedAtMsRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      activityManager.remove(PREVIEW_ACTIVITY_KEY);
      stageIndexRef.current = 0;
      stageStartedAtMsRef.current = null;
      return;
    }

    const applyStage = (stage: PreviewStage) => {
      activityManager.publish({
        dedupeKey: PREVIEW_ACTIVITY_KEY,
        source: "system",
        status: stage.status,
        tone: stage.tone,
        title: stage.title,
        description: stage.description,
      });
    };

    stageStartedAtMsRef.current = Date.now();
    stageIndexRef.current = 0;
    applyStage(PREVIEW_STAGES[0]!);

    const intervalId = window.setInterval(() => {
      const stageStartedAtMs = stageStartedAtMsRef.current;
      if (stageStartedAtMs === null || Date.now() - stageStartedAtMs < STAGE_DURATION_MS) return;

      stageIndexRef.current = (stageIndexRef.current + 1) % PREVIEW_STAGES.length;
      stageStartedAtMsRef.current = Date.now();
      applyStage(PREVIEW_STAGES[stageIndexRef.current]!);
    }, 500);

    return () => {
      window.clearInterval(intervalId);
      activityManager.remove(PREVIEW_ACTIVITY_KEY);
      stageIndexRef.current = 0;
      stageStartedAtMsRef.current = null;
    };
  }, [enabled]);
}
