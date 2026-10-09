// SCIENT-FORK:START — scientific refinements extend the shared markdown pipeline.
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REHYPE_PLUGINS_WITHOUT_RAW,
} from "../scient/markdown/scientMarkdownPipeline";
// SCIENT-FORK:END
import { extractFenceTitle } from "~/scient/presentation/CodeBlockTitle";
import { MarkdownCodeBlock } from "~/scient/presentation/MarkdownCodeBlock";
import { resolveInlineCssColor } from "~/scient/markdown/inlineCssColor";
import { ScientInlineColorCode } from "~/scient/markdown/ScientInlineColorCode";
import { MarkdownFindContext, useFindRevealRef } from "./chat/markdownFindContext";
import {
  buildFileLinkParentSuffixByPath,
  fileLinkLabel,
  resolvePathLinkTarget,
} from "@t3tools/shared/fileLinks";
import {
  isWindowsDrivePathHref,
  normalizeMarkdownLinkDestination,
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  inlineCodeFilePathCandidate,
} from "@t3tools/shared/markdownLinks";
import { isAbsolutePath } from "@t3tools/shared/path";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { AuthFilesystemReadScope, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  ChevronRightIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  LightbulbIcon,
  MailIcon,
  MessageSquareIcon,
  MessageSquareWarningIcon,
  OctagonAlertIcon,
  PresentationIcon,
  SparklesIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import {
  AuthPreviewOperateScope,
  type AssetResource,
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { Check, Copy, Maximize2, Minimize2 } from "lucide";
import { githubMediaFetchUrl } from "@t3tools/shared/githubMedia";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  codexArtifactTemplatePresentationLabel,
  type CodexArtifactTemplate,
  type CodexArtifactTemplateKind,
} from "@t3tools/shared/codexArtifactTemplates";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import { mediaFileReference, mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import { mediaKindFromPath, mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import React, {
  Children,
  type CSSProperties,
  type ComponentProps,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  isValidElement,
  use,
  useCallback,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Components,
  ExtraProps as ReactMarkdownExtraProps,
  Options as ReactMarkdownOptions,
} from "react-markdown";
import ReactMarkdown from "react-markdown";
import { createIncrementalMarkdownPlugin } from "../markdown-incremental";
import { defaultUrlTransform } from "react-markdown";
import { parseComposerCitationHref } from "@t3tools/shared/composerCitations";
import { AssistantCitationChip } from "./chat/AssistantCitationChip";
// SCIENT-FORK:START — a streaming answer is revealed line by line.
import { useStreamingBlockEntrance } from "./chat/useStreamingBlockEntrance";
// SCIENT-FORK:END
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";
import {
  parseEnvironmentQualifiedThreadLinkHref,
  parseThreadLinkHref,
  THREAD_LINK_PROTOCOL,
} from "@t3tools/shared/threadLinks";
import { MarkdownThreadLink } from "./chat/MarkdownThreadLink";
import {
  artifactTemplateFromHastProperties,
  renderCodexFileCitationsAsMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import { renderSkillInlineMarkdownChildren } from "./chat/SkillInlineText";
import {
  resolveMarkdownMediaPreview,
  type ExpandedImagePreview,
} from "./chat/ExpandedImagePreview";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { markdownImageGallery, markdownImageItems } from "./chat/markdownImageGallery";
import { MediaVideoPlayer } from "./media/MediaVideoPlayer";
import { MediaActions, type MediaActionSource } from "./media/MediaActions";
import { resolveProtocolRelativeMediaUrl } from "./media/mediaContent";
import { FileTagChipContent } from "./chat/FileTagChip";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "./preview/fileExplorerLabel";
import {
  resolveExternalWebLinkHost,
  showExternalLinkContextMenu,
} from "./chat/externalLinkContextMenu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { ContextChip } from "./ContextChip";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { ScrollArea } from "./ui/scroll-area";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { recordVisitForThread } from "../browserHistoryStore";
import {
  PreferredEditorEnvironmentRequiredError,
  useOpenInPreferredEditor,
  usePreferredEditor,
} from "../editorPreferences";
import { openInEditorMenuLabel } from "../editorLabels";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { GitHubIcon } from "./Icons";
import { RenderErrorBoundary } from "./RenderErrorBoundary";

import { useTheme } from "../hooks/useTheme";
import { useClientSettings } from "../hooks/useSettings";
import {
  chatMarkdownClipboardPayload,
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from "../markdown-clipboard";
import {
  markdownLinkLookupKey,
  resolveInlineCodeFileLinkMeta,
  markdownFileLinkRelativeCopyPath,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  shouldOpenMarkdownFileLinkInEditor,
  type MarkdownFileLinkMeta,
} from "../markdown-links";
import { isMarkdownFileLinkLabel } from "@t3tools/shared/markdownLinks";
import { readLocalApi } from "../localApi";
import { useAssetUrlRefresh, useAssetUrlState } from "../assets/assetUrls";
import { cn } from "../lib/utils";
import { useRemoteOpenResolution, type RemoteOpenMode } from "../remoteOpen";
import { useRightPanelStore } from "../rightPanelStore";
import { readThreadShell, useProjects } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { shellEnvironment } from "../state/shell";
import { assetEnvironment } from "../state/assets";
import { readEnvironmentScope, usePreparedConnection, useEnvironmentScope } from "../state/session";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { projectEnvironment } from "../state/projects";
import {
  needsWorkspaceBasenameLookup,
  pickWorkspaceBasenameMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "../workspaceBasenameLookup";
import {
  parseChangeRequestUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  resolvePullRequestPreviewTarget,
  useOpenChangeRequestLink,
} from "~/lib/openPullRequestLink";
import { useOpenLink } from "../browser/useOpenLink";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import {
  copyFilePathToClipboard,
  filePathCopyTitle,
  type FilePathCopyFormat,
} from "./files/filePathClipboard";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
import {
  openFileInPreview,
  openUrlInPreview,
  BrowserPreviewUnavailableError,
  resolveWorkspaceFileLinkOpenTarget,
  BrowserSettingsReadError,
} from "../browser/openFileInPreview";
import {
  resolvePlainTextBoxDirection,
  resolveFenceDirection,
  type ContentDirection,
  type FixedContentDirection,
} from "../scient/bidi/contentDirection";
import { useChatContentDirection } from "../scient/bidi/useChatContentDirection";
import { rehypeScientBidi } from "../scient/bidi/rehypeScientBidi";
import "../scient/bidi/scient-bidi.css";
import {
  resolveScientRichFenceKind,
  ScientRichFence,
} from "../scient/presentation/ScientRichFence";
import { ScientDirectImageFigure } from "../scient/images/ScientDirectImageFigure";
import {
  ScientMarkdownSource,
  scientWorkspaceImageCard,
  useScientRemoteImageReference,
} from "../scient/images/scientMarkdownImage";
import {
  inlineWorkspaceImageMarkdownSource,
  inlineWorkspaceImageResource,
  resolveInlineWorkspaceImage,
} from "../scient/images/inlineWorkspaceImage";
import { isScientMathCodeClassName } from "../scient/math/remarkScientMath";
import {
  useScientMathMarkdownText,
  useScientMathRemarkPlugins,
} from "../scient/math/scientMathText";
// SCIENT-FORK:START — the rich clipboard renders a message with chat's own pipeline
import {
  normalizeScientMathDelimiters,
  scientMathRemarkPlugins,
} from "../scient/math/scientMathText";
// SCIENT-FORK:END
import { ScientDisplayMath, ScientInlineMath } from "../scient/math/ScientMath";
import { ScientMathFindSurface } from "../scient/math/ScientMathFindSurface";
import {
  useChatEnvironmentHtmlPreview,
  useChatFileLinkOpening,
} from "../scient/fileOpening/useChatFileLinkOpening";
import { environmentFileLinkResolution } from "../scient/fileOpening/environmentFileState";
import { resolveLinkTarget } from "../browser/browserLinkTarget";
import { PullRequestLinkPreview } from "./pullRequest/PullRequestLinkPreview";

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  /** Root whose descendants belong to the editable workspace; null keeps resolved links external. */
  fileLinkWorkspaceRoot?: string | null;
  threadRef?: ScopedThreadRef | undefined;
  /** Panel that receives pull request links, including the standalone PR view. */
  pullRequestPanelRef?: ScopedThreadRef | undefined;
  /** Environment that owns non-thread markdown, such as a pull request panel. */
  environmentId?: EnvironmentId | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
  isStreaming?: boolean;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  className?: string;
  /** Treat single newlines as hard breaks — chat-style user input. */
  lineBreaks?: boolean;
  /** Overrides the conversation scope for document/file previews. */
  contentDirection?: ContentDirection;
  /** Stable identity used to scope automatic streaming direction. */
  messageId?: MessageId | undefined;
  /** Direction hint from the preceding user message during streaming. */
  directionHint?: FixedContentDirection | null | undefined;
  /** Parse sanitized raw HTML instead of displaying its source text. */
  parseRawHtml?: boolean;
  /** Append a prompt that invokes a newly created artifact-template skill. */
  onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  /** Run a complete shell code fence in the thread terminal. */
  onRunShellCommand?: ((command: string) => void) | undefined;
  /** Directory that anchors relative links and images; defaults to `cwd`. Set
      to the file's own directory when rendering a markdown file. */
  imageBaseDir?: string | undefined;
  /** File previews share the rich editor's standalone title-as-caption presentation. */
  imageCaptions?: boolean | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  extraRemarkPlugins?: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  /** Renders a `t3-context://` link as a chip; without it the link shows its label as text. */
  renderContextReference?: ((reference: ChatMarkdownContextReference) => ReactNode) | undefined;
  /** Loads GitHub-hosted media through `cwd`'s GitHub credential, which a private repository's
      uploads need; without it those images and videos load unauthenticated and 404. */
  githubMedia?: boolean | undefined;
  /** Files the turn that produced this message changed, relative to `cwd`. A
      link whose location does not exist resolves to one of them only when it
      names exactly one; see `pickChangedFileForLink`. */
  changedFiles?: ReadonlyArray<{ readonly path: string }> | undefined;
  /** Levels added to each markdown heading in the accessibility tree so the
      text nests under the heading that introduces it, such as a chat message's
      author. Rendered tags and their styling are unchanged. */
  headingLevelOffset?: number | undefined;
}

export interface ChatMarkdownContextReference {
  kind: string;
  contextId: string;
  label: string;
}

export function canUseMarkdownFileShellActions(
  environmentId: EnvironmentId | null,
  remoteOpenMode: RemoteOpenMode,
  isRemoteOpenResolved: boolean,
): boolean {
  return environmentId !== null && isRemoteOpenResolved && remoteOpenMode === "local-exec";
}

export function hasMarkdownFilePrimaryAction(input: {
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
  canOpenInPanel: boolean;
  canOpenMedia?: boolean;
}): boolean {
  return (
    input.canOpenInEditor ||
    input.canOpenInBrowser ||
    input.canOpenInPanel ||
    input.canOpenMedia === true
  );
}

export function shouldUseMarkdownFileBrowserPrimaryAction(input: {
  canOpenInBrowser: boolean;
}): boolean {
  // The caller supplies this action only when the canonical workspace-file
  // policy selected Browser preview. Do not duplicate extension policy here.
  return input.canOpenInBrowser;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const EMPTY_REMARK_PLUGINS: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [];

const ARTIFACT_TEMPLATE_ICON_BY_KIND = {
  document: FileTextIcon,
  presentation: PresentationIcon,
  spreadsheet: FileSpreadsheetIcon,
  site: GlobeIcon,
  "google-docs": FileTextIcon,
  "google-slides": PresentationIcon,
  "google-sheets": FileSpreadsheetIcon,
  image: ImageIcon,
  email: MailIcon,
  slack: MessageSquareIcon,
} satisfies Record<CodexArtifactTemplateKind, LucideIcon>;

function CodexArtifactTemplateCard(props: {
  readonly template: CodexArtifactTemplate;
  readonly onUse?: ((template: CodexArtifactTemplate) => void) | undefined;
}) {
  const Icon = ARTIFACT_TEMPLATE_ICON_BY_KIND[props.template.artifactKind];
  const presentationLabel = codexArtifactTemplatePresentationLabel(props.template.artifactKind);

  return (
    <div
      role="group"
      aria-label={`${props.template.displayName} template`}
      className="my-[0.65rem] flex w-full min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-foreground shadow-xs"
      data-chat-markdown-artifact-template
      data-artifact-kind={props.template.artifactKind}
      data-markdown-copy={`${props.template.displayName} (${presentationLabel})\n\n`}
      data-skill-name={props.template.skillName}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground shadow-xs">
          <Icon aria-hidden className="size-5" />
          <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border border-background bg-primary text-primary-foreground shadow-xs">
            <SparklesIcon aria-hidden className="size-2.5" />
          </span>
        </span>
        {/* Block elements keep the name and label separate thread-find segments. */}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {props.template.displayName}
          </div>
          <div className="text-xs text-muted-foreground">{presentationLabel}</div>
        </div>
      </div>
      {props.onUse ? (
        <Button
          data-thread-find-ignore
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => props.onUse?.(props.template)}
        >
          Use template
        </Button>
      ) : null}
    </div>
  );
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;

interface MarkdownActionFailureContext {
  readonly operation: string;
  readonly target?: string;
  readonly format?: "markdown" | "csv";
  readonly language?: string;
  readonly fenceTitle?: string;
  readonly copyTarget?: string;
}

function reportMarkdownActionFailure(context: MarkdownActionFailureContext, cause: unknown): void {
  console.error("[chat-markdown] action failed", context, cause);
}

function findTaskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
  if (!match?.[1]) return null;
  return listItemStart + firstLine.indexOf(match[1]);
}

/**
 * The default `1.25rem` marker gutter (`.chat-markdown ol`) fits one-character
 * markers. Wider markers can extend past it and get clipped by a collapsed
 * message's overflow. Widen the gutter to fit the widest marker, including a
 * negative marker's minus sign, the period, and the trailing space.
 */
function orderedListGutterStyle(
  itemCount: number,
  start: unknown,
): { "--list-gutter": string } | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  const firstNumber = Number.isNaN(parsedStart) ? 1 : parsedStart;
  const lastNumber = firstNumber + Math.max(itemCount - 1, 0);
  const markerWidth = Math.max(String(firstNumber).length, String(lastNumber).length);
  if (markerWidth <= 1) return undefined;
  return { "--list-gutter": `${markerWidth + 2}ch` };
}

// SCIENT-FORK:START — the Copy message button's rich flavour renders with chat's own pipeline
/**
 * Chat's math text normalization and remark and rehype steps for one message,
 * without its React components. Direction runs after these, as in `ChatMarkdown`.
 */
export function chatMarkdownPipeline(input: {
  readonly text: string;
  readonly lineBreaks: boolean;
  readonly parseRawHtml: boolean;
}): {
  readonly text: string;
  readonly remarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  readonly rehypePlugins: NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
} {
  return {
    text: normalizeScientMathDelimiters(input.text),
    remarkPlugins: scientMathRemarkPlugins(
      input.lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS,
      input.text,
    ),
    rehypePlugins: input.parseRawHtml
      ? CHAT_MARKDOWN_REHYPE_PLUGINS
      : CHAT_MARKDOWN_REHYPE_PLUGINS_WITHOUT_RAW,
  };
}

/** The direction chat gives a code or plain-text box, from its content and fence metadata. */
function chatCodeBoxDirection(input: {
  readonly code: string;
  readonly language: string;
  readonly fenceMeta: string | undefined;
  readonly conversationDirection: ContentDirection;
  readonly isStreaming: boolean;
}): "auto" | "rtl" | "ltr" {
  return resolvePlainTextBoxDirection({
    code: input.code,
    language: input.language,
    fenceTitle: extractFenceTitle(input.fenceMeta),
    fenceDirection: resolveFenceDirection(input.fenceMeta),
    conversationDirection: input.conversationDirection,
    isStreaming: input.isStreaming,
  });
}

/** Math normalization preserves offsets, so Find can index the authored token. */
function authoredMathNodeSource(
  node: ReactMarkdownExtraProps["node"],
  authoredText: string,
  tex: string,
): string {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  return start !== undefined && end !== undefined ? authoredText.slice(start, end) : tex;
}

/** Chat's plain text of rendered Markdown children, as its math renderers read TeX. */
export function chatMarkdownNodeText(node: ReactNode): string {
  return nodeToPlainText(node);
}

/** The title chat shows for a GitHub alert kind, or null when it is not an alert. */
export function chatMarkdownAlertLabel(kind: unknown): string | null {
  return GITHUB_ALERT_PRESENTATIONS[String(kind ?? "")]?.label ?? null;
}

/**
 * `chatCodeBoxDirection` for a rendered `pre` node of a completed message;
 * null when it is not a fenced code block or is display math.
 */
export function chatMarkdownCodeBoxDirection(
  node: unknown,
  children: ReactNode,
  conversationDirection: ContentDirection,
): "auto" | "rtl" | "ltr" | null {
  const codeBlock = extractCodeBlock(children);
  if (!codeBlock || isScientMathCodeClassName(codeBlock.className)) return null;
  return chatCodeBoxDirection({
    code: codeBlock.code,
    language: extractFenceLanguage(codeBlock.className),
    fenceMeta: extractPreCodeMeta(node),
    conversationDirection,
    isStreaming: false,
  });
}
// SCIENT-FORK:END

/** GitHub's own five alert kinds, in its colors: the glyph names the urgency, the title says it. */
const GITHUB_ALERT_PRESENTATIONS: Record<
  string,
  { label: string; Icon: typeof InfoIcon; borderClassName: string; titleClassName: string }
> = {
  note: {
    label: "Note",
    Icon: InfoIcon,
    borderClassName: "border-blue-500/70",
    titleClassName: "text-blue-600 dark:text-blue-400",
  },
  tip: {
    label: "Tip",
    Icon: LightbulbIcon,
    borderClassName: "border-emerald-500/70",
    titleClassName: "text-emerald-600 dark:text-emerald-400",
  },
  important: {
    label: "Important",
    Icon: MessageSquareWarningIcon,
    borderClassName: "border-purple-500/70",
    titleClassName: "text-purple-600 dark:text-purple-400",
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlertIcon,
    borderClassName: "border-amber-500/70",
    titleClassName: "text-amber-600 dark:text-amber-500",
  },
  caution: {
    label: "Caution",
    Icon: OctagonAlertIcon,
    borderClassName: "border-red-500/70",
    titleClassName: "text-red-600 dark:text-red-400",
  },
};

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === "gitignore" ? "ini" : raw;
}

function extractPreCodeMeta(node: unknown): string | undefined {
  const children = (
    node as
      | {
          children?: Array<{
            type?: string;
            tagName?: string;
            data?: { meta?: unknown };
            properties?: { dataCodeMeta?: unknown };
          }>;
        }
      | undefined
  )?.children;
  const codeNode = children?.find((child) => child?.type === "element" && child.tagName === "code");
  const meta = codeNode?.properties?.dataCodeMeta ?? codeNode?.data?.meta;
  return typeof meta === "string" && meta.trim().length > 0 ? meta.trim() : undefined;
}

function isClosedCodeFence(node: ReactMarkdownExtraProps["node"], text: string): boolean {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  const source = text.slice(start, end);
  const opening = /^(?:`{3,}|~{3,})/.exec(source)?.[0];
  const closing = /(?:^|\n)[ \t>]*(`{3,}|~{3,})[ \t\r]*$/.exec(source)?.[1];
  return (
    opening !== undefined &&
    closing !== undefined &&
    opening[0] === closing[0] &&
    closing.length >= opening.length
  );
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode; node?: { tagName?: string } }>(
      onlyChild,
    )
  ) {
    return null;
  }
  // With a custom `code` component the child's type is that component, not
  // the "code" tag — the hast node react-markdown attaches still names it.
  if (onlyChild.type !== "code" && onlyChild.props.node?.tagName !== "code") {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function MarkdownTable({ children, dir, ...props }: React.ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Tables open with wrapped cells so every value is readable in place. The
  // global word-wrap preference is a code/diff setting and does not apply here;
  // the footer toggle switches this table to single-line cells that scroll.
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tableDirection = dir === "rtl" ? "rtl" : "ltr";
  const expandLabel = expanded ? "Collapse table cells" : "Expand table cells";
  const copyLabel = copied ? "Copied" : "Copy table";

  function toggleExpanded() {
    setExpanded((value) => !value);
  }

  const handleCopy = useCallback((format: "markdown" | "csv") => {
    const table = containerRef.current?.querySelector("table");
    if (!table || typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    const text =
      format === "markdown"
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table);
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMarkdownActionFailure({ operation: "copy-table", format }, cause);
      });
  }, []);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="chat-markdown-table-container"
      data-expanded={expanded ? "true" : "false"}
      dir={tableDirection}
    >
      <ScrollArea
        radius="none"
        chainVerticalScroll
        scrollFade
        className="w-full max-w-full"
        dir={tableDirection}
      >
        <table {...props} dir={tableDirection}>
          {children}
        </table>
      </ScrollArea>
      <div className="mt-0.5 flex items-center justify-between select-none">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant={expanded ? "secondary" : "ghost-muted"}
                size="icon-xs"
                aria-pressed={expanded}
                onClick={toggleExpanded}
                aria-label={expandLabel}
              />
            }
          >
            <MorphIcon className="size-3" icon={expanded ? Minimize2 : Maximize2} />
          </TooltipTrigger>
          <TooltipPopup side="top">{expandLabel}</TooltipPopup>
        </Tooltip>
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label={copyLabel}
                    />
                  }
                />
              }
            >
              <MorphIcon className="size-3" icon={copied ? Check : Copy} />
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

function MarkdownDetails({
  children,
  open = false,
}: Pick<React.ComponentProps<"details">, "children" | "open">) {
  const [isOpen, setIsOpen] = useState(open);
  const searching = use(MarkdownFindContext);
  const expanded = isOpen;
  const revealForFind = useCallback(() => setIsOpen(true), []);
  // Base UI only listens for `beforematch` on a panel mounted at its first
  // render; a closed panel mounts later, when find starts, so listen here.
  const findRevealRef = useFindRevealRef(revealForFind);
  const childNodes = Children.toArray(children);
  const summaryIndex = childNodes.findIndex(
    (child) => isValidElement(child) && child.type === "summary",
  );
  const summaryNode = summaryIndex >= 0 ? childNodes[summaryIndex] : null;
  const summary =
    isValidElement<{ children?: ReactNode }>(summaryNode) && summaryNode.props.children
      ? summaryNode.props.children
      : "Details";
  const content = childNodes.filter((_, index) => index !== summaryIndex);

  return (
    <div className="my-2 border-y border-border/60">
      <Collapsible
        open={expanded}
        onOpenChange={setIsOpen}
        data-markdown-details=""
        data-markdown-details-open={expanded ? "true" : "false"}
      >
        <CollapsibleTrigger
          className="flex w-full items-center gap-2 py-2 text-left text-sm font-medium text-foreground data-panel-open:[&_svg]:rotate-90"
          data-markdown-details-summary=""
        >
          <ChevronRightIcon
            className="size-4 shrink-0 text-muted-foreground transition-transform"
            aria-hidden
          />
          <span>{summary}</span>
        </CollapsibleTrigger>
        <CollapsiblePanel ref={findRevealRef} hiddenUntilFound={searching}>
          <div
            className="pb-3 ps-6 text-foreground/[calc(80%+var(--appearance-contrast-boost)/5)]"
            data-markdown-details-content=""
          >
            {content}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

interface MarkdownFileLinkProps {
  href: string;
  targetPath: string;
  iconPath: string;
  /** Workspace-relative path with line position; null outside the workspace. */
  relativeCopyPath: string | null;
  /** What the files panel opens: workspace-relative inside the workspace, the
      absolute host path outside it, null when the panel cannot show the file. */
  panelPath: string | null;
  line?: number | undefined;
  label: string;
  copyMarkdown: string;
  theme: "light" | "dark";
  threadRef?: ScopedThreadRef | undefined;
  onOpen?: ((targetPath: string) => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  onOpenInPanel: (panelPath: string, line: number | undefined) => void;
  openInEditorMenuLabel: string;
  onOpenInBrowser?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  onOpenMedia?: (() => void) | undefined;
  onReveal?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  /** Platform-specific menu label ("Reveal in Finder", ...); required for the
      reveal item to show. */
  revealLabel?: string | undefined;
}

const MARKDOWN_FILE_LINK_CLASS_NAME = "chat-markdown-file-link";

function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const rewrittenHref = rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
  return WINDOWS_DRIVE_PATH_REGEX.test(rewrittenHref)
    ? rewrittenHref.replaceAll("\\", "/")
    : rewrittenHref;
}

const normalizeMarkdownLinkHref = normalizeMarkdownLinkHrefKey;

const MARKDOWN_LINK_FAVICON_CLASS_NAME = "block size-full shrink-0 select-none";

/** Sites whose brand mark (drawn in `currentColor`) replaces the fetched favicon so it follows the theme. */
function brandLinkIcon(host: string): typeof GitHubIcon | null {
  const hostname = host.toLowerCase();
  if (hostname === "github.com" || hostname.endsWith(".github.com")) return GitHubIcon;
  return null;
}

// SCIENT-FORK:START — link icons are drawn locally; a fetched favicon would tell a third
// party which links a conversation holds, and when it was opened.
const MarkdownLinkFavicon = memo(function MarkdownLinkFavicon({ host }: { host: string }) {
  return (
    <span
      className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
      aria-hidden
    >
      {brandLinkIcon(host) ? (
        <GitHubIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />
      ) : (
        <GlobeIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />
      )}
    </span>
  );
});
// SCIENT-FORK:END

const CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME = "max-w-[min(100%,30rem)]";
const CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME = cn(
  "max-h-[30rem]",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
);
const CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME = "inline-block!";
const CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME = "rounded-lg border border-border/40";
const CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME = cn(
  "h-auto w-auto object-contain",
  CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
);

/**
 * `maxHeightRem` folds a height cap into the width bound: `max-height` alone
 * would not feed back through `aspect-ratio` once `width` is definite, so a
 * tall image would keep a box wider than the picture it draws.
 */
function authoredImageSizeStyle(
  width: string | number | undefined,
  height: string | number | undefined,
  maxHeightRem = 30,
): CSSProperties | undefined {
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  const hasWidth = Number.isFinite(parsedWidth) && parsedWidth > 0;
  const hasHeight = Number.isFinite(parsedHeight) && parsedHeight > 0;
  if (hasWidth && hasHeight) {
    return {
      width: parsedWidth,
      height: "auto",
      aspectRatio: `${parsedWidth} / ${parsedHeight}`,
      maxWidth: `min(100%, 30rem, ${(maxHeightRem * parsedWidth) / parsedHeight}rem)`,
    };
  }
  if (hasWidth) return { maxWidth: `min(100%, 30rem, ${parsedWidth}px)` };
  if (hasHeight) return { maxHeight: `min(30rem, ${parsedHeight}px)` };
  return undefined;
}

const CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME = cn(
  CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);
const MarkdownLinkContext = React.createContext(false);

function expandableMarkdownImageProps(
  onImageExpand: ((preview: ExpandedImagePreview) => void) | undefined,
  alt: string,
) {
  if (!onImageExpand) return {};
  const previewName = alt.trim() || "image";
  const expand = (event: ReactMouseEvent | ReactKeyboardEvent) => {
    if (event.currentTarget.closest("a")) return;
    event.preventDefault();
    event.stopPropagation();
    const item = markdownImageItems.get(event.currentTarget);
    if (item) onImageExpand(markdownImageGallery(event.currentTarget, item));
  };
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Preview ${previewName}`,
    onClick: expand,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") expand(event);
    },
  };
}

function ChatMarkdownMediaUnavailableLabel(props: {
  readonly alt: string;
  readonly kind?: "image" | "video" | undefined;
}) {
  const label = props.kind === "video" ? "Video unavailable" : "Image unavailable";
  return (
    // Find indexes no image text, so this fallback must not highlight either.
    <span data-thread-find-ignore className="inline-flex items-center gap-1.5">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      {props.alt.length > 0 ? `${label} · ${props.alt}` : label}
    </span>
  );
}

/** Inline chip for an image that sits in a line of text or can never load. */
function ChatMarkdownImageFallback(props: {
  readonly alt: string;
  readonly copyMarkdown?: string | undefined;
  readonly kind?: "image" | "video";
  readonly actionsSource?: MediaActionSource | undefined;
}) {
  const content = (
    <span
      data-markdown-copy={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        "rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground",
      )}
    >
      <ChatMarkdownMediaUnavailableLabel alt={props.alt} kind={props.kind} />
    </span>
  );
  return props.actionsSource ? (
    <MediaActions source={props.actionsSource}>{content}</MediaActions>
  ) : (
    content
  );
}

const CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME = cn(
  "aspect-video w-full overflow-hidden bg-muted/60",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);

/**
 * A standalone image holds a 16:9 slot (or its authored size) until it has
 * decoded, and keeps that slot if it fails, so a timeline row moves at most
 * once: when the natural size arrives. A bare `<img>` is zero height until
 * then. Once decoded the image renders bare again so its box, hit area, and
 * alignment are exactly the image's own. Inline images (badges, icons in a
 * sentence) skip the slot: a placeholder taller than the image would move the
 * page more than the image does.
 *
 * Callers key this on the file's identity, not its URL: a re-signed URL for
 * the same file keeps the decoded image on screen while the new bytes arrive,
 * and a different file starts from the slot again.
 */
function ChatMarkdownImage(props: {
  /** Null while the URL is being resolved; the last decoded image stays up. */
  readonly src: string | null;
  readonly sourceFailed?: boolean | undefined;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly standalone: boolean;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  /** Sanitized authored attributes (`id`, `align`, …) that fragment links and layout rely on. */
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  readonly actionsSource: MediaActionSource;
  readonly originalUrl?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = props.src ?? loadedSrc;
  const failed = props.sourceFailed === true || (src !== null && failedSrc === src);
  // A failure forgets the decoded image so the next URL loads behind the slot.
  const settled = src !== null && !failed && (!props.standalone || loadedSrc !== null);
  // Cached images are complete before `onLoad` can fire.
  const markLoadedIfComplete = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image) return;
      if (image.complete && image.naturalWidth > 0) setLoadedSrc(image.currentSrc || image.src);
      markdownImageItems.set(image, {
        src,
        name: props.alt.trim() || "image",
        actionsSource: props.actionsSource,
        ...(props.originalUrl ? { originalUrl: props.originalUrl } : {}),
      });
    },
    [props.actionsSource, props.alt, props.originalUrl, src],
  );
  const imageEvents = (loadingSrc: string) => ({
    onLoad: () => {
      setLoadedSrc(loadingSrc);
      setFailedSrc(null);
    },
    onError: () => {
      setFailedSrc(loadingSrc);
      setLoadedSrc(null);
    },
  });

  if (settled) {
    return (
      <MediaActions source={props.actionsSource}>
        <img
          {...props.imageProps}
          ref={markLoadedIfComplete}
          src={src}
          alt={props.alt}
          data-markdown-copy={props.copyMarkdown}
          decoding="async"
          draggable={false}
          className={cn(
            CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME,
            props.className,
            props.onImageExpand && "cursor-zoom-in",
          )}
          style={props.style}
          {...expandableMarkdownImageProps(props.onImageExpand, props.alt)}
          {...imageEvents(src)}
        />
      </MediaActions>
    );
  }
  if (!props.standalone) {
    return failed ? (
      <ChatMarkdownImageFallback
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        actionsSource={props.actionsSource}
      />
    ) : (
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        role="status"
        aria-label="Loading image"
        className={CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME}
      />
    );
  }
  return (
    <MediaActions source={props.actionsSource}>
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        className={cn(
          CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
          CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME,
          "relative",
        )}
        style={props.style}
        {...(failed
          ? { role: "alert" as const }
          : { role: "status" as const, "aria-label": "Loading image" })}
      >
        {failed ? (
          <span className="flex size-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
            <ChatMarkdownMediaUnavailableLabel alt={props.alt} />
          </span>
        ) : src !== null ? (
          <img
            ref={markLoadedIfComplete}
            src={src}
            alt={props.alt}
            decoding="async"
            draggable={false}
            className="invisible absolute inset-0 size-full"
            {...imageEvents(src)}
          />
        ) : null}
      </span>
    </MediaActions>
  );
}

function ChatMarkdownVideo(props: {
  readonly src: string | null;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly originalUrl?: string | undefined;
  readonly sourceFailed?: boolean | undefined;
  readonly style?: CSSProperties | undefined;
  readonly mediaIdentity?: string | undefined;
  readonly actionsSource?: MediaActionSource | undefined;
  readonly onRetry?: (() => Promise<unknown>) | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  return (
    <MediaVideoPlayer
      key={props.mediaIdentity ?? props.copyMarkdown ?? props.src}
      src={props.src}
      sourceFailed={props.sourceFailed}
      label={props.alt}
      originalUrl={props.originalUrl}
      style={props.style}
      copyMarkdown={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
        "w-full",
      )}
      videoClassName={cn(
        CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
      )}
      onRetry={props.onRetry}
      actionsSource={props.actionsSource}
      onExpand={
        props.onImageExpand
          ? (src) => {
              props.onImageExpand?.({
                images: [
                  {
                    src,
                    name: props.alt || "video",
                    type: "video",
                    autoPlay: false,
                    ...(props.originalUrl ? { originalUrl: props.originalUrl } : {}),
                    ...(props.actionsSource
                      ? { actionsSource: { ...props.actionsSource, src } }
                      : {}),
                  },
                ],
                index: 0,
              });
            }
          : undefined
      }
    />
  );
}

/** Environment-hosted media loads through an exact-file signed asset URL. */
export const ChatMarkdownAssetImage = memo(function ChatMarkdownAssetImage(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: Extract<
    AssetResource,
    {
      readonly _tag:
        | "attachment"
        | "workspace-file"
        | "media-file"
        | "github-media"
        | "tool-output-image";
    }
  >;
  readonly kind?: "image" | "video";
  readonly alt: string;
  readonly copyMarkdown?: string;
  readonly srcFragment?: string;
  /** Reserve a slot while loading; off for images that share a line with text. */
  readonly standalone?: boolean | undefined;
  /** Caps the box height in rem while keeping the image's ratio; 30 by default. */
  readonly maxHeightRem?: number | undefined;
  readonly style?: CSSProperties | undefined;
  readonly className?: string | undefined;
  /** Sanitized authored attributes (`id`, `align`, …) that fragment links and layout rely on. */
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  /** Where the media also lives on the web, for the failure state's escape hatch. */
  readonly originalUrl?: string | undefined;
  /** The workspace media frame, on by default; off for media that keeps the author's own box. */
  readonly framed?: boolean | undefined;
  /** Loaded instead of the failure state when no URL can be signed, such as against a server
      too old to know this resource. Only safe when the client can reach it directly. */
  readonly fallbackSrc?: string | undefined;
  // SCIENT-FORK:START — shown instead of the failure state, before any `fallbackSrc`
  readonly failureFallback?: ReactNode | undefined;
  // SCIENT-FORK:END
  readonly workspaceRoot?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, props.resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, props.resource);
  const resource = props.resource;
  const path =
    resource._tag === "media-file"
      ? resource.path
      : resource._tag === "workspace-file"
        ? resource.path && isAbsolutePath(resource.path)
          ? resource.path
          : resource.cwd && resource.relativePath
            ? `${resource.cwd.replace(/[\\/]+$/, "")}/${resource.relativePath.replace(/^[\\/]+/, "")}`
            : resource.path && props.workspaceRoot
              ? `${props.workspaceRoot.replace(/[\\/]+$/, "")}/${resource.path.replace(/^[\\/]+/, "")}`
              : resource.path
        : undefined;
  const reference = path
    ? mediaFileReference(path, props.workspaceRoot)
    : props.originalUrl
      ? mediaUrlReference(props.originalUrl)
      : undefined;
  const relativePath = reference?.kind === "file" ? reference.relativePath : undefined;
  const threadId =
    resource._tag === "workspace-file" || resource._tag === "media-file"
      ? resource.threadId
      : undefined;
  // SCIENT-FORK:START — an unsignable web asset becomes a link card, not a direct fetch
  if (assetUrl._tag === "Failure" && props.failureFallback !== undefined) {
    return props.failureFallback;
  }
  // SCIENT-FORK:END
  const fallbackSrc = assetUrl._tag === "Failure" ? props.fallbackSrc : undefined;
  const src =
    assetUrl._tag === "Success"
      ? assetUrl.url + (props.srcFragment ?? "")
      : fallbackSrc === undefined
        ? null
        : fallbackSrc + (props.srcFragment ?? "");
  // The server reads the pixel size from the file header, so the slot can be
  // the image's final box instead of a 16:9 guess. An authored size wins; a
  // caller's height cap shrinks the box while keeping the ratio.
  const knownSize = assetUrl._tag === "Success" ? assetUrl.imageDimensions : undefined;
  const maxHeightRem = props.maxHeightRem ?? 30;
  const style =
    props.style ??
    (knownSize
      ? authoredImageSizeStyle(knownSize.width, knownSize.height, maxHeightRem)
      : maxHeightRem !== 30
        ? { maxHeight: `${maxHeightRem}rem` }
        : undefined);
  const actionsSource: MediaActionSource = {
    kind: props.kind ?? "image",
    name: props.alt || (props.kind ?? "image"),
    src,
    ...(fallbackSrc === undefined
      ? { asset: { environmentId: props.environmentId, resource } }
      : {}),
    ...(reference ? { reference } : {}),
    ...(relativePath && threadId
      ? {
          onOpenFile: () =>
            useRightPanelStore
              .getState()
              .openFile({ environmentId: props.environmentId, threadId }, relativePath),
        }
      : {}),
  };

  if (props.kind === "video") {
    return (
      <ChatMarkdownVideo
        src={src}
        sourceFailed={assetUrl._tag === "Failure" && fallbackSrc === undefined}
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        originalUrl={props.originalUrl}
        style={props.style}
        mediaIdentity={JSON.stringify([props.environmentId, props.resource, props.srcFragment])}
        onRetry={refreshAssetUrl}
        onImageExpand={props.onImageExpand}
        actionsSource={actionsSource}
      />
    );
  }

  return (
    <ChatMarkdownImage
      key={JSON.stringify([props.environmentId, props.resource, props.srcFragment])}
      src={src}
      sourceFailed={assetUrl._tag === "Failure" && fallbackSrc === undefined}
      alt={props.alt}
      copyMarkdown={props.copyMarkdown}
      standalone={props.standalone ?? true}
      className={cn(
        props.framed === false ? undefined : CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME,
        props.className,
      )}
      style={style}
      imageProps={props.imageProps}
      actionsSource={actionsSource}
      originalUrl={props.originalUrl}
      onImageExpand={props.onImageExpand}
    />
  );
});

function leadingExternalLinkTextLength(text: string): number {
  const protocol = /^(?:https?:\/\/)/i.exec(text)?.[0];
  if (protocol) return protocol.length;
  return Math.min(text.length, 1);
}

function breakableExternalLinkText(text: string): ReactNode[] {
  return Array.from(text, (character, index) => (
    <React.Fragment key={`${index}:${character}`}>
      {character}
      <wbr />
    </React.Fragment>
  ));
}

function plainHastText(node: unknown): string | null {
  if (!node || typeof node !== "object" || !("children" in node) || !Array.isArray(node.children)) {
    return null;
  }
  const parts = node.children.map((child) => {
    if (
      child &&
      typeof child === "object" &&
      "type" in child &&
      child.type === "text" &&
      "value" in child &&
      typeof child.value === "string"
    ) {
      return child.value;
    }
    return null;
  });
  return parts.every((part) => part !== null) ? parts.join("") : null;
}

/**
 * The anchor's words, gathered through any nesting. A context label that picked up emphasis or a
 * code span still has to read as its label; `plainHastText` gives up on the first non-text child,
 * which would leave the raw context id showing in its place.
 */
function hastPlainTextDeep(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  if ("type" in node && node.type === "text" && "value" in node && typeof node.value === "string") {
    return node.value;
  }
  if (!("children" in node) || !Array.isArray(node.children)) return "";
  return node.children.map(hastPlainTextDeep).join("");
}

/**
 * Whether the link carries any words of its own. An anchor that is only an image — a badge, a
 * "Fix in Cursor" button — already shows its identity, and a favicon bolted on in front of it
 * is a stray logo rather than a hint.
 */
function hastHasText(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (
    "type" in node &&
    node.type === "text" &&
    "value" in node &&
    typeof node.value === "string" &&
    node.value.trim().length > 0
  ) {
    return true;
  }
  return "children" in node && Array.isArray(node.children) && node.children.some(hastHasText);
}

const SANITIZED_FRAGMENT_PREFIX = "user-content-";

function decodeMarkdownFragmentId(href: string): string {
  const encodedId = href.slice(1);
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return encodedId;
  }
}

function normalizeSanitizedFragmentId(id: string): string {
  let normalizedId = id;
  while (normalizedId.startsWith(SANITIZED_FRAGMENT_PREFIX)) {
    normalizedId = normalizedId.slice(SANITIZED_FRAGMENT_PREFIX.length);
  }
  return normalizedId;
}

function findMarkdownFragmentTarget(anchor: HTMLAnchorElement, href: string): HTMLElement | null {
  const decodedId = decodeMarkdownFragmentId(href);
  const normalizedId = normalizeSanitizedFragmentId(decodedId);
  const matchesFragment = (element: HTMLElement) =>
    element.id === decodedId || normalizeSanitizedFragmentId(element.id) === normalizedId;
  const markdownRoot = anchor.closest<HTMLElement>(".chat-markdown");
  if (markdownRoot) {
    const localTargets = Array.from(markdownRoot.querySelectorAll<HTMLElement>("[id]"));
    const localTarget = localTargets.find(matchesFragment);
    if (localTarget) return localTarget;
  }

  return (
    document.getElementById(decodedId) ??
    Array.from(document.querySelectorAll<HTMLElement>("[id]")).find(matchesFragment) ??
    null
  );
}

function handleMarkdownFragmentClick(event: ReactMouseEvent<HTMLAnchorElement>, href: string) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }

  // Never let the browser follow the fragment or write it to the URL: desktop keeps
  // its route in the hash, so replacing the hash navigates away from the thread.
  event.preventDefault();
  findMarkdownFragmentTarget(event.currentTarget, href)?.scrollIntoView({ block: "start" });
}

type HeadingHastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HeadingHastNode[];
};

/** GitHub's heading anchor slug, so `[Setup](#setup)` table-of-contents links find their heading. */
function githubHeadingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/**
 * Gives headings without an authored id GitHub's slug id, deduplicated per document. Like the
 * sanitizer's ids, they carry the `user-content-` prefix so they cannot clobber app element ids;
 * fragment lookup strips it.
 */
function rehypeHeadingIds() {
  return (tree: HeadingHastNode) => {
    // Every id already in the document, authored or assigned, so a suffix never
    // lands on one that exists: `Setup`, `Setup`, `Setup-1` get three distinct ids.
    const taken = new Set<string>();
    const collect = (node: HeadingHastNode) => {
      const id = node.properties?.id;
      if (typeof id === "string") taken.add(id);
      node.children?.forEach(collect);
    };
    collect(tree);
    const nextSuffix = new Map<string, number>();
    const visit = (node: HeadingHastNode) => {
      if (node.type === "element" && node.tagName && /^h[1-6]$/.test(node.tagName)) {
        const slug = githubHeadingSlug(hastPlainTextDeep(node));
        if (node.properties?.id === undefined && slug) {
          let count = nextSuffix.get(slug) ?? 0;
          let id = `${SANITIZED_FRAGMENT_PREFIX}${slug}`;
          while (taken.has(id)) {
            count += 1;
            id = `${SANITIZED_FRAGMENT_PREFIX}${slug}-${count}`;
          }
          nextSuffix.set(slug, count);
          taken.add(id);
          node.properties = { ...node.properties, id };
        }
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

// Heading ids are added after sanitizing, which would prefix them a second time.
const CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS = [
  ...CHAT_MARKDOWN_REHYPE_PLUGINS,
  rehypeHeadingIds,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

const CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS = [
  // SCIENT-FORK:START — retain safe scientific images without opting into raw HTML.
  ...CHAT_MARKDOWN_REHYPE_PLUGINS_WITHOUT_RAW,
  // SCIENT-FORK:END
  rehypeHeadingIds,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

function MarkdownExternalLinkContent({
  host,
  plainText,
  children,
}: {
  host: string;
  plainText: string | null;
  children: ReactNode;
}) {
  if (plainText) {
    const leadingLength = leadingExternalLinkTextLength(plainText);
    return (
      <>
        <span className="whitespace-nowrap">
          <MarkdownLinkFavicon host={host} />
          {plainText.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(plainText.slice(leadingLength))}
      </>
    );
  }

  const childNodes = Children.toArray(children);
  const firstChild = childNodes[0];

  if (typeof firstChild === "string" && firstChild.length > 0) {
    const leadingLength = leadingExternalLinkTextLength(firstChild);
    return (
      <>
        <span className="whitespace-nowrap">
          <MarkdownLinkFavicon host={host} />
          {firstChild.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(firstChild.slice(leadingLength))}
        {childNodes.slice(1)}
      </>
    );
  }

  return (
    <>
      <span className="whitespace-nowrap">
        <MarkdownLinkFavicon host={host} />
        {firstChild}
      </span>
      {childNodes.slice(1)}
    </>
  );
}

const MarkdownFileLink = memo(function MarkdownFileLink({
  href,
  targetPath,
  iconPath,
  relativeCopyPath,
  panelPath,
  line,
  label,
  copyMarkdown,
  theme,
  threadRef,
  onOpen,
  onOpenInPanel,
  openInEditorMenuLabel,
  onOpenInBrowser,
  onOpenMedia,
  onReveal,
  revealLabel,
}: MarkdownFileLinkProps) {
  const handleOpenInEditor = useCallback(() => {
    if (!onOpen) {
      return;
    }
    void (async () => {
      try {
        const result = await onOpen(targetPath);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  }, [onOpen, targetPath]);

  const handleOpenInFilePreview = useCallback(() => {
    if (threadRef && panelPath) {
      onOpenInPanel(panelPath, line);
      return;
    }
    if (onOpenMedia) {
      onOpenMedia();
      return;
    }
    handleOpenInEditor();
  }, [handleOpenInEditor, line, onOpenInPanel, onOpenMedia, panelPath, threadRef]);

  const handleOpenInBrowser = useCallback(() => {
    if (!onOpenInBrowser) {
      return;
    }
    void (async () => {
      try {
        const result = await onOpenInBrowser();
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file in browser",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        handleOpenInFilePreview();
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file in browser",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
        handleOpenInFilePreview();
      }
    })();
  }, [handleOpenInFilePreview, onOpenInBrowser, targetPath]);

  const handleRevealInFileManager = useCallback(() => {
    if (!onReveal) {
      return;
    }
    void (async () => {
      try {
        const result = await onReveal();
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "reveal-file-in-file-manager", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to reveal file",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "reveal-file-in-file-manager", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to reveal file",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  }, [onReveal, targetPath]);

  const handleCopy = useCallback(
    (value: string, format: FilePathCopyFormat) => {
      void copyFilePathToClipboard({
        value,
        format,
        onError: (error) => {
          reportMarkdownActionFailure(
            {
              operation: "copy-file-path",
              target: targetPath,
              copyTarget: filePathCopyTitle(format),
            },
            error,
          );
        },
      });
    },
    [targetPath],
  );

  const showFileContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;

      try {
        const clicked = await api.contextMenu.show(
          [
            ...(onOpenMedia ? ([{ id: "preview-media", label: "Preview media" }] as const) : []),
            ...(onOpen ? ([{ id: "open", label: openInEditorMenuLabel }] as const) : []),
            ...(onOpenInBrowser
              ? ([{ id: "open-in-browser", label: "Open in integrated browser" }] as const)
              : []),
            ...(onReveal && revealLabel ? ([{ id: "reveal", label: revealLabel }] as const) : []),
            ...(relativeCopyPath !== null
              ? ([{ id: "copy-relative", label: "Copy relative path" }] as const)
              : []),
            { id: "copy-full", label: "Copy full path" },
          ] as const,
          position,
        );

        if (clicked === "preview-media") {
          onOpenMedia?.();
          return;
        }
        if (clicked === "open") {
          handleOpenInEditor();
          return;
        }
        if (clicked === "open-in-browser") {
          handleOpenInBrowser();
          return;
        }
        if (clicked === "reveal") {
          handleRevealInFileManager();
          return;
        }
        if (clicked === "copy-relative" && relativeCopyPath !== null) {
          handleCopy(relativeCopyPath, "relative");
          return;
        }
        if (clicked === "copy-full") {
          handleCopy(targetPath, "full");
        }
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "show-file-context-menu", target: targetPath },
          cause,
        );
      }
    },
    [
      handleCopy,
      handleOpenInBrowser,
      handleOpenInEditor,
      handleRevealInFileManager,
      onOpenInBrowser,
      onOpenMedia,
      onOpen,
      onReveal,
      openInEditorMenuLabel,
      relativeCopyPath,
      revealLabel,
      targetPath,
    ],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const position =
        event.clientX === 0 && event.clientY === 0
          ? (() => {
              const bounds = event.currentTarget.getBoundingClientRect();
              return { x: bounds.left, y: bounds.bottom };
            })()
          : { x: event.clientX, y: event.clientY };
      void showFileContextMenu(position);
    },
    [showFileContextMenu],
  );

  const canOpenInEditor = onOpen !== undefined;
  const canOpenInBrowser = onOpenInBrowser !== undefined;
  const canOpenInPanel = threadRef !== undefined && Boolean(panelPath);
  const hasPrimaryAction = hasMarkdownFilePrimaryAction({
    canOpenInEditor,
    canOpenInBrowser,
    canOpenInPanel,
    canOpenMedia: onOpenMedia !== undefined,
  });
  const useBrowserPrimaryAction = shouldUseMarkdownFileBrowserPrimaryAction({
    canOpenInBrowser,
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          hasPrimaryAction ? (
            <ContextChip
              kind="mention"
              render={<a href={href} />}
              className={MARKDOWN_FILE_LINK_CLASS_NAME}
              data-markdown-copy={copyMarkdown}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (onOpen && shouldOpenMarkdownFileLinkInEditor(event)) {
                  handleOpenInEditor();
                  return;
                }
                if (useBrowserPrimaryAction) {
                  handleOpenInBrowser();
                  return;
                }
                handleOpenInFilePreview();
              }}
              onContextMenu={handleContextMenu}
            >
              <FileTagChipContent path={iconPath} label={label} theme={theme} />
            </ContextChip>
          ) : (
            <ContextChip
              kind="mention"
              render={<button type="button" />}
              aria-label={`File options for ${label}`}
              aria-haspopup="menu"
              className={cn(MARKDOWN_FILE_LINK_CLASS_NAME, "select-text")}
              data-markdown-copy={copyMarkdown}
              onClick={handleContextMenu}
              onContextMenu={handleContextMenu}
            >
              <FileTagChipContent path={iconPath} label={label} theme={theme} />
            </ContextChip>
          )
        }
      />
      <TooltipPopup side="top" variant="code" className="max-w-[min(40rem,calc(100vw-2rem))]">
        {/* The full path: the chip already shows the shortened form, and a link
            to the workspace root collapses to a bare label that repeats it. */}
        <div className="scient-file-link-tooltip overflow-x-auto leading-tight whitespace-nowrap scrollbar-thumb-border/78 scrollbar-track-transparent [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/78 [&::-webkit-scrollbar-track]:bg-transparent">
          {targetPath}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}, areMarkdownFileLinkPropsEqual);

function areMarkdownFileLinkPropsEqual(
  previous: Readonly<MarkdownFileLinkProps>,
  next: Readonly<MarkdownFileLinkProps>,
): boolean {
  return (
    previous.href === next.href &&
    previous.targetPath === next.targetPath &&
    previous.iconPath === next.iconPath &&
    previous.relativeCopyPath === next.relativeCopyPath &&
    previous.panelPath === next.panelPath &&
    previous.line === next.line &&
    previous.label === next.label &&
    previous.copyMarkdown === next.copyMarkdown &&
    previous.theme === next.theme &&
    previous.threadRef === next.threadRef &&
    previous.onOpen === next.onOpen &&
    previous.onOpenInPanel === next.onOpenInPanel &&
    previous.openInEditorMenuLabel === next.openInEditorMenuLabel &&
    previous.onOpenInBrowser === next.onOpenInBrowser &&
    previous.onOpenMedia === next.onOpenMedia &&
    previous.onReveal === next.onReveal &&
    previous.revealLabel === next.revealLabel
  );
}

function useChatMarkdownState({
  text: textProp,
  cwd,
  fileLinkWorkspaceRoot,
  threadRef,
  pullRequestPanelRef,
  environmentId: explicitEnvironmentId,
  onTaskListChange,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  className,
  lineBreaks = false,
  contentDirection,
  messageId,
  directionHint,
  parseRawHtml = true,
  onUseArtifactTemplate,
  onRunShellCommand,
  imageBaseDir,
  imageCaptions = false,
  onImageExpand,
  extraRemarkPlugins = EMPTY_REMARK_PLUGINS,
  renderContextReference,
  headingLevelOffset = 0,
  githubMedia = false,
  changedFiles,
}: ChatMarkdownProps) {
  // Delimiter normalization is length-preserving, so offset-based behavior
  // (task-list toggling, list positions) stays correct on every surface. The
  // original text rides along so the refinement plugin can recover each
  // backslash pair's inline-versus-display intent after normalization.
  const text = useScientMathMarkdownText(textProp);
  const incrementalParsing =
    isStreaming && extraRemarkPlugins.length === 0 && /(?:^|\n) {0,3}(?:`{3}|~{3})/.test(text);
  const baseRemarkPlugins = useMemo(
    () => [
      ...(lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS),
      ...extraRemarkPlugins,
      ...(incrementalParsing ? [createIncrementalMarkdownPlugin()] : []),
    ],
    [extraRemarkPlugins, incrementalParsing, lineBreaks],
  );
  const remarkPlugins = useScientMathRemarkPlugins(baseRemarkPlugins, textProp);
  // SCIENT-FORK:START — message direction, held while an auto message streams
  const { effectiveContentDirection, resolvedContentDirection } = useChatContentDirection({
    text,
    contentDirection,
    messageId,
    directionHint,
    isStreaming,
  });
  // SCIENT-FORK:END
  const { resolvedTheme } = useTheme();
  const [localMediaPreview, setLocalMediaPreview] = useState<ExpandedImagePreview | null>(null);
  const markdownRef = useRef<HTMLDivElement>(null);
  // SCIENT-FORK:START — a streaming answer is revealed line by line (chat/useStreamingBlockEntrance.ts).
  useStreamingBlockEntrance(markdownRef, isStreaming, messageId);
  // SCIENT-FORK:END
  const expandMedia = onImageExpand ?? setLocalMediaPreview;
  const mediaRequestId = useRef(0);
  useEffect(() => {
    setLocalMediaPreview(null);
    return () => {
      mediaRequestId.current += 1;
    };
  }, [threadRef?.environmentId, threadRef?.threadId, explicitEnvironmentId, cwd, imageBaseDir]);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const searchProjectEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    reportFailure: false,
  });
  const resolveEnvironmentFileLink = useAtomQueryRunner(environmentFileLinkResolution, {
    reportFailure: false,
    refresh: true,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const pullRequestLinking = usePullRequestLinking(threadRef?.environmentId);
  const environmentId = threadRef?.environmentId ?? explicitEnvironmentId ?? null;
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const remoteOpen = useRemoteOpenResolution(environmentId);
  const canUseShellActions =
    canOperateHost &&
    canUseMarkdownFileShellActions(environmentId, remoteOpen.state.mode, remoteOpen.isResolved);
  const preparedConnection = usePreparedConnection(environmentId);
  const openMarkdownMedia = useCallback(
    (source: string, resolvedFilePath?: string, clickedImage?: HTMLImageElement | null) => {
      const requestId = ++mediaRequestId.current;
      void resolveMarkdownMediaPreview({
        source,
        resolvedFilePath,
        cwd,
        threadRef,
        httpBaseUrl:
          preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : undefined,
        createAssetUrl,
        onOpenFile: threadRef
          ? (path) => useRightPanelStore.getState().openFile(threadRef, path)
          : undefined,
      }).then(
        (preview) => {
          if (preview && mediaRequestId.current === requestId) {
            const selected = preview.images[preview.index];
            expandMedia(
              selected && selected.type !== "video" && markdownRef.current
                ? markdownImageGallery(clickedImage ?? markdownRef.current, selected)
                : preview,
            );
          }
        },
        (error: unknown) => {
          if (mediaRequestId.current !== requestId) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Media unavailable",
              description:
                error instanceof Error
                  ? error.message
                  : "The file could not be loaded. It may have been moved or deleted.",
            }),
          );
        },
      );
    },
    [createAssetUrl, cwd, expandMedia, preparedConnection, threadRef],
  );
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const projects = useProjects();
  const availableEditors = serverConfig?.availableEditors ?? [];
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const preferredEditorMenuLabel = openInEditorMenuLabel(preferredEditor);
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const revealInFileManagerLabel =
    environmentId !== null &&
    serverConfig?.shellRevealInFileManager === true &&
    serverConfig.availableEditors.includes("file-manager")
      ? serverConfig.shellRevealInFileManagerKind === undefined
        ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
        : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind)
      : undefined;
  const revealFileInFileManager = useCallback(
    (filePath: string) => {
      if (environmentId === null) {
        return Promise.resolve(
          AsyncResult.failure<void, PreferredEditorEnvironmentRequiredError>(
            Cause.fail(new PreferredEditorEnvironmentRequiredError({ targetPath: filePath })),
          ),
        );
      }
      if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
        return Promise.resolve(
          AsyncResult.failure<void, Error>(
            Cause.fail(new Error("This connection cannot reveal files on this environment.")),
          ),
        );
      }
      return openInEditor({
        environmentId,
        input: { cwd: filePath, editor: "file-manager", reveal: true },
      });
    },
    [environmentId, openInEditor],
  );
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const markdownFileLinkMetaByHref = useMemo(() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();
    for (const href of extractMarkdownLinkHrefs(renderCodexFileCitationsAsMarkdown(text))) {
      if (parseComposerContextHref(href)) continue;
      const normalizedHref = normalizeMarkdownLinkHref(href);
      const lookupKey = markdownLinkLookupKey(normalizedHref);
      if (metaByHref.has(lookupKey)) continue;
      const meta = resolveMarkdownFileLinkMeta(
        normalizedHref,
        cwd,
        imageBaseDir ?? cwd,
        fileLinkWorkspaceRoot,
      );
      if (meta) {
        metaByHref.set(lookupKey, meta);
      }
    }
    return metaByHref;
  }, [cwd, fileLinkWorkspaceRoot, imageBaseDir, text]);
  const inlineCodeFileLinkMetaByText = useMemo(() => {
    const metaByText = new Map<string, MarkdownFileLinkMeta>();
    for (const span of extractInlineCodeSpans(text)) {
      if (metaByText.has(span)) continue;
      const meta = resolveInlineCodeFileLinkMeta(
        span,
        cwd,
        imageBaseDir ?? cwd,
        fileLinkWorkspaceRoot,
      );
      if (meta) {
        metaByText.set(span, meta);
      }
    }
    return metaByText;
  }, [cwd, fileLinkWorkspaceRoot, imageBaseDir, text]);
  const fileLinkParentSuffixByPath = useMemo(() => {
    const filePaths = [
      ...[...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath),
      ...[...inlineCodeFileLinkMetaByText.values()].map((meta) => meta.filePath),
    ];
    return buildFileLinkParentSuffixByPath(filePaths);
  }, [inlineCodeFileLinkMetaByText, markdownFileLinkMetaByHref]);
  const markdownUrlTransform = useCallback((href: string) => {
    if (parseComposerCitationHref(href)) return href;
    if (parseComposerContextHref(href)) return href;
    // SCIENT-FORK:START — keep saved qualified thread URLs through Markdown sanitization.
    if (parseEnvironmentQualifiedThreadLinkHref(href) || parseThreadLinkHref(href)) return href;
    // SCIENT-FORK:END
    if (isWindowsDrivePathHref(href)) return href;
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  }, []);
  // Re-emit highlighted content as markdown so copying out of the rendered
  // view keeps links, emphasis, lists, and code fences intact.
  const handleCopy = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData) return;
    const payload = chatMarkdownClipboardPayload(selection);
    if (!payload) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload.text);
    const fragment = event.clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME);
    event.clipboardData.setData(
      "text/html",
      fragment
        ? encodeComposerContextClipboardHtml(payload.text, fragment, payload.html)
        : payload.html,
    );
  }, []);
  const openChangeRequestLink = useOpenChangeRequestLink(threadRef, pullRequestPanelRef);
  const openDeferredMarkdownLink = useOpenLink(threadRef);
  // Subscribed rather than read at click time: the anchor has to decide
  // synchronously whether to intercept its `_blank`, and a subscription is what
  // makes a persisted "app" apply once settings hydrate after launch.
  const linkTargetPreference = useClientSettings((settings) => settings.browserLinkTarget);
  const resolveThreadPullRequest = useCallback(
    (href: string): (ThreadPullRequestKey & { readonly url: string }) | null => {
      if (
        threadRef === undefined ||
        readThreadShell(threadRef) === null ||
        !pullRequestLinking.canLink(href)
      )
        return null;
      const parsed = parseChangeRequestUrl(href);
      return parsed === null ? null : { ...parsed, url: href };
    },
    [pullRequestLinking, threadRef],
  );
  const linkedThreadPullRequestFor = useCallback(
    (href: string) => {
      if (threadRef === undefined || !pullRequestLinking.isLinked(readThreadShell(threadRef), href))
        return null;
      const parsed = parseChangeRequestUrl(href);
      return parsed === null ? null : { ...parsed, url: href };
    },
    [pullRequestLinking, threadRef],
  );
  const updateThreadPullRequestLink = useCallback(
    async (href: string, linked: boolean) => {
      if (threadRef === undefined || (!linked && linkedThreadPullRequestFor(href) === null)) return;
      if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
      await pullRequestLinking.changeLink(threadRef, href, linked);
    },
    [linkedThreadPullRequestFor, pullRequestLinking, threadRef],
  );
  const openExternalLinkInPreview = useCallback(
    (url: string) => {
      if (!threadRef || !canOperatePreview) {
        return Promise.resolve(
          AsyncResult.failure<void, BrowserPreviewUnavailableError>(
            Cause.fail(
              new BrowserPreviewUnavailableError({
                message: "Preview access is unavailable for this client.",
              }),
            ),
          ),
        );
      }
      return openUrlInPreview({ threadRef, url, openPreview }).then((result) => {
        if (result._tag === "Success") recordVisitForThread(threadRef, url);
        else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          if (error instanceof BrowserSettingsReadError) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Unable to open link in browser",
                description: error.message,
              }),
            );
          }
        }
        return result;
      });
    },
    [canOperatePreview, openPreview, threadRef],
  );
  const openMarkdownFileInPreview = useCallback(
    (path: string, workspaceRelativePath: string) => {
      if (!threadRef || !cwd || !canOperatePreview || preparedConnection._tag === "None") {
        return Promise.resolve(
          AsyncResult.failure<void, BrowserPreviewUnavailableError>(
            Cause.fail(
              new BrowserPreviewUnavailableError({
                message: "Environment is not connected.",
              }),
            ),
          ),
        );
      }
      return openFileInPreview({
        threadRef,
        workspaceRoot: cwd,
        relativePath: workspaceRelativePath,
        filePath: path,
        httpBaseUrl: preparedConnection.value.httpBaseUrl,
        createAssetUrl,
        openPreview,
      });
    },
    [canOperatePreview, createAssetUrl, cwd, openPreview, preparedConnection, threadRef],
  );
  // SCIENT-FORK:START — pages outside the workspace open in the integrated browser
  const openEnvironmentHtmlInPreview = useChatEnvironmentHtmlPreview({
    threadRef,
    preparedConnection,
    createAssetUrl,
    openPreview,
  });
  // SCIENT-FORK:END
  const findWorkspaceBasenameMatch = useCallback(
    async (workspaceRelativePath: string) => {
      if (
        !cwd ||
        environmentId === null ||
        !readEnvironmentScope(environmentId, AuthFilesystemReadScope) ||
        !needsWorkspaceBasenameLookup(workspaceRelativePath)
      ) {
        return null;
      }
      const result = await searchProjectEntries({
        environmentId,
        input: {
          cwd,
          query: workspaceRelativePath,
          limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
          kind: "file",
        },
      });
      return result._tag === "Success"
        ? pickWorkspaceBasenameMatch(workspaceRelativePath, result.value.entries)
        : null;
    },
    [cwd, environmentId, searchProjectEntries],
  );
  // SCIENT-FORK:START — every file link asks the environment what it means
  const {
    openFileInPanel,
    openHomeRelativeLinkInPanel,
    openMarkdownMediaLink,
    openHtmlLinkInBrowser,
  } = useChatFileLinkOpening({
    threadRef,
    cwd,
    environmentId,
    changedFiles,
    resolveEnvironmentFileLink,
    openMarkdownMedia,
    openMarkdownFileInPreview,
    openEnvironmentHtmlInPreview,
  });
  // SCIENT-FORK:END
  const revealMarkdownFileInFileManager = useCallback(
    async (fileLinkMeta: MarkdownFileLinkMeta) => {
      const workspaceRelativePath = fileLinkMeta.workspaceRelativePath;
      const match = workspaceRelativePath
        ? await findWorkspaceBasenameMatch(workspaceRelativePath)
        : null;
      const filePath = match && cwd ? resolvePathLinkTarget(match, cwd) : fileLinkMeta.filePath;
      return revealFileInFileManager(filePath);
    },
    [cwd, findWorkspaceBasenameMatch, revealFileInFileManager],
  );
  const fileLinkChip = useCallback(
    (fileLinkMeta: MarkdownFileLinkMeta, copyMarkdown: string, mediaSource?: string) => {
      const browserRelativePath = fileLinkMeta.workspaceRelativePath;
      const mediaPath = mediaSource ?? fileLinkMeta.filePath;
      const canPreviewMedia =
        mediaMimeTypeFromExtension(
          fileLinkMeta.basename.slice(fileLinkMeta.basename.lastIndexOf(".")),
        ) !== null;
      // Media outside the workspace keeps the expanded preview; other host
      // files (a report in a temp dir) open read-only in the files panel.
      // A home-relative link is handed over as authored: only the machine
      // that owns the files knows where its home folder is.
      // Home-relative media has no panel path of its own: it goes through
      // the media action, which asks the same way.
      const homeRelativePath = fileLinkMeta.homeRelativePath;
      const panelPath =
        homeRelativePath !== undefined
          ? canPreviewMedia
            ? null
            : homeRelativePath
          : (fileLinkMeta.workspaceRelativePath ??
            (!canPreviewMedia && isAbsolutePath(fileLinkMeta.filePath)
              ? fileLinkMeta.filePath
              : null));

      return (
        <MarkdownFileLink
          href={fileLinkMeta.targetPath}
          targetPath={fileLinkMeta.targetPath}
          iconPath={fileLinkMeta.filePath}
          relativeCopyPath={markdownFileLinkRelativeCopyPath(fileLinkMeta)}
          panelPath={panelPath}
          line={fileLinkMeta.line}
          label={fileLinkLabel(
            {
              path: fileLinkMeta.filePath,
              ...(fileLinkMeta.line !== undefined ? { line: fileLinkMeta.line } : {}),
              ...(fileLinkMeta.column !== undefined ? { column: fileLinkMeta.column } : {}),
            },
            fileLinkParentSuffixByPath,
          )}
          copyMarkdown={copyMarkdown}
          theme={resolvedTheme}
          threadRef={threadRef}
          {...(canUseShellActions ? { onOpen: openInPreferredEditor } : {})}
          onOpenInPanel={
            homeRelativePath !== undefined ? openHomeRelativeLinkInPanel : openFileInPanel
          }
          onOpenMedia={
            threadRef && canPreviewMedia
              ? () => openMarkdownMediaLink(mediaPath, fileLinkMeta.filePath, homeRelativePath)
              : undefined
          }
          openInEditorMenuLabel={preferredEditorMenuLabel}
          onReveal={
            canUseShellActions && revealInFileManagerLabel !== undefined
              ? () => revealMarkdownFileInFileManager(fileLinkMeta)
              : undefined
          }
          revealLabel={revealInFileManagerLabel}
          onOpenInBrowser={
            threadRef &&
            canOperatePreview &&
            isPreviewAvailableFor(threadRef.environmentId) &&
            resolveWorkspaceFileLinkOpenTarget(fileLinkMeta.filePath) === "browser"
              ? () =>
                  openHtmlLinkInBrowser(
                    fileLinkMeta.filePath,
                    browserRelativePath,
                    homeRelativePath,
                  )
              : undefined
          }
        />
      );
    },
    [
      canUseShellActions,
      canOperatePreview,
      fileLinkParentSuffixByPath,
      openFileInPanel,
      openHomeRelativeLinkInPanel,
      openHtmlLinkInBrowser,
      openInPreferredEditor,
      openMarkdownMediaLink,
      preferredEditorMenuLabel,
      resolvedTheme,
      revealInFileManagerLabel,
      revealMarkdownFileInFileManager,
      threadRef,
    ],
  );

  const componentState = useMemo(
    () => ({
      canOperateHost,
      canOperatePreview,
      cwd,
      fileLinkWorkspaceRoot,
      diffThemeName,
      environmentId,
      expandMedia,
      fileLinkChip,
      githubMedia,
      renderContextReference,
      headingLevelOffset,
      imageBaseDir,
      imageCaptions,
      inlineCodeFileLinkMetaByText,
      isStreaming,
      linkTargetPreference,
      markdownFileLinkMetaByHref,
      onTaskListChange,
      onUseArtifactTemplate,
      onRunShellCommand,
      openChangeRequestLink,
      openDeferredMarkdownLink,
      openExternalLinkInPreview,
      openMarkdownMedia,
      projects,
      linkedThreadPullRequestFor,
      resolveThreadPullRequest,
      resolvedTheme,
      resolvedContentDirection,
      serverConfig,
      skills,
      text,
      authoredMathText: textProp,
      threadRef,
      updateThreadPullRequestLink,
    }),
    [
      canOperateHost,
      canOperatePreview,
      cwd,
      fileLinkWorkspaceRoot,
      diffThemeName,
      environmentId,
      expandMedia,
      fileLinkChip,
      githubMedia,
      renderContextReference,
      headingLevelOffset,
      imageBaseDir,
      imageCaptions,
      inlineCodeFileLinkMetaByText,
      isStreaming,
      linkTargetPreference,
      markdownFileLinkMetaByHref,
      onTaskListChange,
      onUseArtifactTemplate,
      onRunShellCommand,
      openChangeRequestLink,
      openDeferredMarkdownLink,
      openExternalLinkInPreview,
      openMarkdownMedia,
      projects,
      linkedThreadPullRequestFor,
      resolveThreadPullRequest,
      resolvedTheme,
      resolvedContentDirection,
      serverConfig,
      skills,
      text,
      textProp,
      threadRef,
      updateThreadPullRequestLink,
    ],
  );
  return {
    componentState,
    text,
    remarkPlugins,
    className,
    parseRawHtml,
    resolvedContentDirection,
    effectiveContentDirection,
    handleCopy,
    markdownRef,
    markdownUrlTransform,
    localMediaPreview,
    setLocalMediaPreview,
  };
}

const ChatMarkdownRendererContext = React.createContext<
  ReturnType<typeof useChatMarkdownState>["componentState"]
>(null!);
// Screen readers take a heading's level from its tag, which would let a `#` in a
// message outrank the heading placed above it. Override only the exposed level:
// the tag keeps driving the stylesheet and copy-as-markdown.
function markdownHeadingRenderer(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const;
  return function MarkdownHeading({
    node: _node,
    ...props
  }: ComponentProps<typeof Tag> & ReactMarkdownExtraProps) {
    const { headingLevelOffset } = use(ChatMarkdownRendererContext);
    return (
      <Tag
        {...props}
        aria-level={headingLevelOffset > 0 ? Math.min(level + headingLevelOffset, 6) : undefined}
      />
    );
  };
}

// Stable component types preserve image and rich-output state while tokens stream.
const CHAT_MARKDOWN_COMPONENTS = {
  h1: markdownHeadingRenderer(1),
  h2: markdownHeadingRenderer(2),
  h3: markdownHeadingRenderer(3),
  h4: markdownHeadingRenderer(4),
  h5: markdownHeadingRenderer(5),
  h6: markdownHeadingRenderer(6),
  img: function MarkdownImg({ node, alt, src, title, ...props }) {
    const {
      cwd,
      environmentId,
      expandMedia,
      githubMedia,
      imageBaseDir,
      imageCaptions,
      isStreaming,
      renderContextReference,
      threadRef,
    } = use(ChatMarkdownRendererContext);

    const contextReference = typeof src === "string" ? parseComposerContextHref(src) : null;
    if (contextReference) {
      const label = alt || contextReference.contextId;
      return renderContextReference ? (
        renderContextReference({ ...contextReference, label })
      ) : (
        <span>{label}</span>
      );
    }

    const imageExpand = use(MarkdownLinkContext) ? undefined : expandMedia;
    const localSrc = node?.properties?.dataLocalSrc;
    const markdownTitle = node?.properties?.dataMarkdownTitle;
    const standalone = node?.properties?.dataStandalone === true;
    const authoredSrc = typeof localSrc === "string" ? localSrc : src;
    const authoredTitle = typeof markdownTitle === "string" ? markdownTitle : title;
    const srcString =
      typeof authoredSrc === "string" ? normalizeMarkdownLinkDestination(authoredSrc) : "";
    const classifiedSrc =
      typeof localSrc === "string" ? srcString.replaceAll("\\", "/") : srcString;
    const altText = alt ?? "";
    const markdownSource = inlineWorkspaceImageMarkdownSource(altText, srcString, authoredTitle);
    const style = authoredImageSizeStyle(props.width, props.height);
    const imageSource = classifyMarkdownImageSource(classifiedSrc, imageBaseDir ?? cwd);
    const srcFragment = markdownImageSourceFragment(classifiedSrc);
    const kind = mediaKindFromPath(classifiedSrc) ?? "image";
    const directUri = imageSource._tag === "Direct" ? imageSource.uri : null;
    const githubMediaUrl =
      directUri === null ? null : githubMediaFetchUrl(resolveProtocolRelativeMediaUrl(directUri));
    const image =
      imageSource._tag === "WorkspaceFile"
        ? resolveInlineWorkspaceImage({ alt, cwd, src: imageSource.path })
        : null;
    const useScientImageCard = Boolean(node?.properties?.dataScientImageCard);
    // SCIENT-FORK:START — web images render as a referenced link until the user loads one.
    const remoteImageReference = useScientRemoteImageReference({
      directUri,
      altText,
      kind,
      markdownSource,
      id: props.id,
      MarkdownLinkContext,
      renderImage: () => <MarkdownImg node={node} alt={alt} src={src} title={title} {...props} />,
    });
    // SCIENT-FORK:END
    // SCIENT-FORK:START — standalone workspace images render as Scient image cards
    const workspaceImageCard = scientWorkspaceImageCard({
      useScientImageCard,
      image,
      markdownSource,
      threadRef,
      isStreaming,
      srcFragment,
      imageCaptions,
      authoredTitle,
      altText,
      srcString,
    });
    if (workspaceImageCard !== null) return workspaceImageCard;
    // SCIENT-FORK:END
    if (
      githubMedia &&
      cwd !== undefined &&
      environmentId !== null &&
      directUri !== null &&
      githubMediaUrl !== null
    ) {
      const { className, style: _style, width: _width, height: _height, ...imageProps } = props;
      return (
        <ChatMarkdownAssetImage
          environmentId={environmentId}
          resource={{ _tag: "github-media", cwd, url: githubMediaUrl }}
          alt={altText}
          kind={kind}
          copyMarkdown={markdownSource}
          standalone={standalone}
          className={className}
          style={style}
          imageProps={imageProps}
          srcFragment={srcFragment}
          originalUrl={resolveProtocolRelativeMediaUrl(directUri)}
          framed={false}
          // SCIENT-FORK:START — the server proxies GitHub media; the direct fallback is gated
          fallbackSrc={remoteImageReference === null ? githubMediaUrl : undefined}
          failureFallback={remoteImageReference ?? undefined}
          // SCIENT-FORK:END
          onImageExpand={imageExpand}
        />
      );
    }
    // SCIENT-FORK:START — see the remote-image gate above
    if (remoteImageReference !== null) return remoteImageReference;
    // SCIENT-FORK:END
    if (imageSource._tag === "Direct") {
      const mediaSrc = resolveProtocolRelativeMediaUrl(imageSource.uri);
      const originalUrl =
        resolveExternalWebLinkHost(imageSource.uri) !== null ? imageSource.uri : undefined;
      const reference = mediaUrlReference(imageSource.uri);
      const actionsSource: MediaActionSource = {
        kind,
        name: altText || kind,
        src: mediaSrc,
        ...(reference ? { reference } : {}),
      };
      if (kind === "video") {
        return (
          <ChatMarkdownVideo
            src={mediaSrc}
            alt={altText}
            copyMarkdown={markdownSource}
            originalUrl={originalUrl}
            style={style}
            onImageExpand={imageExpand}
            actionsSource={actionsSource}
          />
        );
      }
      if (imageCaptions && useScientImageCard) {
        return (
          <ScientDirectImageFigure
            src={mediaSrc}
            authoredSource={srcString}
            alt={altText}
            caption={authoredTitle}
            markdownSource={markdownSource}
          />
        );
      }
      return (
        <ChatMarkdownImage
          key={mediaSrc}
          src={mediaSrc}
          alt={altText}
          copyMarkdown={markdownSource}
          standalone={standalone}
          imageProps={props}
          className={props.className}
          style={style}
          actionsSource={actionsSource}
          originalUrl={originalUrl}
          onImageExpand={imageExpand}
        />
      );
    }
    if (imageSource._tag === "WorkspaceFile" && threadRef) {
      return (
        <ChatMarkdownAssetImage
          environmentId={threadRef.environmentId}
          resource={
            image
              ? inlineWorkspaceImageResource(image, threadRef)
              : {
                  _tag: "media-file",
                  threadId: threadRef.threadId,
                  path: imageSource.path,
                }
          }
          alt={altText}
          kind={kind}
          copyMarkdown={markdownSource}
          srcFragment={srcFragment}
          style={style}
          standalone={standalone}
          workspaceRoot={cwd}
          onImageExpand={imageExpand}
        />
      );
    }
    return <ChatMarkdownImageFallback alt={altText} copyMarkdown={markdownSource} kind={kind} />;
  },
  // SCIENT-FORK:START — a <picture> source never fetches a web address; its <img> is gated
  source: ScientMarkdownSource,
  // SCIENT-FORK:END
  div: function MarkdownDiv({ node, children, ...props }) {
    const { onUseArtifactTemplate } = use(ChatMarkdownRendererContext);

    const artifactTemplate = artifactTemplateFromHastProperties(node?.properties);
    if (artifactTemplate) {
      return (
        <CodexArtifactTemplateCard template={artifactTemplate} onUse={onUseArtifactTemplate} />
      );
    }
    return <div {...props}>{children}</div>;
  },
  p: function MarkdownP({ node: _node, children, ...props }) {
    const { skills } = use(ChatMarkdownRendererContext);

    return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</p>;
  },
  blockquote: function MarkdownBlockquote({ node: _node, children, ...props }) {
    const alert =
      GITHUB_ALERT_PRESENTATIONS[String((props as Record<string, unknown>)["data-alert"] ?? "")];
    if (!alert) {
      return <blockquote {...props}>{children}</blockquote>;
    }
    // Not a <blockquote>: the stylesheet mutes those, and an alert's body is ordinary
    // text under a colored title — which is how the host renders it.
    return (
      <div role="note" className={cn("my-1 border-l-2 pl-3", alert.borderClassName)}>
        <p
          data-thread-find-ignore="true"
          className={cn("flex items-center gap-1.5 font-medium", alert.titleClassName)}
        >
          <alert.Icon aria-hidden className="size-3.5 shrink-0" />
          {alert.label}
        </p>
        {children}
      </div>
    );
  },
  ol: function MarkdownOl({ node, start, style, ...props }) {
    const itemCount =
      node?.children?.filter((child) => child.type === "element" && child.tagName === "li")
        .length ?? 0;
    const gutterStyle = orderedListGutterStyle(itemCount, start);
    return (
      <ol {...props} start={start} style={gutterStyle ? { ...style, ...gutterStyle } : style} />
    );
  },
  li: function MarkdownLi({ node, children, ...props }) {
    const { skills, text } = use(ChatMarkdownRendererContext);

    const listItemStart = node?.position?.start.offset;
    const markerOffset =
      typeof listItemStart === "number" ? findTaskListMarkerOffset(text, listItemStart) : null;
    return (
      <li {...props} data-task-marker-offset={markerOffset ?? undefined}>
        {renderSkillInlineMarkdownChildren(children, skills)}
      </li>
    );
  },
  input: function MarkdownInput({ node: _node, type, checked, disabled: _disabled, ...props }) {
    const { onTaskListChange } = use(ChatMarkdownRendererContext);

    if (type !== "checkbox" || !onTaskListChange) {
      return (
        <input
          {...props}
          type={type}
          checked={checked}
          disabled={_disabled}
          readOnly={type === "checkbox"}
        />
      );
    }
    return (
      <input
        {...props}
        type="checkbox"
        name="markdown-task"
        aria-label="Toggle task"
        checked={checked}
        onChange={(event) => {
          const markerOffset = Number(event.currentTarget.closest("li")?.dataset.taskMarkerOffset);
          if (!Number.isSafeInteger(markerOffset)) return;
          onTaskListChange({ markerOffset, checked: event.currentTarget.checked });
        }}
      />
    );
  },
  a: function MarkdownA({ node, href, children, title: _title, ...props }) {
    const {
      canOperateHost,
      canOperatePreview,
      cwd,
      fileLinkWorkspaceRoot,
      environmentId,
      fileLinkChip,
      imageBaseDir,
      linkTargetPreference,
      markdownFileLinkMetaByHref,
      openChangeRequestLink,
      openDeferredMarkdownLink,
      openExternalLinkInPreview,
      openMarkdownMedia,
      projects,
      linkedThreadPullRequestFor,
      resolveThreadPullRequest,
      serverConfig,
      threadRef,
      updateThreadPullRequestLink,
      renderContextReference,
      text,
    } = use(ChatMarkdownRendererContext);
    const citation = href ? parseComposerCitationHref(href) : null;
    if (citation) return <AssistantCitationChip citation={citation} />;
    // SCIENT-FORK:START — older saved links retain their explicit environment.
    const qualifiedThread = href ? parseEnvironmentQualifiedThreadLinkHref(href) : null;
    const linkedThreadId = qualifiedThread?.threadId ?? (href ? parseThreadLinkHref(href) : null);
    const linkedEnvironmentId = qualifiedThread?.environmentId ?? environmentId;
    if (linkedThreadId) {
      const label = hastPlainTextDeep(node) || linkedThreadId;
      return linkedEnvironmentId ? (
        <MarkdownThreadLink
          environmentId={linkedEnvironmentId}
          threadId={linkedThreadId}
          label={label}
          environmentQualified={qualifiedThread !== null}
        />
      ) : (
        <span>{label}</span>
      );
    }
    // SCIENT-FORK:END
    const contextReference = href ? parseComposerContextHref(href) : null;
    if (contextReference) {
      const label = hastPlainTextDeep(node) || contextReference.contextId;
      return renderContextReference ? (
        renderContextReference({ ...contextReference, label })
      ) : (
        <span>{label}</span>
      );
    }
    const normalizedHref = href ? normalizeMarkdownLinkHref(href) : "";
    const fileLinkMeta = normalizedHref
      ? (markdownFileLinkMetaByHref.get(markdownLinkLookupKey(normalizedHref)) ??
        resolveMarkdownFileLinkMeta(
          normalizedHref,
          cwd,
          imageBaseDir ?? cwd,
          fileLinkWorkspaceRoot,
        ))
      : null;
    if (!fileLinkMeta) {
      const faviconHost = resolveExternalWebLinkHost(href);
      const pullRequestAutolink = String(
        (props as Record<string, unknown>)["data-pull-request-autolink"] ?? "",
      );
      const pullRequestCopy =
        pullRequestAutolink === "commit"
          ? /\/commit\/([0-9a-f]{40})$/iu.exec(href ?? "")?.[1]
          : pullRequestAutolink === "reference"
            ? plainHastText(node)
            : undefined;
      const isPullRequestAutolink = pullRequestCopy !== undefined;
      const confirmBeforeOpen = pullRequestAutolink === "reference";
      const pullRequestCandidateUrl =
        confirmBeforeOpen && href ? pullRequestCandidateUrlFromReferenceAutolink(href) : href;
      const pullRequestPreviewTarget = pullRequestCandidateUrl
        ? resolvePullRequestPreviewTarget({
            environmentId,
            projects,
            pullRequestsEnabled: serverConfig?.environment.capabilities.pullRequests === true,
            url: pullRequestCandidateUrl,
          })
        : null;
      const isSameDocumentLink = href?.startsWith("#") ?? false;
      const onClick = props.onClick;
      const canOpenInPreview =
        canOperatePreview && Boolean(threadRef && isPreviewAvailableFor(threadRef.environmentId));
      const linkChildren = <MarkdownLinkContext value>{children}</MarkdownLinkContext>;
      const link = (
        <a
          {...props}
          className={cn(props.className, pullRequestAutolink === "commit" && "font-mono")}
          data-markdown-copy={pullRequestCopy}
          href={href}
          target={isSameDocumentLink ? undefined : "_blank"}
          rel={isSameDocumentLink ? undefined : "noopener noreferrer"}
          onClick={(event) => {
            onClick?.(event);
            if (isSameDocumentLink && href) {
              handleMarkdownFragmentClick(event, href);
              return;
            }
            if (
              href &&
              faviconHost !== null &&
              mediaKindFromPath(href) !== null &&
              !event.defaultPrevented &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey
            ) {
              event.preventDefault();
              event.stopPropagation();
              openMarkdownMedia(
                href,
                undefined,
                event.target instanceof HTMLImageElement
                  ? event.target
                  : event.currentTarget.querySelector("img"),
              );
              return;
            }
            // A link to a change request in a workspace project opens beside the
            // conversation instead of in a browser: it is the thing being talked about, and
            // the panel it opens offers the browser as one of its actions.
            if (
              !href ||
              openChangeRequestLink(event, href, undefined, environmentId ?? undefined)
            ) {
              return;
            }
            // Anything else follows the "Open links in" setting. The system browser
            // keeps the `_blank` the shell already handles; the in-app browser needs
            // the click intercepted here. A modifier click is the way out of the
            // in-app default, so it is left to the shell too.
            if (
              event.defaultPrevented ||
              resolveLinkTarget({
                url: href,
                event,
                preference: linkTargetPreference,
                canOpenInApp: canOpenInPreview,
              }) !== "app"
            ) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            // Keep the link here if saved settings could not be read.
            void openExternalLinkInPreview(href).then((result) => {
              if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
              reportMarkdownActionFailure(
                { operation: "open-link-in-preview", target: href },
                result.cause,
              );
              if (squashAtomCommandFailure(result) instanceof BrowserSettingsReadError) return;
              void readLocalApi()?.shell.openExternal(href);
            });
          }}
          onContextMenu={(event) => {
            if (!href || !faviconHost) return;
            event.preventDefault();
            event.stopPropagation();
            const api = readLocalApi();
            if (!api) return;
            const threadLinkAction = !canOperateHost
              ? undefined
              : linkedThreadPullRequestFor(href) !== null
                ? "unlink-from-thread"
                : resolveThreadPullRequest(href) === null
                  ? undefined
                  : "link-to-thread";
            void showExternalLinkContextMenu({
              href,
              canOpenInPreview,
              threadLinkAction,
              position: { x: event.clientX, y: event.clientY },
              showContextMenu: (items, position) => api.contextMenu.show(items, position),
              openInPreview: async (target) => {
                const result = await openExternalLinkInPreview(target);
                if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                  reportMarkdownActionFailure(
                    { operation: "open-link-in-preview", target },
                    result.cause,
                  );
                }
              },
              openExternal: (target) => api.shell.openExternal(target),
              copyLink: (target) => writeTextToClipboard(target, "link"),
              updateThreadLink: updateThreadPullRequestLink,
              reportFailure: (operation, cause) => {
                reportMarkdownActionFailure({ operation, target: href }, cause);
                if (
                  operation === "link-pull-request-to-thread" ||
                  operation === "unlink-pull-request-from-thread"
                ) {
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title:
                        operation === "link-pull-request-to-thread"
                          ? "Unable to link pull request"
                          : "Unable to unlink pull request",
                      description: cause instanceof Error ? cause.message : "The request failed.",
                    }),
                  );
                }
              },
            });
          }}
        >
          {faviconHost && hastHasText(node) && !isPullRequestAutolink ? (
            <MarkdownExternalLinkContent host={faviconHost} plainText={plainHastText(node)}>
              {linkChildren}
            </MarkdownExternalLinkContent>
          ) : (
            linkChildren
          )}
        </a>
      );
      if (!faviconHost || !href) {
        return link;
      }
      if (pullRequestPreviewTarget !== null) {
        return (
          <PullRequestLinkPreview
            link={link}
            originalUrl={href}
            target={pullRequestPreviewTarget}
            confirmBeforeOpen={confirmBeforeOpen}
            onOpenPullRequest={(targetUrl) =>
              openChangeRequestLink(
                {
                  metaKey: false,
                  ctrlKey: false,
                  preventDefault: () => undefined,
                  stopPropagation: () => undefined,
                },
                targetUrl,
                undefined,
                environmentId ?? undefined,
              )
            }
            onOpenFallback={openDeferredMarkdownLink}
          />
        );
      }
      return (
        <Tooltip>
          <TooltipTrigger render={link} />
          <TooltipPopup side="top">{href}</TooltipPopup>
        </Tooltip>
      );
    }

    const label = nodeToPlainText(children);
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    const source = start !== undefined && end !== undefined ? text.slice(start, end) : "";
    const copyMarkdown =
      source.startsWith("[") && source.includes("](")
        ? source
        : `[${(label || fileLinkMeta.basename).replace(/[\\[\]]/g, "\\$&")}](${normalizedHref})`;
    const chip = fileLinkChip(fileLinkMeta, copyMarkdown, normalizedHref);
    return isMarkdownFileLinkLabel(label, normalizedHref) ? (
      chip
    ) : (
      <span data-markdown-copy={copyMarkdown}>
        {children} {chip}
      </span>
    );
  },
  code: function MarkdownCode({ node, children, className, ...props }) {
    const {
      cwd,
      fileLinkWorkspaceRoot,
      fileLinkChip,
      imageBaseDir,
      inlineCodeFileLinkMetaByText,
      isStreaming,
      authoredMathText,
    } = use(ChatMarkdownRendererContext);

    // SCIENT-FORK:START — retain scientific inline math while Find reveals authored source.
    if (isScientMathCodeClassName(className)) {
      const tex = nodeToPlainText(children);
      return (
        <ScientMathFindSurface sourceText={authoredMathNodeSource(node, authoredMathText, tex)}>
          <ScientInlineMath tex={tex} isStreaming={isStreaming} />
        </ScientMathFindSurface>
      );
    }
    // SCIENT-FORK:END
    if (node?.properties?.dataInlineCode != null) {
      const codeText = nodeToPlainText(children);
      const fileLinkMeta =
        inlineCodeFileLinkMetaByText.get(codeText.trim()) ??
        resolveInlineCodeFileLinkMeta(codeText, cwd, imageBaseDir ?? cwd, fileLinkWorkspaceRoot);
      if (fileLinkMeta) {
        return fileLinkChip(
          fileLinkMeta,
          `\`${codeText}\``,
          inlineCodeFilePathCandidate(codeText) ?? codeText.trim(),
        );
      }

      // SCIENT-FORK:START — render exact CSS colors beside inline code (DF-027)
      const inlineCssColor = resolveInlineCssColor(codeText);
      if (inlineCssColor) {
        return (
          <ScientInlineColorCode
            codeProps={{ ...props, className, dir: "ltr" }}
            color={inlineCssColor}
          >
            {children}
          </ScientInlineColorCode>
        );
      }
      // SCIENT-FORK:END
    }
    return (
      <code {...props} className={className} dir="ltr">
        {children}
      </code>
    );
  },
  table: function MarkdownTableRenderer({ node: _node, ...props }) {
    const { resolvedContentDirection } = use(ChatMarkdownRendererContext);

    const tableDirection =
      props.dir === "rtl" || props.dir === "ltr" ? props.dir : resolvedContentDirection;
    return <MarkdownTable {...props} dir={tableDirection} />;
  },
  details: function MarkdownDetailsRenderer({ node: _node, children, open: detailsOpen }) {
    return <MarkdownDetails open={detailsOpen}>{children}</MarkdownDetails>;
  },
  pre: function MarkdownPre({ node, children, ...props }) {
    const {
      diffThemeName,
      isStreaming,
      onRunShellCommand,
      resolvedContentDirection,
      resolvedTheme,
      text,
      authoredMathText,
    } = use(ChatMarkdownRendererContext);

    const codeBlock = extractCodeBlock(children);
    if (!codeBlock) {
      return <pre {...props}>{children}</pre>;
    }
    // SCIENT-FORK:START — retain scientific display math while Find reveals authored source.
    if (isScientMathCodeClassName(codeBlock.className)) {
      return (
        <ScientMathFindSurface
          sourceText={authoredMathNodeSource(node, authoredMathText, codeBlock.code)}
        >
          <ScientDisplayMath tex={codeBlock.code} isStreaming={isStreaming} />
        </ScientMathFindSurface>
      );
    }

    // SCIENT-FORK:END
    const language = extractFenceLanguage(codeBlock.className);
    const fenceMeta = extractPreCodeMeta(node);
    const fenceTitle = extractFenceTitle(fenceMeta);
    const richFenceKind = !isStreaming ? resolveScientRichFenceKind(language) : null;
    if (richFenceKind != null) {
      return (
        <RenderErrorBoundary
          resetKeys={[codeBlock.code, codeBlock.className, diffThemeName, isStreaming]}
          fallback={<pre {...props}>{children}</pre>}
        >
          <ScientRichFence
            fenceMeta={fenceMeta}
            kind={richFenceKind}
            language={language}
            source={codeBlock.code}
            theme={resolvedTheme}
            title={fenceTitle}
          />
        </RenderErrorBoundary>
      );
    }
    // SCIENT-FORK:START — shared with the Copy message button's rich flavour
    const copyTextDirection = chatCodeBoxDirection({
      code: codeBlock.code,
      language,
      fenceMeta,
      conversationDirection: resolvedContentDirection,
      isStreaming,
    });
    // SCIENT-FORK:END
    return (
      <MarkdownCodeBlock
        code={codeBlock.code}
        language={language}
        fenceTitle={fenceTitle}
        theme={resolvedTheme}
        onRunShellCommand={
          onRunShellCommand &&
          /^(?:sh|bash|zsh|fish|shell|powershell|pwsh)$/.test(language) &&
          !isStreaming &&
          isClosedCodeFence(node, text)
            ? onRunShellCommand
            : undefined
        }
        copyTextDirection={copyTextDirection}
        isStreaming={isStreaming}
        fallback={<pre {...props}>{children}</pre>}
        onCopyFailure={(cause) =>
          reportMarkdownActionFailure(
            { operation: "copy-code-block", language, ...(fenceTitle ? { fenceTitle } : {}) },
            cause,
          )
        }
      />
    );
  },
} satisfies Components;

function ChatMarkdown(props: ChatMarkdownProps) {
  const {
    componentState,
    text,
    remarkPlugins,
    className,
    parseRawHtml,
    resolvedContentDirection,
    effectiveContentDirection,
    handleCopy,
    markdownRef,
    markdownUrlTransform,
    localMediaPreview,
    setLocalMediaPreview,
  } = useChatMarkdownState(props);
  // react-markdown converts unparsed HTML nodes to text when skipHtml is false.
  // Keep that behavior explicit because literal mode depends on escaping the
  // complete source token instead of dropping it from the rendered message.
  return (
    <div
      ref={markdownRef}
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/[calc(80%+var(--appearance-contrast-boost)/5)] [overflow-wrap:anywhere] [word-break:break-word]",
        className,
      )}
      dir={resolvedContentDirection}
      data-scient-content-direction={resolvedContentDirection}
      // Gates the fade-in for blocks that arrive while the response streams.
      data-streaming={componentState.isStreaming ? "" : undefined}
      onCopy={handleCopy}
    >
      <ChatMarkdownRendererContext value={componentState}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={[
            ...(parseRawHtml
              ? CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS
              : CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS),
            [
              rehypeScientBidi,
              {
                direction: resolvedContentDirection,
                requestedDirection: effectiveContentDirection,
              },
            ],
          ]}
          skipHtml={false}
          components={CHAT_MARKDOWN_COMPONENTS}
          urlTransform={markdownUrlTransform}
        >
          {text}
        </ReactMarkdown>
      </ChatMarkdownRendererContext>
      {localMediaPreview ? (
        <ExpandedImageDialog
          preview={localMediaPreview}
          onClose={() => setLocalMediaPreview(null)}
        />
      ) : null}
    </div>
  );
}

export default memo(ChatMarkdown);
