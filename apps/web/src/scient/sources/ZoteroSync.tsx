import type {
  EnvironmentId,
  ScientSourceZoteroRefreshField,
  ScientSourceZoteroRefreshResult,
  ZoteroConnection,
  ZoteroGroup,
} from "@t3tools/contracts";
import { LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";

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
import { toastManager } from "../../components/ui/toast";
import { readZoteroStatus, refreshZoteroSources, sendSourcesToZotero } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";
import { settleAfter } from "./settleAfter";

const FIELD_LABELS: Readonly<Record<ScientSourceZoteroRefreshField, string>> = {
  type: "Type",
  customType: "Type",
  title: "Title",
  creators: "Creators",
  issuedRaw: "Date",
  issuedYear: "Year",
  identifiers: "Identifiers",
  abstract: "Abstract",
  containerTitle: "Journal or publication",
  publisher: "Publisher",
  volume: "Volume",
  issue: "Issue",
  pages: "Pages",
  language: "Language",
  url: "URL",
  tags: "Tags",
  note: "Note",
};

type RefreshState =
  | { readonly phase: "running" }
  | { readonly phase: "problem"; readonly message: string }
  | {
      readonly phase: "done";
      readonly connection: ZoteroConnection;
      readonly result: ScientSourceZoteroRefreshResult;
    };

const errorText = (cause: unknown) => scientSourcesErrorMessage(cause, import.meta.env.DEV);

/** Refresh from Zotero and Send to Zotero for one project's Library. */
export function useZoteroSync(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly onChanged: () => Promise<void> | void;
}) {
  const [refresh, setRefresh] = useState<RefreshState | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [writableGroups, setWritableGroups] = useState<ReadonlyArray<ZoteroGroup>>([]);
  const groupsRequested = useRef(false);
  // A refresh still running when the dialog closes must not reopen it.
  const run = useRef(0);

  /** Once per panel: the zotero.org groups the key can write to, for Send to Zotero. */
  const loadWritableGroups = () => {
    if (groupsRequested.current) return;
    groupsRequested.current = true;
    void readZoteroStatus(input.environmentId, "web")
      .then((status) =>
        setWritableGroups(
          status.state === "ready" ? (status.groups ?? []).filter((group) => group.canWrite) : [],
        ),
      )
      .catch(() => {
        groupsRequested.current = false;
      });
  };

  const startRefresh = async () => {
    const current = ++run.current;
    const show = (state: RefreshState) => {
      if (run.current === current) setRefresh(state);
    };
    show({ phase: "running" });
    try {
      const status = await readZoteroStatus(input.environmentId);
      if (status.state !== "ready") {
        show({ phase: "problem", message: status.message });
        return;
      }
      const connection = status.connection ?? "local";
      const result = await refreshZoteroSources(input.environmentId, {
        root: input.root,
        connection,
      });
      show({ phase: "done", connection, result });
      if (result.items.some((item) => item.outcome === "updated")) await input.onChanged();
    } catch (cause) {
      show({ phase: "problem", message: errorText(cause) });
    }
  };

  const resolveConflict = async (
    sourceId: string,
    field: ScientSourceZoteroRefreshField,
    side: "zotero" | "local",
  ) => {
    if (refresh?.phase !== "done") return;
    setResolving(`${sourceId}\0${field}`);
    await settleAfter(
      async () => {
        try {
          const result = await refreshZoteroSources(input.environmentId, {
            root: input.root,
            sourceIds: [sourceId],
            connection: refresh.connection,
            ...(side === "zotero" ? { useZotero: [field] } : { keepLocal: [field] }),
          });
          const next = result.items[0];
          setRefresh((current) =>
            current?.phase === "done" && next
              ? {
                  ...current,
                  result: {
                    ...current.result,
                    items: current.result.items.map((item) =>
                      item.sourceId === sourceId ? next : item,
                    ),
                  },
                }
              : current,
          );
          if (side === "zotero") await input.onChanged();
        } catch (cause) {
          toastManager.add({
            type: "error",
            title: "Zotero could not be read",
            description: errorText(cause),
          });
        }
      },
      () => setResolving(null),
    );
  };

  const sendToZotero = async (sourceId: string, groupId: string | null = null) => {
    try {
      const status = await readZoteroStatus(input.environmentId, "web");
      const group = groupId ? status.groups?.find((entry) => entry.groupId === groupId) : null;
      const canWrite = groupId ? group?.canWrite === true : status.canWrite === true;
      if (status.state !== "ready" || !canWrite) {
        toastManager.add({
          type: "warning",
          title: "Not sent to Zotero",
          description:
            status.state !== "ready"
              ? status.message
              : groupId
                ? "The Zotero key in Accounts cannot write to this group."
                : "The Zotero key in Accounts can only read. Save a zotero.org key that can write.",
        });
        return;
      }
      const [item] = (
        await sendSourcesToZotero(input.environmentId, {
          root: input.root,
          sourceIds: [sourceId],
          ...(groupId ? { groupId } : {}),
        })
      ).items;
      if (item?.outcome === "created" || item?.outcome === "updated") await input.onChanged();
      toastManager.add({
        type:
          item?.outcome === "created" ||
          item?.outcome === "updated" ||
          item?.outcome === "unchanged"
            ? "success"
            : "warning",
        title:
          item?.outcome === "created"
            ? "Added to Zotero"
            : item?.outcome === "updated"
              ? "Updated in Zotero"
              : item?.outcome === "unchanged"
                ? "Zotero already has this source"
                : "Not sent to Zotero",
        description: item?.message ?? undefined,
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Not sent to Zotero",
        description: errorText(cause),
      });
    }
  };

  return {
    refresh,
    resolving,
    startRefresh,
    resolveConflict,
    closeRefresh: () => {
      run.current += 1;
      setRefresh(null);
    },
    sendToZotero,
    writableGroups,
    loadWritableGroups,
  };
}

function refreshSummary(result: ScientSourceZoteroRefreshResult): string {
  const updated = result.items.filter((item) => item.outcome === "updated").length;
  if (result.items.length === 0) return "No sources here came from Zotero.";
  if (updated === 0) return "Everything matches Zotero.";
  return updated === 1
    ? "Updated 1 source from Zotero."
    : `Updated ${updated} sources from Zotero.`;
}

export function ZoteroRefreshDialog(props: {
  readonly state: RefreshState | null;
  readonly resolving: string | null;
  readonly onClose: () => void;
  readonly onResolve: (
    sourceId: string,
    field: ScientSourceZoteroRefreshField,
    side: "zotero" | "local",
  ) => void;
}) {
  const state = props.state;
  const done = state?.phase === "done" ? state.result : null;
  const conflicts = (done?.items ?? []).flatMap((item) =>
    item.conflicts.map((conflict) => ({ item, conflict })),
  );
  const problems = (done?.items ?? []).filter(
    (item) => item.outcome === "missing" || item.outcome === "failed" || item.outcome === "stale",
  );
  return (
    <Dialog open={state !== null} onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="w-[min(520px,calc(100vw-32px))]">
        <DialogHeader>
          <DialogTitle>Refresh from Zotero</DialogTitle>
          <DialogDescription>
            {state?.phase === "running"
              ? "Reading your Zotero library…"
              : state?.phase === "problem"
                ? state.message
                : done
                  ? refreshSummary(done)
                  : null}
          </DialogDescription>
        </DialogHeader>
        {conflicts.length > 0 || problems.length > 0 ? (
          <DialogPanel>
            <div className="grid gap-4 text-sm">
              {conflicts.length > 0 ? (
                <div className="grid gap-3">
                  <p className="text-muted-foreground">
                    Changed both here and in Zotero. Your version was kept.
                  </p>
                  {conflicts.map(({ item, conflict }) => {
                    const key = `${item.sourceId}\0${conflict.field}`;
                    return (
                      <div key={key} className="grid gap-1 border-t border-border pt-3">
                        <div className="truncate font-medium">
                          {item.title ?? "Untitled source"} · {FIELD_LABELS[conflict.field]}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          <div className="line-clamp-2">Here: {conflict.local || "empty"}</div>
                          <div className="line-clamp-2">
                            In Zotero: {conflict.zotero || "empty"}
                          </div>
                        </div>
                        <div className="mt-1 flex gap-1">
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={props.resolving !== null}
                            onClick={() => props.onResolve(item.sourceId, conflict.field, "local")}
                          >
                            Keep mine
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={props.resolving !== null}
                            onClick={() => props.onResolve(item.sourceId, conflict.field, "zotero")}
                          >
                            {props.resolving === key ? (
                              <LoaderCircle className="animate-spin" />
                            ) : null}
                            Use Zotero's
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {problems.length > 0 ? (
                <div className="grid gap-1">
                  {problems.map((item) => (
                    <div key={item.sourceId} className="flex min-w-0 gap-2 text-xs">
                      <span className="min-w-0 truncate">{item.title ?? "Untitled source"}</span>
                      <span className="shrink-0 text-muted-foreground">{item.message}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            {state?.phase === "running" ? "Close" : "Done"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
