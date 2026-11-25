import type {
  EnvironmentId,
  ScientLiteratureWatchChange,
  ScientLiteratureWatchChangeResult,
  ScientLiteratureWatchesResult,
  ScientLiteratureWatchResult,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { toastManager } from "../../components/ui/toast";
import { changeLiteratureWatch, readLiteratureWatch, readLiteratureWatches } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";
import { useCanChangeLibrary } from "./sourcesCommands";

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

  const reload = (watchId: string) =>
    readLiteratureWatch(input.environmentId, { root: input.root, watchId }).then(
      (next) => {
        setWatch(next.watch);
        setError(null);
      },
      (cause: unknown) => setError(message(cause)),
    );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the open watch from the environment server when it opens
  useEffect(() => {
    if (!input.watchId) return;
    let current = true;
    void readLiteratureWatch(input.environmentId, {
      root: input.root,
      watchId: input.watchId,
    }).then(
      (next) => {
        if (current) setWatch(next.watch);
      },
      (cause: unknown) => {
        if (current) setError(message(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [input.environmentId, input.root, input.watchId]);

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
