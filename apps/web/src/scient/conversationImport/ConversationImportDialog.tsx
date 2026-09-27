import type {
  ConversationImportId,
  DesktopOpenedConversationFile,
  EnvironmentId,
  ModelSelection,
  ScientConversationImportPreview,
} from "@t3tools/contracts";
import { SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
import { toastManager } from "../../components/ui/toast";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
} from "../../providerInstances";
import { useProjects, useServerConfigs } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  cancelConversationImport,
  confirmConversationImport,
  createConversationImportUpload,
  previewConversationImport,
  uploadConversationFile,
} from "./client";

type Source =
  | { readonly _tag: "choose" }
  | { readonly _tag: "browser-file"; readonly file: File }
  | { readonly _tag: "desktop-file"; readonly file: DesktopOpenedConversationFile };

const useRequests = create<{ readonly queue: ReadonlyArray<Source> }>(() => ({ queue: [] }));

export function requestConversationImport(source: Source = { _tag: "choose" }): void {
  useRequests.setState((state) => ({ queue: [...state.queue, source] }));
}

function dismissRequest(): void {
  useRequests.setState((state) => ({ queue: state.queue.slice(1) }));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "The conversation could not be imported.";
}

/** The File menu and OS file-open events enter the same preview-and-confirm flow. */
export function ConversationImportDialogHost() {
  const queue = useRequests((state) => state.queue);
  useEffect(() => {
    const bridge = window.desktopBridge;
    const collect = () => {
      void bridge?.takeOpenedConversationFiles?.().then(
        (files) =>
          files.forEach((file) => requestConversationImport({ _tag: "desktop-file", file })),
        (cause: unknown) =>
          toastManager.add({
            type: "error",
            title: "Could not open conversation file",
            description: errorMessage(cause),
          }),
      );
    };
    collect();
    const stopFiles = bridge?.onConversationFilesOpened?.(collect);
    const stopMenu = bridge?.onMenuAction?.((action) => {
      if (action === "import-conversation") requestConversationImport();
    });
    return () => {
      stopFiles?.();
      stopMenu?.();
    };
  }, []);
  return queue[0] ? (
    <ConversationImportDialog
      key={
        queue[0]._tag === "desktop-file"
          ? queue[0].file.token
          : queue[0]._tag === "browser-file"
            ? queue[0].file.name
            : "choose"
      }
      initialSource={queue[0]}
    />
  ) : null;
}

function ConversationImportDialog({ initialSource }: { readonly initialSource: Source }) {
  const navigate = useNavigate();
  const projects = useProjects();
  const configs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [source, setSource] = useState<Source>(initialSource);
  const [selectedEnvironmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId = selectedEnvironmentId ?? primaryEnvironmentId;
  const [preview, setPreview] = useState<ScientConversationImportPreview | null>(null);
  const [stagedId, setStagedId] = useState<ConversationImportId | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  const [modelKey, setModelKey] = useState("");
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledgeMarkdownIssues, setAcknowledgeMarkdownIssues] = useState(false);
  const availableProjects = projects.filter((project) => project.environmentId === environmentId);
  const modelChoices = useMemo(() => {
    const config = environmentId === null ? null : configs.get(environmentId);
    if (config === null || config === undefined) return [];
    return deriveProviderInstanceEntries(config.providers)
      .filter(isProviderInstancePickerReady)
      .flatMap((entry) =>
        entry.models.map((model) => ({
          key: `${entry.instanceId}/${model.slug}`,
          label: `${entry.displayName} · ${model.name}`,
          selection: { instanceId: entry.instanceId, model: model.slug } satisfies ModelSelection,
        })),
      );
  }, [configs, environmentId]);
  const selectedProject = availableProjects.find((project) => project.id === projectId) ?? null;
  const selectedModel = modelChoices.find((choice) => choice.key === modelKey) ?? null;

  const close = () => {
    if (busy !== null) return;
    if (stagedId !== null && environmentId !== null) {
      void cancelConversationImport(environmentId, stagedId).catch(() => undefined);
    }
    dismissRequest();
  };

  const runPreview = async (markdownMode?: "messages" | "document") => {
    if (environmentId === null || source._tag === "choose") return;
    const fileName = source._tag === "browser-file" ? source.file.name : source.file.fileName;
    const sizeBytes = source._tag === "browser-file" ? source.file.size : source.file.sizeBytes;
    const markdown = fileName.toLowerCase().endsWith(".md");
    if (!markdown && !fileName.toLowerCase().endsWith(".scic")) {
      setError("Choose a Scient conversation file (.scic) or Markdown file (.md).");
      return;
    }
    if (
      sizeBytes <= 0 ||
      sizeBytes > (markdown ? 16 * 1024 * 1024 : SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES)
    ) {
      setError("The conversation file is empty or exceeds Scient's import limit.");
      return;
    }
    setBusy("preview");
    setError(null);
    setAcknowledgeMarkdownIssues(false);
    let createdId: ConversationImportId | null = null;
    try {
      if (stagedId !== null) {
        await cancelConversationImport(environmentId, stagedId);
        setStagedId(null);
        setPreview(null);
      }
      const upload = await createConversationImportUpload(
        environmentId,
        fileName,
        sizeBytes,
        markdownMode,
      );
      createdId = upload.importId;
      setStagedId(upload.importId);
      if (source._tag === "browser-file") {
        await uploadConversationFile(upload.url, source.file);
      } else {
        const result = await window.desktopBridge?.uploadOpenedConversationFile?.({
          token: source.file.token,
          url: upload.url,
        });
        if (result?._tag !== "uploaded")
          throw new Error(
            `The desktop could not upload this file (${result?.reason ?? "unavailable"}).`,
          );
      }
      const next = await previewConversationImport(environmentId, upload.importId);
      setPreview(next);
      const project = availableProjects[0];
      if (project) {
        setProjectId(project.id);
        const defaultChoice = modelChoices.find(
          (choice) =>
            choice.selection.instanceId === project.defaultModelSelection?.instanceId &&
            choice.selection.model === project.defaultModelSelection.model,
        );
        setModelKey(defaultChoice?.key ?? modelChoices[0]?.key ?? "");
      }
    } catch (cause) {
      setError(errorMessage(cause));
      if (createdId !== null) {
        void cancelConversationImport(environmentId, createdId).catch(() => undefined);
        setStagedId(null);
      }
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    if (
      environmentId === null ||
      preview === null ||
      selectedProject === null ||
      selectedModel === null
    )
      return;
    setBusy("import");
    setError(null);
    try {
      const result = await confirmConversationImport(environmentId, {
        importId: preview.importId,
        packageSha256: preview.package.packageSha256,
        ...(preview.kind === "markdown" && preview.markdownIssues.length > 0
          ? { acknowledgeMarkdownIssues }
          : {}),
        destination: {
          projectId: selectedProject.id,
          modelSelection: selectedModel.selection,
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
      });
      setStagedId(null);
      dismissRequest();
      toastManager.add({
        type: "success",
        title:
          preview.kind === "document"
            ? "Document added to a new conversation"
            : "Conversation imported",
        description: "The next message starts a fresh provider session.",
      });
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId: result.threadId }),
      });
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
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import conversation</DialogTitle>
          <DialogDescription>
            Preview an untrusted file before creating a new, independent conversation.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Conversation file</span>
              {source._tag === "desktop-file" ? (
                <span>{source.file.fileName}</span>
              ) : (
                <input
                  type="file"
                  accept=".scic,.md"
                  disabled={busy !== null || preview !== null}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) setSource({ _tag: "browser-file", file });
                  }}
                />
              )}
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Destination environment</span>
              <select
                className="w-full rounded-md border bg-background p-2"
                value={environmentId ?? ""}
                disabled={busy !== null || preview !== null}
                onChange={(event) => setEnvironmentId(event.target.value as EnvironmentId)}
              >
                <option value="" disabled>
                  Choose an environment
                </option>
                {[...configs.keys()].map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            {preview !== null ? (
              <div className="space-y-3 text-sm">
                <p className="font-medium">{preview.conversation.title}</p>
                <p>
                  {preview.kind === "scic"
                    ? "Scient conversation file: structured conversation and included attachments."
                    : preview.kind === "markdown"
                      ? "Scient Markdown transcript: message text only; referenced files do not transfer."
                      : "Ordinary Markdown: starts a conversation with the document attached, not a reconstructed transcript."}
                </p>
                <p>
                  {preview.counts.messages} messages · {preview.counts.attachments} attachments ·
                  from {preview.conversation.provider}
                </p>
                <p className="text-muted-foreground">
                  The sender's identity is not verified. Pending actions, provider sessions and
                  workspace files do not transfer.
                </p>
                {preview.omissions.length > 0 ? (
                  <p>
                    Some content was omitted ({preview.omissions.length} notices). Review the
                    imported thread before continuing.
                  </p>
                ) : null}
                {preview.warnings.length > 0 ? (
                  <p role="alert">This file has {preview.warnings.length} warning(s).</p>
                ) : null}
                {preview.markdownIssues.length > 0 ? (
                  <div className="space-y-2 rounded-md border p-3" role="alert">
                    <p className="font-medium">Damaged transcript markers</p>
                    <p>
                      Only clean messages will import. Review these line ranges before choosing:
                    </p>
                    <ul className="list-inside list-disc">
                      {preview.markdownIssues.slice(0, 10).map((issue) => (
                        <li
                          key={`${issue.kind}-${issue.startLine}-${issue.endLine}-${issue.detail}`}
                        >
                          Lines {issue.startLine}–{issue.endLine}: {issue.detail}
                        </li>
                      ))}
                    </ul>
                    {preview.markdownIssues.length > 10 ? (
                      <p>And {preview.markdownIssues.length - 10} more marker issue(s).</p>
                    ) : null}
                    {preview.kind === "markdown" ? (
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={acknowledgeMarkdownIssues}
                          onChange={(event) => setAcknowledgeMarkdownIssues(event.target.checked)}
                        />
                        <span>Import only the clean messages despite these issues</span>
                      </label>
                    ) : null}
                    {source._tag === "browser-file" ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void runPreview("document")}
                      >
                        Start with the whole document instead
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                <label className="block">
                  <span className="mb-1 block font-medium">Project</span>
                  <select
                    className="w-full rounded-md border bg-background p-2"
                    value={projectId}
                    onChange={(event) => {
                      const nextId = event.target.value;
                      setProjectId(nextId);
                      const project = availableProjects.find((entry) => entry.id === nextId);
                      const preferred = modelChoices.find(
                        (choice) =>
                          choice.selection.instanceId ===
                            project?.defaultModelSelection?.instanceId &&
                          choice.selection.model === project.defaultModelSelection.model,
                      );
                      if (preferred) setModelKey(preferred.key);
                    }}
                  >
                    {availableProjects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block font-medium">
                    Provider and model for the next message
                  </span>
                  <select
                    className="w-full rounded-md border bg-background p-2"
                    value={modelKey}
                    onChange={(event) => setModelKey(event.target.value)}
                  >
                    {modelChoices.map((choice) => (
                      <option key={choice.key} value={choice.key}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
                {availableProjects.length === 0 || modelChoices.length === 0 ? (
                  <p role="alert">
                    Connect an environment with a project and a ready provider before importing.
                  </p>
                ) : null}
              </div>
            ) : null}
            {error !== null ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy !== null} onClick={close}>
            Cancel
          </Button>
          {preview === null ? (
            <Button
              type="button"
              disabled={busy !== null || source._tag === "choose" || environmentId === null}
              onClick={() => void runPreview()}
            >
              {busy === "preview" ? "Checking…" : "Preview"}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={
                busy !== null ||
                selectedProject === null ||
                selectedModel === null ||
                (preview.kind === "markdown" &&
                  preview.markdownIssues.length > 0 &&
                  !acknowledgeMarkdownIssues)
              }
              onClick={() => void runImport()}
            >
              {busy === "import" ? "Importing…" : "Import and continue"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
