import type { ScientSystematicReviewAction } from "@scientfactory/scient-sources";
import type {
  EnvironmentId,
  ScientSystematicReviewChangeResult,
  ScientSystematicReviewList,
  ScientSystematicReviewResult,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { toastManager } from "../../components/ui/toast";
import { changeSystematicReview, readSystematicReview, readSystematicReviews } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";
import { useCanChangeLibrary } from "./sourcesCommands";

const message = (error: unknown) => scientSourcesErrorMessage(error, import.meta.env.DEV);

// Outside the hook: the React Compiler does not compile try/finally.
async function settle<A>(work: () => Promise<A>, settled: () => void): Promise<A> {
  try {
    return await work();
  } finally {
    settled();
  }
}

/** What was open, so opening a source from a review and coming back returns to the same place. */
const lastPlace = new Map<
  string,
  { readonly reviewId: string | null; readonly tab: string; readonly stage: string }
>();

export function readLastReviewPlace(context: string) {
  return lastPlace.get(context) ?? { reviewId: null, tab: "records", stage: "title-abstract" };
}

export function rememberReviewPlace(
  context: string,
  place: Partial<{ reviewId: string | null; tab: string; stage: string }>,
) {
  lastPlace.set(context, { ...readLastReviewPlace(context), ...place });
}

export function useSystematicReviews(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
}) {
  const context = `${input.environmentId}\0${input.root}`;
  const [list, setList] = useState<ScientSystematicReviewList | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(
    () => readLastReviewPlace(context).reviewId,
  );
  const [result, setResult] = useState<ScientSystematicReviewResult | null>(null);
  const detail = result?.detail ?? null;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const canChange = useCanChangeLibrary(input.environmentId);

  const reloadList = () =>
    readSystematicReviews(input.environmentId, { root: input.root })
      .then((next) => {
        setList(next);
        setError(null);
      })
      .catch((cause: unknown) => setError(message(cause)));
  const reloadDetail = (id: string) =>
    readSystematicReview(input.environmentId, { root: input.root, reviewId: id })
      .then((next) => setResult(next))
      .catch((cause: unknown) => setError(message(cause)));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the project's reviews, and the one left open, from the environment server when the view opens
  useEffect(() => {
    let current = true;
    const openId = readLastReviewPlace(context).reviewId;
    void readSystematicReviews(input.environmentId, { root: input.root })
      .then((next) => {
        if (current) setList(next);
      })
      .catch((cause: unknown) => {
        if (current) setError(message(cause));
      });
    if (openId) {
      void readSystematicReview(input.environmentId, { root: input.root, reviewId: openId })
        .then((next) => {
          if (current) setResult(next);
        })
        .catch(() => undefined);
    }
    return () => {
      current = false;
    };
  }, [context, input.environmentId, input.root]);

  const change = async (
    action: ScientSystematicReviewAction,
    failureTitle: string,
  ): Promise<ScientSystematicReviewChangeResult | null> => {
    setPending(true);
    return settle(
      async () => {
        const result = await changeSystematicReview(input.environmentId, {
          root: input.root,
          change: action,
        }).catch((cause: unknown) => {
          toastManager.add({ type: "error", title: failureTitle, description: message(cause) });
          return null;
        });
        if (result?.message) {
          toastManager.add({ type: "warning", title: failureTitle, description: result.message });
        }
        const id = result?.reviewId ?? reviewId;
        await Promise.all([reloadList(), id && id === reviewId ? reloadDetail(id) : null]);
        return result;
      },
      () => setPending(false),
    );
  };

  return {
    list,
    error,
    pending,
    /** Changes are off while one is saving or when this connection cannot change the Library. */
    disabled: pending || !canChange,
    reviewId,
    detail: detail && detail.review.reviewId === reviewId ? detail : null,
    /** A library server's review records under the review's own IDs, with their labels. */
    records: detail && detail.review.reviewId === reviewId ? (result?.records ?? null) : null,
    open: (id: string | null) => {
      rememberReviewPlace(context, { reviewId: id });
      setReviewId(id);
      setResult(null);
      if (id) void reloadDetail(id);
    },
    change,
  };
}

export type SystematicReviews = ReturnType<typeof useSystematicReviews>;
