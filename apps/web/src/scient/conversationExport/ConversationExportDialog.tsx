import type {
  ConversationExportFormat,
  EnvironmentId,
  ScientConversationExportDelivery,
  ScientConversationExportPreparation,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
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
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  exportConversation,
  prepareConversationExport,
  prepareConversationWordDiagrams,
} from "./client";
import { captureWordDiagrams } from "../wordExport/captureDiagrams";
import {
  buildExportRequest,
  canCopyExport,
  exportDialogWarnings,
  exportFormatOptions,
  initialExportDialogState,
  messageChoiceLabel,
  offeredVariant,
  selectedRegistration,
  type ExportDialogState,
} from "./exportDialog.logic";
import {
  copyConversationExport,
  saveConversationExport,
  saveFailureMessage,
} from "./exportActions";
import {
  registeredConversationExportFormats,
  type ConversationExportFormatRegistration,
} from "./formatRegistry";
import "./formats";

const useRequest = create<{ threadRef: ScopedThreadRef | null; key: number }>(() => ({
  threadRef: null,
  key: 0,
}));

/** Opens the export dialog for one conversation. Every opening starts from default options. */
export function requestConversationExport(threadRef: ScopedThreadRef): void {
  useRequest.setState((state) => ({ threadRef, key: state.key + 1 }));
}

function closeRequest() {
  useRequest.setState({ threadRef: null });
}

export function ConversationExportDialogHost() {
  const { threadRef, key } = useRequest();
  useEffect(() => closeRequest, []);
  return threadRef ? <ConversationExportDialog key={key} threadRef={threadRef} /> : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The conversation could not be exported.";
}

function localTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

type Loading =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed"; readonly message: string }
  | { readonly _tag: "ready"; readonly preparation: ScientConversationExportPreparation };

function ConversationExportDialog({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState<Loading>({ _tag: "loading" });
  const [state, setState] = useState<ExportDialogState | null>(null);
  const [busy, setBusy] = useState<ScientConversationExportDelivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const registrations = registeredConversationExportFormats();

  useEffect(() => {
    let cancelled = false;
    prepareConversationExport(threadRef.environmentId, threadRef.threadId).then(
      (preparation) => {
        if (cancelled) return;
        setLoading({ _tag: "ready", preparation });
        setState(initialExportDialogState(preparation, registrations));
      },
      (cause: unknown) => {
        if (!cancelled) setLoading({ _tag: "failed", message: errorMessage(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [registrations, threadRef.environmentId, threadRef.threadId]);

  // A format that became available here (Word, once Pandoc is installed) is
  // read again from the server and selected, keeping every other choice.
  const formatAvailable = (format: ConversationExportFormat) => {
    prepareConversationExport(threadRef.environmentId, threadRef.threadId).then(
      (preparation) => {
        setLoading({ _tag: "ready", preparation });
        const option = exportFormatOptions(preparation, registrations).find(
          (candidate) => candidate.registration.format === format && candidate.available,
        );
        setState((current) =>
          current === null || option === undefined
            ? current
            : {
                ...current,
                format,
                variant: option.registration.variant?.defaultValue ?? null,
              },
        );
      },
      (cause: unknown) => setError(errorMessage(cause)),
    );
  };

  const run = async (delivery: ScientConversationExportDelivery) => {
    if (loading._tag !== "ready" || state === null) return;
    const request = buildExportRequest({
      threadId: threadRef.threadId,
      state,
      preparation: loading.preparation,
      registrations,
      delivery,
      timeZone: localTimeZone(),
    });
    if (request === null) return;
    setBusy(delivery);
    setError(null);
    try {
      const registration = selectedRegistration(state, registrations);
      if (registration?.produce && delivery === "file") {
        const produced = await registration.produce({ threadRef, request });
        // Save cancelled: the dialog stays open, as for every other format.
        if (produced === null) return;
        const open = produced.open;
        const openAction =
          open === undefined
            ? {}
            : {
                actionProps: {
                  children: "Open",
                  onClick: () => {
                    // The conversation may not be the one on screen (a sidebar export).
                    open();
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(threadRef),
                    });
                  },
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
        request.format === "docx"
          ? {
              ...request,
              diagramCapture: await captureWordDiagrams(
                await prepareConversationWordDiagrams(threadRef.environmentId, request),
              ),
            }
          : request;
      const result = await exportConversation(threadRef.environmentId, preparedRequest);
      if (delivery === "clipboard") {
        await copyConversationExport(result.text ?? "");
        toastManager.add({ type: "success", title: "Markdown copied" });
      } else if (result.file !== null) {
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
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && busy === null) closeRequest();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export conversation</DialogTitle>
          <DialogDescription>
            {loading._tag === "ready" ? loading.preparation.title : "Preparing the conversation…"}
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
                onClick={() => requestConversationExport(threadRef)}
              >
                Try again
              </Button>
            </div>
          ) : null}
          {loading._tag === "ready" && state !== null ? (
            <ConversationExportForm
              environmentId={threadRef.environmentId}
              onFormatAvailable={formatAvailable}
              preparation={loading.preparation}
              registrations={registrations}
              state={state}
              disabled={busy !== null}
              onChange={setState}
            />
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null}
            onClick={() => closeRequest()}
          >
            Cancel
          </Button>
          {loading._tag === "ready" &&
          state !== null &&
          canCopyExport(state, loading.preparation, registrations) ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void run("clipboard")}
            >
              {busy === "clipboard" ? "Copying…" : "Copy"}
            </Button>
          ) : null}
          <Button
            type="button"
            disabled={loading._tag !== "ready" || state?.format == null || busy !== null}
            onClick={() => void run("file")}
          >
            {busy === "file" ? "Exporting…" : "Export"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The export choices. Stateless: the dialog owns the state and resets it on every opening. */
export function ConversationExportForm(props: {
  /** Lets an unavailable format offer to make itself available here. */
  readonly environmentId?: EnvironmentId;
  readonly onFormatAvailable?: (format: ConversationExportFormat) => void;
  readonly preparation: ScientConversationExportPreparation;
  readonly registrations: ReadonlyArray<ConversationExportFormatRegistration>;
  readonly state: ExportDialogState;
  readonly disabled: boolean;
  readonly onChange: (state: ExportDialogState) => void;
}) {
  const { preparation, registrations, state, disabled, onChange } = props;
  const id = useId();
  const formats = exportFormatOptions(preparation, registrations);
  const variant = offeredVariant(state, preparation, registrations);
  const registration = selectedRegistration(state, registrations);
  const note = registration?.note?.(preparation) ?? null;
  const unavailable = formats.filter((option) => !option.available);
  const warnings = exportDialogWarnings(state, preparation);
  const update = (patch: Partial<ExportDialogState>) => onChange({ ...state, ...patch });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span id={`${id}-format`} className="text-sm font-medium">
          Format
        </span>
        <ToggleGroup
          aria-labelledby={`${id}-format`}
          className="w-full *:flex-1"
          value={state.format === null ? [] : [state.format]}
          onValueChange={(next) => {
            const option = formats.find(
              (candidate) => candidate.registration.format === next[0] && candidate.available,
            );
            if (option)
              update({
                format: option.registration.format,
                variant: option.registration.variant?.defaultValue ?? null,
              });
          }}
        >
          {formats.map((option) => (
            <Toggle
              key={option.registration.format}
              value={option.registration.format}
              disabled={disabled || !option.available}
              title={option.unavailableReason ?? undefined}
            >
              {option.registration.label}
            </Toggle>
          ))}
        </ToggleGroup>
        {unavailable.map((option) => {
          const { format, UnavailableAction } = option.registration;
          return UnavailableAction !== undefined && props.environmentId !== undefined ? (
            <UnavailableAction
              key={format}
              environmentId={props.environmentId}
              onAvailable={() => props.onFormatAvailable?.(format)}
            />
          ) : (
            <p key={format} className="text-muted-foreground text-xs">
              {option.registration.label}: {option.unavailableReason}
            </p>
          );
        })}
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
        {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
      </div>

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
      </div>

      <div className="flex flex-col gap-2">
        <span id={`${id}-range`} className="text-sm font-medium">
          Range
        </span>
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
            Up to selected message
          </Label>
        </RadioGroup>
        {state.range === "through-message" ? (
          <Select
            value={state.throughMessageId ?? ""}
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
              <SelectValue />
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
