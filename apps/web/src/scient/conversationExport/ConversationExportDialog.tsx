import type {
  ConversationExportFormat,
  ScientConversationExportPreparation,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

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
import { Label } from "../../components/ui/label";
import { Radio, RadioGroup } from "../../components/ui/radio-group";
import { Switch } from "../../components/ui/switch";
import { toastManager } from "../../components/ui/toast";
import {
  exportConversation,
  prepareConversationExport,
  prepareConversationWordDiagrams,
} from "./client";
import { showInOwningThread } from "../documentExport/showInOwningThread";
import { captureWordDiagrams } from "../wordExport/captureDiagrams";
import {
  INCLUDE_CAUTION,
  buildExportRequest,
  exportDialogWarnings,
  exportFormatAvailability,
  exportSaveLabel,
  initialExportDialogState,
  offeredVariant,
  type ExportDialogState,
} from "./exportDialog.logic";
import {
  exportErrorMessage,
  localTimeZone,
  saveConversationExport,
  saveFailureMessage,
} from "./exportActions";
import { ExportInfoButton } from "./ExportInfoButton";
import {
  registeredConversationExportFormats,
  type ConversationExportFormatRegistration,
} from "./formatRegistry";
import "./formats";

interface OpenRequest {
  readonly threadRef: ScopedThreadRef;
  readonly format: ConversationExportFormat;
}

const useRequest = create<{ request: OpenRequest | null; key: number }>(() => ({
  request: null,
  key: 0,
}));

/** Opens the export dialog for one conversation in one format. Every opening starts from default options. */
export function requestConversationExport(
  threadRef: ScopedThreadRef,
  format: ConversationExportFormat,
): void {
  useRequest.setState((state) => ({ request: { threadRef, format }, key: state.key + 1 }));
}

function closeRequest() {
  useRequest.setState({ request: null });
}

export function ConversationExportDialogHost() {
  const { request, key } = useRequest();
  useEffect(() => closeRequest, []);
  return request ? <ConversationExportDialog key={key} request={request} /> : null;
}

type Loading =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed"; readonly message: string }
  | { readonly _tag: "ready"; readonly preparation: ScientConversationExportPreparation };

function ConversationExportDialog({ request }: { readonly request: OpenRequest }) {
  const { threadRef } = request;
  const navigate = useNavigate();
  const [loading, setLoading] = useState<Loading>({ _tag: "loading" });
  const [state, setState] = useState<ExportDialogState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const registrations = registeredConversationExportFormats();
  const registration = registrations.find((entry) => entry.format === request.format) ?? null;
  const label = registration?.label ?? request.format;

  useEffect(() => {
    let cancelled = false;
    prepareConversationExport(threadRef.environmentId, threadRef.threadId).then(
      (preparation) => {
        if (cancelled) return;
        setLoading({ _tag: "ready", preparation });
        setState(initialExportDialogState(registrations, request.format));
      },
      (cause: unknown) => {
        if (!cancelled) setLoading({ _tag: "failed", message: exportErrorMessage(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [registrations, request, threadRef.environmentId, threadRef.threadId]);

  // The format became available here (Word, once Pandoc is installed): read
  // the conversation again so the options appear.
  const formatAvailable = () => {
    prepareConversationExport(threadRef.environmentId, threadRef.threadId).then(
      (preparation) => setLoading({ _tag: "ready", preparation }),
      (cause: unknown) => setError(exportErrorMessage(cause)),
    );
  };

  const change = (next: ExportDialogState) => {
    setError(null);
    setState(next);
  };

  const preparation = loading._tag === "ready" ? loading.preparation : null;
  const availability =
    preparation === null
      ? null
      : exportFormatAvailability(request.format, preparation, registrations);
  const exportRequest =
    preparation === null || state === null || availability?.available !== true
      ? null
      : buildExportRequest({
          threadId: threadRef.threadId,
          state,
          preparation,
          registrations,
          timeZone: localTimeZone(),
        });

  const run = async () => {
    if (exportRequest === null || registration === null) return;
    setBusy(true);
    setError(null);
    try {
      if (registration.produce) {
        const produced = await registration.produce({ threadRef, request: exportRequest });
        // Save cancelled: the dialog stays open, as for every other format.
        if (produced === null) return;
        const open = produced.open;
        const openAction =
          open === undefined
            ? {}
            : {
                actionProps: {
                  children: "Open",
                  // A sidebar export's conversation may not be the one on screen.
                  onClick: () => showInOwningThread(navigate, threadRef, open),
                },
              };
        toastManager.add(
          produced.warnings.length > 0
            ? {
                type: "warning",
                title: `${produced.title} with notes`,
                description: produced.warnings.map((warning) => warning.message).join("\n"),
                ...openAction,
              }
            : {
                type: "success",
                title: produced.title,
                ...(produced.description === undefined
                  ? {}
                  : { description: produced.description }),
                ...openAction,
              },
        );
        closeRequest();
        return;
      }
      const preparedRequest =
        exportRequest.format === "docx"
          ? {
              ...exportRequest,
              diagramCapture: await captureWordDiagrams(
                await prepareConversationWordDiagrams(threadRef.environmentId, exportRequest),
              ),
            }
          : exportRequest;
      const result = await exportConversation(threadRef.environmentId, preparedRequest);
      if (result.file !== null) {
        const saved = await saveConversationExport(threadRef.environmentId, result.file);
        if (saved._tag === "cancelled") return;
        if (saved._tag === "failed") {
          setError(saveFailureMessage(saved));
          return;
        }
        toastManager.add({
          type: "success",
          title: saved._tag === "saved" ? "Export saved" : "Download started",
          description: saved._tag === "saved" ? saved.path : result.file.fileName,
        });
      }
      if (result.warnings.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Exported with notes",
          description: result.warnings.map((warning) => warning.message).join("\n"),
        });
      }
      closeRequest();
    } catch (cause) {
      setError(exportErrorMessage(cause));
      // A Pandoc that no longer starts makes Word unavailable with a reinstall
      // offer; read availability again so the dialog shows it.
      if (exportRequest.format === "docx") formatAvailable();
    } finally {
      setBusy(false);
    }
  };

  const UnavailableAction = registration?.UnavailableAction;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) closeRequest();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-1">
            <DialogTitle>Export as {label}</DialogTitle>
            {registration ? (
              <ExportInfoButton label={`About ${label} export`}>
                {registration.about}
              </ExportInfoButton>
            ) : null}
          </div>
          <DialogDescription>
            {preparation !== null ? (
              preparation.title
            ) : loading._tag === "loading" ? (
              <span role="status">Preparing the conversation…</span>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {loading._tag === "failed" ? (
            <div className="flex flex-col items-start gap-3">
              <p role="alert" className="text-destructive">
                {loading.message}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => requestConversationExport(threadRef, request.format)}
              >
                Try again
              </Button>
            </div>
          ) : null}
          {availability?.available === false ? (
            UnavailableAction ? (
              <UnavailableAction
                environmentId={threadRef.environmentId}
                reason={availability.reason}
                disabled={busy}
                onAvailable={formatAvailable}
              />
            ) : (
              <p className="text-sm">{availability.reason}</p>
            )
          ) : null}
          {preparation !== null && state !== null && availability?.available === true ? (
            <ConversationExportForm
              preparation={preparation}
              registrations={registrations}
              state={state}
              disabled={busy}
              onChange={change}
            />
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {busy ? (
            <p role="status" className="text-muted-foreground text-sm sm:me-auto sm:self-center">
              Exporting…
            </p>
          ) : null}
          <Button type="button" variant="outline" disabled={busy} onClick={() => closeRequest()}>
            Cancel
          </Button>
          {preparation !== null && state !== null && availability?.available === true ? (
            <Button
              type="button"
              disabled={exportRequest === null || busy}
              onClick={() => void run()}
            >
              {exportSaveLabel(state, preparation, registrations)}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const INCLUDE_CAUTION_MS = 4_000;
const INCLUDE_CAUTION_GAP_PX = 8;

type CautionTarget = "workLog" | "reasoning";
type CautionPosition = {
  readonly target: CautionTarget;
  readonly popup: HTMLElement;
  readonly top: number;
  readonly left: number;
  readonly maxWidth: number;
};

function IncludeCaution({
  id,
  position,
}: {
  readonly id: string;
  readonly position: CautionPosition;
}) {
  return createPortal(
    <p
      id={id}
      role="status"
      className="pointer-events-none absolute z-10 flex w-80 -translate-y-full items-start gap-2 rounded-lg border bg-popover px-3 py-2 text-xs leading-5 text-muted-foreground shadow-lg"
      style={{ top: position.top, left: position.left, maxWidth: position.maxWidth }}
    >
      <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
      {INCLUDE_CAUTION}
    </p>,
    position.popup,
  );
}

/** The export choices. Inclusion choices live in the dialog; the caution is local and temporary. */
export function ConversationExportForm(props: {
  readonly preparation: ScientConversationExportPreparation;
  readonly registrations: ReadonlyArray<ConversationExportFormatRegistration>;
  readonly state: ExportDialogState;
  readonly disabled: boolean;
  readonly onChange: (state: ExportDialogState) => void;
}) {
  const { preparation, registrations, state, disabled, onChange } = props;
  const variant = offeredVariant(state, preparation, registrations);
  const warnings = exportDialogWarnings(preparation);
  const update = (patch: Partial<ExportDialogState>) => onChange({ ...state, ...patch });
  const [cautionFor, setCautionFor] = useState<CautionTarget | null>(null);
  const [cautionPosition, setCautionPosition] = useState<CautionPosition | null>(null);
  const workLogRef = useRef<HTMLLabelElement>(null);
  const reasoningRef = useRef<HTMLLabelElement>(null);

  useEffect(() => {
    if (cautionFor === null) return;
    const timeout = window.setTimeout(() => setCautionFor(null), INCLUDE_CAUTION_MS);
    return () => window.clearTimeout(timeout);
  }, [cautionFor]);

  useLayoutEffect(() => {
    if (cautionFor === null) return;
    const anchor = (cautionFor === "workLog" ? workLogRef : reasoningRef).current;
    const popup = anchor?.closest<HTMLElement>('[data-slot="dialog-popup"]');
    if (!anchor || !popup) return;

    const updatePosition = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();
      const scaleX = popup.offsetWidth > 0 ? popupRect.width / popup.offsetWidth : 1;
      const scaleY = popup.offsetHeight > 0 ? popupRect.height / popup.offsetHeight : 1;
      const left = Math.max(12, (anchorRect.left - popupRect.left) / (scaleX || 1));
      setCautionPosition({
        target: cautionFor,
        popup,
        top: (anchorRect.top - popupRect.top) / (scaleY || 1) - INCLUDE_CAUTION_GAP_PX,
        left,
        maxWidth: Math.max(1, popup.offsetWidth - left - 12),
      });
    };

    updatePosition();
    const scrollArea = anchor.closest('[data-slot="scroll-area-viewport"]');
    scrollArea?.addEventListener("scroll", updatePosition, { passive: true });
    window.addEventListener("resize", updatePosition);
    return () => {
      scrollArea?.removeEventListener("scroll", updatePosition);
      window.removeEventListener("resize", updatePosition);
    };
  }, [cautionFor]);

  const changeInclude = (field: "includeWorkLog" | "includeReasoning", checked: boolean) => {
    const target = field === "includeWorkLog" ? "workLog" : "reasoning";
    setCautionFor((current) => (checked ? target : current === target ? null : current));
    update({ [field]: checked });
  };

  const shownCaution = cautionPosition?.target === cautionFor ? cautionPosition : null;

  return (
    <div className="flex flex-col gap-4">
      {variant ? (
        <RadioGroup
          aria-label={variant.label}
          value={state.variant ?? variant.defaultValue}
          onValueChange={(value) => update({ variant: String(value) })}
          disabled={disabled}
        >
          {variant.choices.map((choice) => (
            <Label key={choice.value}>
              <Radio value={choice.value} />
              {choice.label}
            </Label>
          ))}
        </RadioGroup>
      ) : null}

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Include</span>
        <Label ref={workLogRef}>
          <Switch
            checked={state.includeWorkLog}
            disabled={disabled}
            aria-describedby={
              shownCaution?.target === "workLog" ? "export-work-log-caution" : undefined
            }
            onCheckedChange={(checked) => changeInclude("includeWorkLog", checked)}
          />
          Work log — tools, commands, results
        </Label>
        <Label ref={reasoningRef}>
          <Switch
            checked={state.includeReasoning}
            disabled={disabled}
            aria-describedby={
              shownCaution?.target === "reasoning" ? "export-reasoning-caution" : undefined
            }
            onCheckedChange={(checked) => changeInclude("includeReasoning", checked)}
          />
          Reasoning — the thinking shown in chat
        </Label>
      </div>

      {shownCaution ? (
        <IncludeCaution
          id={
            shownCaution.target === "workLog"
              ? "export-work-log-caution"
              : "export-reasoning-caution"
          }
          position={shownCaution}
        />
      ) : null}

      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Export warnings">
          {warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-1.5 text-warning text-xs">
              <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
