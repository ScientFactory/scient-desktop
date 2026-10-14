import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadSection,
  ThreadSectionProjectRef,
} from "@t3tools/contracts";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { readThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useThreadSectionActions } from "./actions";
import { useThreadSectionCatalogs } from "./catalog";
import type { SectionOrigin, SectionRef } from "./logic";
import { NewSectionPopover, type SectionCreateAnchor } from "./NewSectionPopover";
import { readSidebarSectionScope } from "./sidebarScope";

/**
 * What a section created on `environmentId` for `threadRefs` (all on that
 * environment) records: the environment once it holds threads, and as the
 * projects it was created for, their projects plus the sidebar's selected
 * project (`scopeProjectRefs`, null under All projects) on that environment.
 */
function sectionOriginForThreads(
  environmentId: EnvironmentId,
  threadRefs: readonly ScopedThreadRef[],
  scopeProjectRefs: readonly ThreadSectionProjectRef[] | null,
): SectionOrigin {
  const threadProjects = threadRefs.flatMap((ref) => {
    const projectId = readThreadShell(ref)?.projectId ?? null;
    return projectId === null ? [] : [{ environmentId: ref.environmentId, projectId }];
  });
  return {
    environmentIds: threadRefs.length > 0 ? [environmentId] : [],
    createdInProjects: [
      ...(scopeProjectRefs ?? []).filter((ref) => ref.environmentId === environmentId),
      ...threadProjects,
    ],
  };
}

/** The sections one creation made, and the environments where it failed. */
export interface CreatedSections {
  readonly created: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly section: ThreadSection;
  }>;
  readonly failedEnvironmentIds: readonly EnvironmentId[];
}

/**
 * Creates a section and files `threadRefs` into it: the one step behind the
 * shared creation popover. A section belongs to one environment, so threads
 * from several environments get a section of that name on each of theirs; a
 * section with no threads is created on `environmentId`. Nothing is filed on
 * an environment whose section could not be created. Filing reports its own
 * failures and offers Undo.
 */
export async function createSectionAndFile(input: {
  readonly name: string;
  readonly threadRefs: readonly ScopedThreadRef[];
  readonly scopeProjectRefs: readonly ThreadSectionProjectRef[] | null;
  /** Where a section without threads is created; null when there is nowhere. */
  readonly environmentId: EnvironmentId | null;
  readonly create: (
    environmentId: EnvironmentId,
    name: string,
    origin: SectionOrigin,
  ) => Promise<ThreadSection | null>;
  readonly moveThreadsToSection: (
    threadRefs: readonly ScopedThreadRef[],
    section: SectionRef,
  ) => Promise<boolean>;
}): Promise<CreatedSections> {
  const byEnvironment = new Map<EnvironmentId, ScopedThreadRef[]>();
  for (const ref of input.threadRefs) {
    const refs = byEnvironment.get(ref.environmentId) ?? [];
    refs.push(ref);
    byEnvironment.set(ref.environmentId, refs);
  }
  if (byEnvironment.size === 0 && input.environmentId !== null) {
    byEnvironment.set(input.environmentId, []);
  }
  const results = await Promise.all(
    [...byEnvironment].map(async ([environmentId, threadRefs]) => {
      const section = await input.create(
        environmentId,
        input.name,
        sectionOriginForThreads(environmentId, threadRefs, input.scopeProjectRefs),
      );
      if (section !== null && threadRefs.length > 0) {
        await input.moveThreadsToSection(threadRefs, { environmentId, sectionId: section.id });
      }
      return { environmentId, section };
    }),
  );
  return {
    created: results.flatMap(({ environmentId, section }) =>
      section === null ? [] : [{ environmentId, section }],
    ),
    failedEnvironmentIds: results.flatMap(({ environmentId, section }) =>
      section === null ? [environmentId] : [],
    ),
  };
}

/**
 * Where a section without threads goes by default: the environment of the
 * sidebar's selected project when it has one, else the first catalog (the
 * primary environment's, when it stores sections).
 */
function defaultSectionEnvironment(
  candidates: readonly EnvironmentId[],
  scopeProjectRefs: readonly ThreadSectionProjectRef[] | null,
): EnvironmentId | null {
  const scoped = new Set((scopeProjectRefs ?? []).map((ref) => ref.environmentId));
  if (scoped.size === 1) {
    const [only] = scoped;
    const match = candidates.find((environmentId) => environmentId === only);
    if (match !== undefined) return match;
  }
  return candidates[0] ?? null;
}

/**
 * "New section…" from a thread menu or the sidebar: asks for a name, creates
 * the section (or reuses one with that name) and files the threads into it in
 * one step. A section started empty asks which environment holds it when
 * several can.
 */
export function useNewSectionForThreads(
  options: {
    readonly onCreated?: (section: SectionRef) => void;
  } = {},
): {
  readonly request: (threadRefs: readonly ScopedThreadRef[], anchor: SectionCreateAnchor) => void;
  readonly popover: ReactNode;
  readonly close: () => void;
} {
  const { catalogs, create } = useThreadSectionCatalogs();
  const { moveThreadsToSection } = useThreadSectionActions();
  const { environments } = useEnvironments();
  // Keep the origin through dismissal so positioning and return focus can finish.
  const [pending, setPending] = useState<{
    readonly open: boolean;
    readonly threadRefs: readonly ScopedThreadRef[];
    readonly anchor: SectionCreateAnchor;
    readonly environmentId: EnvironmentId | null;
  } | null>(null);
  const [requestKey, setRequestKey] = useState(0);

  const candidates = useMemo(() => catalogs.map((catalog) => catalog.environmentId), [catalogs]);
  const environmentChoices = useMemo(
    () =>
      candidates.map((environmentId) => ({
        environmentId,
        label:
          environments.find((environment) => environment.environmentId === environmentId)?.label ??
          environmentId,
      })),
    [candidates, environments],
  );

  const request = useCallback(
    (threadRefs: readonly ScopedThreadRef[], anchor: SectionCreateAnchor) => {
      setRequestKey((key) => key + 1);
      setPending({
        open: true,
        threadRefs,
        anchor,
        environmentId:
          threadRefs.length > 0
            ? null
            : defaultSectionEnvironment(candidates, readSidebarSectionScope()),
      });
    },
    [candidates],
  );

  const submit = useCallback(
    async (name: string) => {
      const threadRefs = pending?.threadRefs ?? [];
      const result = await createSectionAndFile({
        name,
        threadRefs,
        scopeProjectRefs: readSidebarSectionScope(),
        environmentId: pending?.environmentId ?? null,
        create,
        moveThreadsToSection,
      });
      for (const { environmentId, section } of result.created) {
        options.onCreated?.({ environmentId, sectionId: section.id });
      }
      if (result.created.length > 0 && result.failedEnvironmentIds.length > 0) {
        const labels = result.failedEnvironmentIds.map(
          (environmentId) =>
            environmentChoices.find((choice) => choice.environmentId === environmentId)?.label ??
            environmentId,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Section not created everywhere",
            description: `Could not create it on ${labels.join(", ")}. Those threads were not moved.`,
          }),
        );
      }
      return result.created.length > 0;
    },
    [create, environmentChoices, moveThreadsToSection, options.onCreated, pending],
  );

  const pickEnvironment =
    pending !== null && pending.threadRefs.length === 0 && environmentChoices.length > 1;

  return {
    request,
    close: () => setPending((current) => (current ? { ...current, open: false } : current)),
    popover: (
      <NewSectionPopover
        open={pending?.open ?? false}
        requestKey={requestKey}
        threadCount={pending?.threadRefs.length ?? 0}
        anchor={pending?.anchor ?? null}
        environmentPicker={
          pickEnvironment
            ? {
                choices: environmentChoices,
                value: pending.environmentId,
                onChange: (environmentId) =>
                  setPending((current) => (current ? { ...current, environmentId } : current)),
              }
            : null
        }
        onOpenChange={(open) => {
          if (!open)
            setPending((current) =>
              current && current === pending ? { ...current, open: false } : current,
            );
        }}
        onSubmit={submit}
      />
    ),
  };
}
