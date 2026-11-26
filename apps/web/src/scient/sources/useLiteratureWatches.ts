import type {
  EnvironmentId,
  ScientLiteratureWatchChange,
  ScientLiteratureWatchChangeResult,
  ScientLiteratureWatchesResult,
  ScientLiteratureWatchResult,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { toastManager } from "../../components/ui/toast";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { useStableCallback } from "../../hooks/useStableCallback";
import { changeLiteratureWatch, readLiteratureWatch, readLiteratureWatches } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";
import { useCanChangeLibrary } from "./sourcesCommands";

const RUNNING_POLL_MS = 5_000;

const message = (error: unknown) => scientSourcesErrorMessage(error, import.meta.env.DEV);

/** The Library's watches, for the header's unread count and the Watches view. */
export function useLiteratureWatchList(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
}) {
  const [list, setList] = useState<ScientLiteratureWatchesResult | null>(null);
  const reload = () =>
    readLiteratureWatches(input.environmentId, { root: input.root }).then(
      (next) => setList(next),
      () => undefined,
    );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Library's watches from the environment server when the panel opens
  useEffect(() => {
    let current = true;
    void readLiteratureWatches(input.environmentId, { root: input.root }).then(
      (next) => {
        if (current) setList(next);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [input.environmentId, input.root]);
  return { list, reload };
}

export type LiteratureWatchList = ReturnType<typeof useLiteratureWatchList>;
type Watch = ScientLiteratureWatchResult["watch"];

export function useLiteratureWatch(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly watchId: string | null;
  readonly onListChanged: () => void;
}) {
  const [watch, setWatch] = useState<Watch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const canChange = useCanChangeLibrary(input.environmentId);
  // Only the newest read of the watch on screen may land; an older one, or another watch's, is
  // dropped. A poll waits for the read before it rather than overtaking it.
  const latest = useRef(0);
  const shown = useRef<string | null>(null);
  const reading = useRef(false);

  const reload = useStableCallback(async (watchId: string) => {
    // A late call for a watch no longer on screen must not cancel the read of the one that is.
    if (shown.current !== watchId) return;
    const request = ++latest.current;
    reading.current = true;
    const landed = () => request === latest.current && shown.current === watchId;
    return readLiteratureWatch(input.environmentId, { root: input.root, watchId })
      .then(
        (next) => {
          if (!landed()) return;
          setWatch(next.watch);
          setError(null);
        },
        (cause: unknown) => {
          if (landed()) setError(message(cause));
        },
      )
      .finally(() => {
        if (request === latest.current) reading.current = false;
      });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the open watch from the environment server when it opens
  useEffect(() => {
    shown.current = input.watchId;
    if (input.watchId) void reload(input.watchId);
    else latest.current += 1;
  }, [input.watchId, reload]);
  // A run started elsewhere, such as on schedule, shows when the view is next looked at.
  useLiveRefresh(
    () => {
      if (input.watchId) void reload(input.watchId);
    },
    { key: `scient-literature-watch:${input.environmentId}:${input.root}:${input.watchId}` },
  );

  const onListChanged = useStableCallback(input.onListChanged);
  const running = input.watchId !== null && watch?.watchId === input.watchId && watch.running;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows a run on the environment server until it publishes
  useEffect(() => {
    if (!running || !input.watchId) return;
    const watchId = input.watchId;
    const timer = setInterval(() => {
      if (!reading.current) void reload(watchId).then(onListChanged);
    }, RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [running, input.watchId, reload, onListChanged]);

  /** Applies a change, then reads the watch and the list again. `key` marks what is busy. */
  const change = async (
    key: string,
    action: ScientLiteratureWatchChange,
    failureTitle: string,
  ): Promise<ScientLiteratureWatchChangeResult | null> => {
    if (!input.watchId) return null;
    const watchId = input.watchId;
    setPending(key);
    const result = await changeLiteratureWatch(input.environmentId, {
      root: input.root,
      watchId,
      change: action,
    }).catch((cause: unknown) => {
      toastManager.add({ type: "error", title: failureTitle, description: message(cause) });
      return null;
    });
    setPending(null);
    if (action.action !== "delete") await reload(watchId);
    input.onListChanged();
    return result;
  };

  return {
    watch: input.watchId && watch?.watchId === input.watchId ? watch : null,
    error,
    pending,
    canChange,
    change,
  };
}
