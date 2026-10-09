import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ProjectReadFileResult } from "@t3tools/contracts";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import {
  markdownPersistenceRegistry,
  type MarkdownPersistenceLease,
  type MarkdownPersistenceTarget,
} from "./markdownPersistenceRegistry";

const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

export function useMarkdownPersistenceLease(input: {
  readonly target: MarkdownPersistenceTarget | null;
  readonly authoritativeSnapshot: ProjectReadFileResult | null;
  readonly workspaceMutationId?: string | null;
}) {
  const key = input.target === null ? null : projectFileOperationKey(input.target);
  const available =
    input.target !== null &&
    (markdownPersistenceRegistry.has(input.target) ||
      (input.authoritativeSnapshot !== null &&
        !input.authoritativeSnapshot.truncated &&
        !input.authoritativeSnapshot.readOnly));
  const [binding, setBinding] = useState<{
    readonly key: string | null;
    readonly attempt: number;
    readonly lease: MarkdownPersistenceLease | null;
    readonly error: unknown | null;
  } | null>(null);
  const [admissionAttempt, setAdmissionAttempt] = useState(0);
  const retryAdmission = useCallback(() => setAdmissionAttempt((attempt) => attempt + 1), []);
  // Every lease this view takes carries this owner, so an in-place rename can
  // tell that no other view holds the document.
  const [owner] = useState(() => ({}));
  const open = useEffectEvent(() =>
    input.target === null ? null : markdownPersistenceRegistry.open(input.target, owner),
  );
  // The bound document moved to a new path in place. The view follows it with
  // the same lease: no reopening, and no render without a lease in between.
  const [followed, setFollowed] = useState<{
    readonly lease: MarkdownPersistenceLease;
    readonly fromKey: string;
    readonly toKey: string;
  } | null>(null);
  const handoff = useRef<typeof followed>(null);
  const boundLease = useRef<MarkdownPersistenceLease | null>(null);
  useEffect(
    () =>
      markdownPersistenceRegistry.onMoved((move) => {
        const lease = boundLease.current;
        if (lease === null || lease.documentId !== move.documentId) return;
        const next = {
          lease,
          fromKey: projectFileOperationKey(move.from),
          toKey: projectFileOperationKey(move.to),
        };
        handoff.current = next;
        setFollowed(next);
      }),
    [],
  );
  useEffect(() => {
    // Admission happens only after commit. Abandoned renders never own timers,
    // watchers, cache projections, or a pending draft.
    let cancelled = false;
    let retained: MarkdownPersistenceLease | null = null;
    const moved = handoff.current;
    if (moved !== null && moved.toKey === key) {
      // Taken over from the previous path's binding, not reopened. A path
      // change is an update, so StrictMode does not replay this effect.
      handoff.current = null;
      const lease = moved.lease;
      boundLease.current = lease;
      setBinding({ key, attempt: admissionAttempt, lease, error: null });
      return () => {
        if (handoff.current?.lease === lease) return;
        if (boundLease.current === lease) boundLease.current = null;
        lease.release();
      };
    }
    setBinding({ key, attempt: admissionAttempt, lease: null, error: null });
    if (available) {
      void open()?.then(
        (lease) => {
          if (cancelled) lease.release();
          else {
            retained = lease;
            boundLease.current = lease;
            setBinding({ key, attempt: admissionAttempt, lease, error: null });
          }
        },
        (error: unknown) => {
          if (!cancelled) setBinding({ key, attempt: admissionAttempt, lease: null, error });
        },
      );
    }
    return () => {
      cancelled = true;
      // Handed to the binding for the document's new path, not released.
      if (retained !== null && handoff.current?.lease === retained) return;
      if (boundLease.current === retained) boundLease.current = null;
      retained?.release();
    };
  }, [key, available, admissionAttempt]);
  const currentBinding =
    binding !== null &&
    binding.attempt === admissionAttempt &&
    (binding.key === key ||
      // The document just moved here; its binding catches up after commit.
      (followed !== null &&
        followed.toKey === key &&
        followed.fromKey === binding.key &&
        followed.lease === binding.lease))
      ? binding
      : null;
  const lease = currentBinding?.lease ?? null;
  useEffect(() => {
    if (input.workspaceMutationId !== null && input.workspaceMutationId !== undefined) {
      lease?.noteFreshnessHint("workspace-mutation");
    }
  }, [lease, input.workspaceMutationId]);
  const snapshot = useSyncExternalStore(
    lease?.subscribe ?? emptySubscribe,
    lease?.getSnapshot ?? emptySnapshot,
    lease?.getSnapshot ?? emptySnapshot,
  );
  return {
    lease,
    snapshot,
    admissionError: currentBinding?.error ?? null,
    retryAdmission,
  };
}

export function useMarkdownPersistenceRegistrySnapshot() {
  return useSyncExternalStore(
    markdownPersistenceRegistry.subscribe,
    markdownPersistenceRegistry.getSnapshot,
    markdownPersistenceRegistry.getSnapshot,
  );
}
