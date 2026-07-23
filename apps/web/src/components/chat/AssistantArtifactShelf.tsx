// FILE: AssistantArtifactShelf.tsx
// Purpose: Show explicitly linked HTML/Markdown deliverables beneath a settled assistant reply.
// Layer: Chat timeline presentation

import type { EditorId } from "@synara/contracts";
import { isLocalAbsolutePath, joinWorkspaceRelativePath } from "@synara/shared/path";
import { useQuery } from "@tanstack/react-query";
import { memo, useEffect, useId, useMemo, useState } from "react";

import { resolveAvailableEditorOptions } from "~/editorMetadata";
import { extractMessageArtifacts, type MessageArtifactReference } from "~/lib/messageArtifacts";
import {
  AppsIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ExternalLinkIcon,
  EyeIcon,
  FolderIcon,
} from "~/lib/icons";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { openWorkspaceFileReference, useWorkspaceFileOpener } from "~/lib/workspaceFileOpener";
import { readNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { FileEntryIcon } from "./FileEntryIcon";

const COLLAPSED_FULL_ARTIFACT_COUNT = 2;
const MIN_ARTIFACT_COUNT_TO_COLLAPSE = 4;

function absoluteArtifactPath(path: string, workspaceRoot: string | undefined): string | null {
  if (isLocalAbsolutePath(path)) return path;
  return workspaceRoot ? joinWorkspaceRelativePath(workspaceRoot, path) : null;
}

function artifactSubtitle(kind: MessageArtifactReference["kind"]): string {
  return kind === "html" ? "Web page · HTML" : "Document · MD";
}

function HtmlArtifactThumbnail(props: {
  path: string;
  label: string;
  getPreviewUrl: ((path: string) => Promise<string | null>) | undefined;
}) {
  const { getPreviewUrl, label, path } = props;
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreviewUrl(null);
    setLoaded(false);
    if (!getPreviewUrl) return;
    void getPreviewUrl(path)
      .then((url) => {
        if (!cancelled) setPreviewUrl(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [getPreviewUrl, path]);

  if (!previewUrl || !loaded) {
    return (
      <div className="flex size-[54px] shrink-0 items-center justify-center rounded-lg border border-border/70 bg-[var(--color-background-elevated-secondary)] sm:h-[52px] sm:w-[72px]">
        <FileEntryIcon pathValue={path} kind="file" className="size-5" />
        {previewUrl ? (
          <iframe
            aria-hidden="true"
            className="pointer-events-none absolute size-px opacity-0"
            sandbox=""
            src={previewUrl}
            tabIndex={-1}
            title={`Loading preview of ${label}`}
            onLoad={() => setLoaded(true)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative h-[52px] w-[72px] shrink-0 overflow-hidden rounded-lg border border-border/70 bg-white shadow-xs",
        "origin-left transition-[transform,box-shadow] duration-180 ease-out",
        "hover:z-20 hover:scale-[1.18] hover:shadow-md",
        "group-focus-within/artifact-row:z-20 group-focus-within/artifact-row:scale-[1.18] group-focus-within/artifact-row:shadow-md",
      )}
      title="Rendered HTML preview"
    >
      <iframe
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 h-[520px] w-[720px] origin-top-left scale-[0.1] border-0 bg-white"
        sandbox=""
        src={previewUrl}
        tabIndex={-1}
        title={`Preview of ${label}`}
      />
    </div>
  );
}

const AssistantArtifactRow = memo(function AssistantArtifactRow(props: {
  artifact: MessageArtifactReference;
  workspaceRoot: string | undefined;
  loadHtmlThumbnail?: boolean;
}) {
  const opener = useWorkspaceFileOpener();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const editorOptions = useMemo(
    () =>
      resolveAvailableEditorOptions(
        navigator.platform,
        serverConfigQuery.data?.availableEditors ?? [],
      ).filter(({ value }) => value !== "file-manager" && value !== "system-default"),
    [serverConfigQuery.data?.availableEditors],
  );
  const absolutePath = absoluteArtifactPath(props.artifact.path, props.workspaceRoot);
  const [openError, setOpenError] = useState<string | null>(null);

  const reportOpenError = (error: unknown) => {
    setOpenError(error instanceof Error ? error.message : "The file could not be opened.");
  };
  const preview = () => {
    setOpenError(null);
    openWorkspaceFileReference(opener, props.artifact.path, { onError: reportOpenError });
  };
  const openInEditor = (editorId: EditorId) => {
    setOpenError(null);
    const api = readNativeApi();
    if (!api || !absolutePath) {
      reportOpenError(new Error("The desktop file opener is unavailable."));
      return;
    }
    void api.shell.openInEditor(absolutePath, editorId).catch(reportOpenError);
  };

  return (
    <div className="group/artifact-row flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
        title={`Preview ${props.artifact.path}`}
        onClick={preview}
      >
        {props.artifact.kind === "html" && props.loadHtmlThumbnail !== false ? (
          <HtmlArtifactThumbnail
            path={props.artifact.path}
            label={props.artifact.label}
            getPreviewUrl={opener?.getHtmlPreviewUrl}
          />
        ) : (
          <div className="flex size-[54px] shrink-0 items-center justify-center rounded-lg border border-border/70 bg-[var(--color-background-elevated-secondary)] sm:h-[52px] sm:w-[72px]">
            <FileEntryIcon pathValue={props.artifact.path} kind="file" className="size-5" />
          </div>
        )}
        <span className="min-w-0 flex-1" dir="auto">
          <span className="block truncate text-sm font-medium text-foreground">
            {props.artifact.label}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground/75">
            {artifactSubtitle(props.artifact.kind)}
          </span>
        </span>
      </button>

      <div data-artifact-actions className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="link"
          size="sm"
          className="h-8 px-2 text-[var(--color-token-text-link-foreground)]"
          onClick={preview}
        >
          Preview
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1 px-2.5"
                aria-label={`Open ${props.artifact.label} in another app`}
              />
            }
          >
            Open in
            <ChevronDownIcon aria-hidden="true" className="size-3.5" />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="end" side="bottom" sideOffset={6} className="min-w-48">
            <MenuItem onClick={preview}>
              <EyeIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              Scient preview
            </MenuItem>
            {props.artifact.kind === "html" ? (
              <MenuItem
                disabled={!opener?.openHtmlInExternalBrowser}
                onClick={() => {
                  setOpenError(null);
                  if (!opener?.openHtmlInExternalBrowser?.(props.artifact.path)) {
                    reportOpenError(new Error("The browser could not open this preview."));
                  }
                }}
              >
                <ExternalLinkIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                Default browser
              </MenuItem>
            ) : (
              <MenuItem disabled={!absolutePath} onClick={() => openInEditor("system-default")}>
                <AppsIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                Default app
              </MenuItem>
            )}
            {editorOptions.length > 0 ? <MenuSeparator /> : null}
            {editorOptions.map(({ value, label, Icon }) => (
              <MenuItem key={value} disabled={!absolutePath} onClick={() => openInEditor(value)}>
                <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
                {label}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem
              disabled={!absolutePath}
              onClick={() => {
                setOpenError(null);
                const api = readNativeApi();
                if (api && absolutePath) {
                  void api.shell.showInFolder(absolutePath).catch(reportOpenError);
                } else {
                  reportOpenError(new Error("The desktop file browser is unavailable."));
                }
              }}
            >
              <FolderIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              Show in folder
            </MenuItem>
          </ComposerPickerMenuPopup>
        </Menu>
      </div>
      <p
        className={cn(
          "basis-full pl-[66px] text-destructive text-xs sm:pl-[84px]",
          !openError && "sr-only",
        )}
        aria-live="polite"
      >
        {openError ? `Could not open file: ${openError}` : ""}
      </p>
    </div>
  );
});

export const AssistantArtifactShelf = memo(function AssistantArtifactShelf(props: {
  markdown: string;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const disclosureId = useId();
  const artifacts = useMemo(
    () => extractMessageArtifacts(props.markdown, props.markdownCwd),
    [props.markdown, props.markdownCwd],
  );
  if (artifacts.length === 0) return null;

  const canCollapse = artifacts.length >= MIN_ARTIFACT_COUNT_TO_COLLAPSE;
  const alwaysVisibleArtifacts = canCollapse
    ? artifacts.slice(0, COLLAPSED_FULL_ARTIFACT_COUNT)
    : artifacts;
  const disclosedArtifacts = canCollapse ? artifacts.slice(COLLAPSED_FULL_ARTIFACT_COUNT) : [];
  const hiddenArtifactCount = disclosedArtifacts.length;
  const toggleLabel = expanded
    ? "Show fewer files"
    : `Show ${hiddenArtifactCount} more ${hiddenArtifactCount === 1 ? "file" : "files"}`;

  return (
    <section className="mt-3 font-system-ui" aria-label="Files cited in this response">
      <div className="mb-1.5 px-0.5 text-xs font-medium text-muted-foreground/65">
        {artifacts.length === 1 ? "File" : `${artifacts.length} files`}
      </div>
      <div className="overflow-visible rounded-xl border border-border/75 bg-[var(--color-background-elevated-primary)] shadow-xs">
        <div className="divide-y divide-border/65">
          {alwaysVisibleArtifacts.map((artifact) => (
            <AssistantArtifactRow
              key={artifact.path}
              artifact={artifact}
              workspaceRoot={props.workspaceRoot}
            />
          ))}
        </div>

        {canCollapse ? (
          <div className="relative">
            {!expanded ? (
              <div className="h-[60px] overflow-hidden border-t border-border/65">
                <div
                  aria-hidden="true"
                  className="pointer-events-none select-none opacity-55 [&_[data-artifact-actions]]:opacity-0"
                  inert
                >
                  <AssistantArtifactRow
                    artifact={disclosedArtifacts[0]!}
                    workspaceRoot={props.workspaceRoot}
                  />
                </div>
              </div>
            ) : null}

            <DisclosureRegion open={expanded}>
              <div
                id={disclosureId}
                className="divide-y divide-border/65 border-t border-border/65"
              >
                {disclosedArtifacts.map((artifact) => (
                  <AssistantArtifactRow
                    key={artifact.path}
                    artifact={artifact}
                    workspaceRoot={props.workspaceRoot}
                    loadHtmlThumbnail={expanded}
                  />
                ))}
              </div>
            </DisclosureRegion>

            <div
              className={cn(
                "relative z-10 flex justify-center bg-[var(--color-background-elevated-primary)] px-3 py-2",
                expanded
                  ? "border-t border-border/65"
                  : "absolute inset-x-0 bottom-0 shadow-[0_-12px_18px_var(--color-background-elevated-primary)]",
              )}
            >
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 rounded-full bg-[var(--color-background-elevated-primary)] px-3 text-xs font-medium"
                aria-controls={disclosureId}
                aria-expanded={expanded}
                onClick={() => setExpanded((current) => !current)}
              >
                {toggleLabel}
                {expanded ? (
                  <ChevronUpIcon aria-hidden="true" className="size-3.5" />
                ) : (
                  <ChevronDownIcon aria-hidden="true" className="size-3.5" />
                )}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
});
