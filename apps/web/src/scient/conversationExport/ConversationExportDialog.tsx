import type {
  MessageId,
  ScientConversationExportPreparation,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { toastManager } from "../../components/ui/toast";
import {
  exportConversation,
  prepareConversationExport,
  prepareConversationWordDiagrams,
} from "./client";
import { captureWordDiagrams } from "../wordExport/captureDiagrams";
import {
  INCLUDE_CAUTION,
  buildExportRequest,
  exportDialogWarnings,
  exportFormatAvailability,
  exportSaveLabel,
  initialExportDialogState,
  messageChoiceLabel,
  offeredVariant,
  showsIncludeCaution,
  type ExportDialogRequest,
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

const RANGE_ABOUT = "Exports from the start of the conversation through the message you choose.";

interface OpenRequest extends ExportDialogRequest {
  readonly threadRef: ScopedThreadRef;
}

const useRequest = create<{ request: OpenRequest | null; key: number }>(() => ({
  request: null,
  key: 0,
}));

/**
 * Opens the export dialog for one conversation, preset to a format and, from a
 * message's "Export up to here…", to end at that message. Every opening starts
 * from default options.
 */
export function requestConversationExport(
  threadRef: ScopedThreadRef,
  options: {
    readonly format: ExportDialogRequest["format"];
    readonly throughMessageId?: MessageId | null;
  },
): void {
  useRequest.setState((state) => ({
    request: {
      threadRef,
      format: options.format,
      throughMessageId: options.throughMessageId ?? null,
    },
    key: state.key + 1,
  }));
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
        setState(initialExportDialogState(preparation, registrations, request));
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
        toastManager.add(
          produced.warnings.length > 0
            ? {
                type: "warning",
                title: `${produced.title} with notes`,
                description: produced.warnings.map((warning) => warning.message).join("\n"),
              }
            : { type: "success", title: produced.title },
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
                onClick={() => requestConversationExport(threadRef, request)}
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

/** The export choices. Stateless: the dialog owns the state and resets it on every opening. */
export function ConversationExportForm(props: {
  readonly preparation: ScientConversationExportPreparation;
  readonly registrations: ReadonlyArray<ConversationExportFormatRegistration>;
  readonly state: ExportDialogState;
  readonly disabled: boolean;
  readonly onChange: (state: ExportDialogState) => void;
}) {
  const { preparation, registrations, state, disabled, onChange } = props;
  const id = useId();
  const variant = offeredVariant(state, preparation, registrations);
  const warnings = exportDialogWarnings(state, preparation);
  const update = (patch: Partial<ExportDialogState>) => onChange({ ...state, ...patch });

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
        <Label>
          <Switch
            checked={state.includeWorkLog}
            disabled={disabled}
            onCheckedChange={(checked) => update({ includeWorkLog: checked })}
          />
          Work log — tools, commands, results
        </Label>
        <Label>
          <Switch
            checked={state.includeReasoning}
            disabled={disabled}
            onCheckedChange={(checked) => update({ includeReasoning: checked })}
          />
          Reasoning — the thinking shown in chat
        </Label>
        {showsIncludeCaution(state) ? (
          <p className="flex items-start gap-1.5 text-warning text-xs">
            <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
            {INCLUDE_CAUTION}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1">
          <span id={`${id}-range`} className="text-sm font-medium">
            Range
          </span>
          <ExportInfoButton label="About Range">{RANGE_ABOUT}</ExportInfoButton>
        </div>
        <RadioGroup
          aria-labelledby={`${id}-range`}
          value={state.range}
          disabled={disabled}
          onValueChange={(value) =>
            update({ range: value === "through-message" ? "through-message" : "whole" })
          }
        >
          <Label>
            <Radio value="whole" />
            Whole conversation
          </Label>
          <Label>
            <Radio value="through-message" disabled={preparation.messages.length === 0} />
            Up to a message…
          </Label>
        </RadioGroup>
        {state.range === "through-message" ? (
          <Select
            value={state.throughMessageId}
            items={Object.fromEntries(
              preparation.messages.map((choice) => [choice.messageId, messageChoiceLabel(choice)]),
            )}
            disabled={disabled}
            onValueChange={(value) => {
              const choice = preparation.messages.find(
                (candidate) => candidate.messageId === value,
              );
              if (choice) update({ throughMessageId: choice.messageId });
            }}
          >
            <SelectTrigger aria-label="Last message to include" className="min-w-0">
              <SelectValue placeholder="Choose a message" />
            </SelectTrigger>
            <SelectPopup>
              {preparation.messages.map((choice) => (
                <SelectItem key={choice.messageId} value={choice.messageId}>
                  {messageChoiceLabel(choice)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
      </div>

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
