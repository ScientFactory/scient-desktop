import { msg, T, useGT, useMessages } from "gt-react";

import type { MessageResolver } from "~/i18n/messages";
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
import {
  NOT_BROUGHT_LABELS,
  notBroughtAmount,
  notBroughtBySource,
  notBroughtName,
} from "./notBroughtLabels";
import { settleAfter } from "./settleAfter";

const FIELD_LABELS: Readonly<Record<ScientSourceZoteroRefreshField, string>> = {
  type: msg("Type", { $context: "a source field" }),
  customType: msg("Type", { $context: "a source field" }),
  title: msg("Title", { $context: "a source field" }),
  creators: msg("Creators", { $context: "a source field" }),
  issuedRaw: msg("Date", { $context: "a source field" }),
  issuedYear: msg("Year", { $context: "a source field" }),
  identifiers: msg("Identifiers", { $context: "a source field" }),
  abstract: msg("Abstract", { $context: "a source field" }),
  containerTitle: msg("Journal or publication", { $context: "a source field" }),
  more: msg("More details", { $context: "a source field" }),
  publisher: msg("Publisher", { $context: "a source field" }),
  volume: msg("Volume", { $context: "a source field" }),
  issue: msg("Issue", { $context: "a source field" }),
  pages: msg("Pages", { $context: "a source field" }),
  language: msg("Language", { $context: "a source field" }),
  url: "URL",
  tags: msg("Tags", { $context: "a source field" }),
  note: msg("Note", { $context: "a source field" }),
};

type RefreshState =
  | { readonly phase: "running"; readonly checked?: number; readonly total?: number }
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
  /** The panel shows the whole Library, not one project's sources. */
  readonly allLibrary: boolean;
  readonly onChanged: () => Promise<void> | void;
}) {
  const gt = useGT();
  const [refresh, setRefresh] = useState<RefreshState | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [writableGroups, setWritableGroups] = useState<ReadonlyArray<ZoteroGroup>>([]);
  // "With PDF" in the Send menu: off when the panel opens, then as the person left it.
  const [sendPdfs, setSendPdfs] = useState(false);
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
      // A large Library is read again in batches, so the dialog can say how far it is.
      const items: ScientSourceZoteroRefreshResult["items"][number][] = [];
      for (let after: string | null | undefined = null; after !== undefined;) {
        const batch = await refreshZoteroSources(input.environmentId, {
          root: input.root,
          connection,
          after,
          ...(input.allLibrary ? { allLibrary: true } : {}),
        });
        items.push(...batch.items);
        // Closed meanwhile: what was read stays, and nothing more is asked.
        if (run.current !== current) break;
        after = batch.next;
        if (after !== undefined) {
          show({
            phase: "running",
            checked: items.length,
            ...(batch.total === undefined ? {} : { total: batch.total }),
          });
        }
      }
      show({ phase: "done", connection, result: { connection, items } });
      if (items.some((item) => item.outcome === "updated")) await input.onChanged();
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
            title: gt("Zotero could not be read"),
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
          title: gt("Not sent to Zotero"),
          description:
            status.state !== "ready"
              ? status.message
              : groupId
                ? gt("The Zotero key in Accounts cannot write to this group.")
                : gt(
                    "The Zotero key in Accounts can only read. Save a zotero.org key that can write.",
                  ),
        });
        return;
      }
      const [item] = (
        await sendSourcesToZotero(input.environmentId, {
          root: input.root,
          sourceIds: [sourceId],
          ...(groupId ? { groupId } : {}),
          ...(sendPdfs ? { pdfs: true } : {}),
        })
      ).items;
      if (item?.outcome === "created" || item?.outcome === "updated") await input.onChanged();
      const pdfLines = (item?.pdfs ?? []).map((pdf) =>
        pdf.outcome === "sent"
          ? `“${pdf.fileName}” was added.`
          : pdf.outcome === "in-zotero"
            ? `Zotero already has “${pdf.fileName}”.`
            : [`“${pdf.fileName}” was not sent.`, pdf.message ?? ""].join(" ").trim(),
      );
      const description = [item?.message ?? "", ...pdfLines].join(" ").trim();
      toastManager.add({
        type:
          (item?.outcome === "created" ||
            item?.outcome === "updated" ||
            item?.outcome === "unchanged") &&
          !item.pdfs?.some((pdf) => pdf.outcome === "not-sent")
            ? "success"
            : "warning",
        title:
          item?.outcome === "created"
            ? gt("Added to Zotero")
            : item?.outcome === "updated"
              ? gt("Updated in Zotero")
              : item?.outcome === "unchanged"
                ? gt("Zotero already has this source")
                : gt("Not sent to Zotero"),
        description: description || undefined,
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: gt("Not sent to Zotero"),
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
    sendPdfs,
    setSendPdfs,
    writableGroups,
    loadWritableGroups,
  };
}

const refreshProblem = (item: ScientSourceZoteroRefreshResult["items"][number]) =>
  item.outcome === "missing" || item.outcome === "failed" || item.outcome === "stale";

function refreshSummary(result: ScientSourceZoteroRefreshResult, resolve: MessageResolver): string {
  const updated = result.items.filter((item) => item.outcome === "updated").length;
  if (result.items.length === 0) return resolve(msg("No sources here came from Zotero."));
  if (updated === 0) {
    if (result.items.some((item) => item.conflicts.length > 0 || refreshProblem(item))) {
      return resolve(msg("No source was updated from Zotero."));
    }
    return result.items.some((item) => item.notBrought)
      ? resolve(msg("Nothing new came from Zotero."))
      : resolve(msg("Everything matches Zotero."));
  }
  return resolve(
    msg(
      "{count, plural, =1 {Updated 1 source from Zotero.} other {Updated {count} sources from Zotero.}}",
      { count: updated },
    ),
  );
}

export function ZoteroRefreshDialog(props: {
  readonly state: RefreshState | null;
  readonly resolving: string | null;
  readonly onClose: () => void;
  /** Reads Zotero again after a refresh that could not reach it. */
  readonly onCheckAgain: () => void;
  readonly onResolve: (
    sourceId: string,
    field: ScientSourceZoteroRefreshField,
    side: "zotero" | "local",
  ) => void;
}) {
  const m = useMessages();
  const gt = useGT();
  const state = props.state;
  const done = state?.phase === "done" ? state.result : null;
  const conflicts = (done?.items ?? []).flatMap((item) =>
    item.conflicts.map((conflict) => ({ item, conflict })),
  );
  const problems = (done?.items ?? []).filter(refreshProblem);
  const notBrought = notBroughtBySource(done?.items ?? []);
  return (
    <Dialog open={state !== null} onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="w-[min(520px,calc(100vw-32px))]">
        <DialogHeader>
          <DialogTitle>
            <T>Refresh from Zotero</T>
          </DialogTitle>
          <DialogDescription>
            {state?.phase === "running"
              ? state.checked !== undefined && state.total !== undefined
                ? gt(
                    "Reading your Zotero library… {checked} of {total} sources checked. Closing stops here; what was read is kept.",
                    {
                      checked: state.checked.toLocaleString(),
                      total: state.total.toLocaleString(),
                    },
                  )
                : gt("Reading your Zotero library…")
              : state?.phase === "problem"
                ? state.message
                : done
                  ? refreshSummary(done, m)
                  : null}
          </DialogDescription>
        </DialogHeader>
        {conflicts.length > 0 || problems.length > 0 || notBrought.length > 0 ? (
          <DialogPanel>
            <div className="grid gap-4 text-sm">
              {conflicts.length > 0 ? (
                <div className="grid gap-3">
                  <p className="text-muted-foreground">
                    <T>Changed both here and in Zotero. Your version was kept.</T>
                  </p>
                  {conflicts.map(({ item, conflict }) => {
                    const key = `${item.sourceId}\0${conflict.field}`;
                    return (
                      <div key={key} className="grid gap-1 border-t border-border pt-3">
                        <div className="truncate font-medium">
                          {item.title ?? gt("Untitled source")} · {m(FIELD_LABELS[conflict.field])}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          <div className="line-clamp-2">
                            {gt("Here: {value}", {
                              value: conflict.local || gt("empty", { $context: "no value" }),
                            })}
                          </div>
                          <div className="line-clamp-2">
                            {gt("In Zotero: {value}", {
                              value: conflict.zotero || gt("empty", { $context: "no value" }),
                            })}
                          </div>
                        </div>
                        <div className="mt-1 flex gap-1">
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={props.resolving !== null}
                            onClick={() => props.onResolve(item.sourceId, conflict.field, "local")}
                          >
                            <T>Keep mine</T>
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
                            <T>Use Zotero's</T>
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
                      <span className="min-w-0 truncate">
                        {item.title ?? gt("Untitled source")}
                      </span>
                      <span className="shrink-0 text-muted-foreground">{item.message}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {notBrought.length > 0 ? (
                <div className="grid gap-1 text-xs">
                  <div className="font-medium">{m(NOT_BROUGHT_LABELS.heading)}</div>
                  <ul className="space-y-0.5">
                    {notBrought.map((line) => (
                      <li key={`${line.kind}:${line.name ?? ""}`} className="break-words">
                        {notBroughtName(line)}:{" "}
                        <span className="text-muted-foreground">{notBroughtAmount(line)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            {state?.phase === "running" ? gt("Close") : gt("Done")}
          </Button>
          {state?.phase === "problem" ? (
            <Button size="sm" onClick={props.onCheckAgain}>
              <T>Check again</T>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
