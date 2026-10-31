// SCIENT-FORK:START — Scient's code block and inline-colour code (scient/**). Kept first so the
// stylesheets they bring keep their place in the cascade.
import { MarkdownCodeBlock as ScientMarkdownCodeBlock } from "~/scient/presentation/MarkdownCodeBlock";
import { resolveInlineCssColor } from "~/scient/markdown/inlineCssColor";
import { ScientInlineColorCode } from "~/scient/markdown/ScientInlineColorCode";
// SCIENT-FORK:END
import { buildFileLinkParentSuffixByPath, fileLinkLabel } from "@t3tools/shared/fileLinks";
import {
  isWindowsDrivePathHref,
  normalizeMarkdownLinkDestination,
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  inlineCodeFilePathCandidate,
} from "@t3tools/shared/markdownLinks";
import { isAbsolutePath, resolveWorkspaceFilePath } from "@t3tools/shared/path";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  SOURCE_CONTROL_MEDIA_ASSET,
} from "@t3tools/contracts";
// SCIENT-FORK:START — scientific refinements extend the shared markdown pipeline.
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REHYPE_PLUGINS_WITHOUT_RAW,
} from "../scient/markdown/scientMarkdownPipeline";
// SCIENT-FORK:END
import { useAtomValue } from "@effect/atom-react";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
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
  AssetWorkspaceAssetNotFoundError,
  AuthPreviewOperateScope,
  type EditorId,
  type EnvironmentId,
  // SCIENT-FORK:START — streaming reveal and direction are scoped to one message.
  type MessageId,
  // SCIENT-FORK:END
  type ServerConfig,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
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
import { mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import { mediaKindFromPath, mediaMimeTypeFromExtension } from "@t3tools/shared/mediaPreview";
import { InlineAudioPreview } from "./files/InlineAudioPreview";
import { HostImageUrlContext } from "./chat/hostImageUrl";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import React, {
  type ComponentProps,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
  use,
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Components,
  ExtraProps as ReactMarkdownExtraProps,
  Options as ReactMarkdownOptions,
} from "react-markdown";
import { createIncrementalMarkdownPlugin } from "../markdown-incremental";
import type { PluggableList } from "unified";
import { defaultUrlTransform } from "react-markdown";
// SCIENT-FORK:START — quotes from Markdown files render as citation chips too.
import { parseComposerCitationHref } from "@t3tools/shared/composerCitations";
// SCIENT-FORK:END
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { AssistantCitationChip } from "./chat/AssistantCitationChip";
import { MarkdownThreadLink } from "./chat/MarkdownThreadLink";
// SCIENT-FORK:START — a streaming answer is revealed line by line (
// chat/useStreamingBlockEntrance.ts).
import { useStreamingBlockEntrance } from "./chat/useStreamingBlockEntrance";
// SCIENT-FORK:END
import {
  artifactTemplateFromHastProperties,
  renderCodexInlineDirectivesAsMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import { renderSkillInlineMarkdownChildren } from "./chat/SkillInlineText";
import {
  resolveMarkdownMediaPreview,
  type ExpandedImagePreview,
} from "./chat/ExpandedImagePreview";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { markdownImageGallery } from "./chat/markdownImageGallery";
import { type MediaActionSource } from "./media/MediaActions";
import { resolveProtocolRelativeMediaUrl } from "./media/mediaContent";
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
import { stackedThreadToast, toastManager } from "./ui/toast";
import { recordVisitForThread } from "../browserHistoryStore";
import {
  PreferredEditorEnvironmentRequiredError,
  useOpenInPreferredEditor,
  usePreferredEditor,
} from "../editorPreferences";
import { openInEditorMenuLabel } from "../editorLabels";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { useRenderedAppearance } from "../hooks/useTheme";
import { useClientSettings } from "../hooks/useSettings";
import { chatMarkdownClipboardPayload } from "../markdown-clipboard";
// SCIENT-FORK:START — file links use the canonical workspace-file lookup key.
import {
  markdownLinkLookupKey,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  type MarkdownFileLinkMeta,
} from "../markdown-links";
// SCIENT-FORK:END
import {
  markdownFileCopyPaths,
  markdownFileEditorTarget,
  resolveMarkdownFileHostPath,
} from "../markdownFileHostPath";
import { isMarkdownFileLinkLabel } from "@t3tools/shared/markdownLinks";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import { resolveRemoteOpenState, useRemoteOpenResolution } from "../remoteOpen";
import { useRightPanelStore } from "../rightPanelStore";
import { readThreadShell, useProjects } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { shellEnvironment } from "../state/shell";
import { assetEnvironment } from "../state/assets";
import {
  readEnvironmentScope,
  readPreparedConnection,
  usePreparedConnection,
  useEnvironmentScope,
} from "../state/session";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { projectEnvironment } from "../state/projects";
import { filesystemEnvironment } from "../state/filesystem";
import {
  needsWorkspaceBasenameLookup,
  pickStrippedWorkspaceMatch,
  pickWorkspaceBasenameMatch,
  stripRepeatedWorkspacePrefix,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "@t3tools/client-runtime/workspace-basename-lookup";
import { resolvePullRequestPreviewTarget } from "@t3tools/client-runtime/change-request-links";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useOpenChangeRequestLink } from "~/lib/openPullRequestLink";
import { useOpenLink } from "../browser/useOpenLink";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
// SCIENT-FORK:START — Scient chat-markdown capabilities: file-link opening and copy, direction,
// rich fences, images and math. Their bodies live under scient/**.
import {
  openFileInPreview,
  openUrlInPreview,
  BrowserPreviewUnavailableError,
  resolveWorkspaceFileLinkOpenTarget,
  BrowserSettingsReadError,
} from "../browser/openFileInPreview";
import { type ContentDirection, type FixedContentDirection } from "../scient/bidi/contentDirection";
import { chatCodeBoxDirection } from "../scient/bidi/chatCodeBoxDirection";
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
  authoredMathNodeSource,
  ScientAuthoredMathTextContext,
  scientMathMarkdownText,
  scientMathRemarkPluginsForMessage,
} from "../scient/math/scientMathText";
import { ScientDisplayMath, ScientInlineMath } from "../scient/math/ScientMath";
import { ScientMathFindSurface } from "../scient/math/ScientMathFindSurface";
import {
  useChatEnvironmentHtmlPreview,
  useChatFileLinkOpening,
} from "../scient/fileOpening/useChatFileLinkOpening";
import { environmentFileLinkResolution } from "../scient/fileOpening/environmentFileState";
// SCIENT-FORK:END
import { resolveLinkTarget } from "../browser/browserLinkTarget";
import { PullRequestLinkPreview } from "./pullRequest/PullRequestLinkPreview";
import { createMarkdownRenderer } from "./chat/markdownRenderer";
import { splitMarkdownBlocks } from "./chat/markdownStreamBlocks";
import { MarkdownTable } from "./chat/MarkdownTable";
import { MarkdownDetails } from "./chat/MarkdownDetails";
import {
  authoredImageSizeStyle,
  ChatMarkdownAssetImage,
  ChatMarkdownImage,
  ChatMarkdownImageFallback,
  ChatMarkdownVideo,
  MarkdownLinkContext,
} from "./chat/ChatMarkdownMedia";
import { MarkdownExternalLinkContent } from "./chat/MarkdownExternalLink";
import { MarkdownFileLink } from "./chat/MarkdownFileLink";
import { canUseMarkdownFileShellActions } from "./chat/MarkdownFileLink.logic";
import { rehypeChipPunctuation } from "./chat/markdownChipPunctuation";
import { handleMarkdownFragmentClick, rehypeHeadingIds } from "./chat/markdownFragments";
import { hastHasText, hastPlainTextDeep, plainHastText } from "./chat/markdownHast.logic";
import {
  extractCodeBlock,
  extractFenceLanguage,
  extractFenceTitle,
  extractPreCodeMeta,
  isClosedCodeFence,
  nodeToPlainText,
} from "./chat/MarkdownCodeBlock.logic";
import { reportMarkdownActionFailure } from "./chat/markdownActionFailure";

const isAssetNotFoundError = Schema.is(AssetWorkspaceAssetNotFoundError);

interface ChatMarkdownProps {
  /** Compact markdown transforms remove blocks before rendering inside a label. */
  inline?: boolean;
  text: string;
  cwd: string | undefined;
  // SCIENT-FORK:START — file links resolve against the editable workspace root.
  /** Root whose descendants belong to the editable workspace; null keeps resolved links external. */
  fileLinkWorkspaceRoot?: string | null;
  // SCIENT-FORK:END
  threadRef?: ScopedThreadRef | undefined;
  pullRequestPanelRef?: ScopedThreadRef | undefined;
  environmentId?: EnvironmentId | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
  isStreaming?: boolean;
  skills?: ReadonlyArray<ServerProviderSkill>;
  className?: string;
  lineBreaks?: boolean;
  // SCIENT-FORK:START — content direction; `messageId` also scopes the streaming reveal.
  /** Overrides the conversation scope for document/file previews. */
  contentDirection?: ContentDirection;
  /** Stable identity used to scope automatic streaming direction. */
  messageId?: MessageId | undefined;
  /** Direction hint from the preceding user message during streaming. */
  directionHint?: FixedContentDirection | null | undefined;
  // SCIENT-FORK:END
  parseRawHtml?: boolean;
  onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  onRunShellCommand?: ((command: string) => void) | undefined;
  imageBaseDir?: string | undefined;
  // SCIENT-FORK:START — file previews caption standalone images (scient/images).
  /** File previews share the rich editor's standalone title-as-caption presentation. */
  imageCaptions?: boolean | undefined;
  // SCIENT-FORK:END
  workspaceMutationId?: string | null | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  extraRemarkPlugins?: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  renderContextReference?: ((reference: ChatMarkdownContextReference) => ReactNode) | undefined;
  /** Loads media a source control host keeps behind a credential through the server, which holds
      `cwd`'s; without it a private repository's uploads load unauthenticated and 404. */
  sourceControlMedia?: boolean | undefined;
  // SCIENT-FORK:START — a broken file link may resolve to the one changed file it names.
  /** Files the turn that produced this message changed, relative to `cwd`. A
      link whose location does not exist resolves to one of them only when it
      names exactly one; see `pickChangedFileForLink`. */
  changedFiles?: ReadonlyArray<{ readonly path: string }> | undefined;
  // SCIENT-FORK:END
  headingLevelOffset?: number | undefined;
}

export interface ChatMarkdownContextReference {
  kind: string;
  contextId: string;
  label: string;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
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
      data-chat-markdown-artifact-template
      className="my-[0.65rem] flex w-full min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-foreground shadow-xs"
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

const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;

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

// SCIENT-FORK:START — the Copy message button's rich flavour reads Markdown with chat's own
// readers (scient/clipboard/chatMarkdownPipeline.ts).
export {
  extractCodeBlock,
  extractFenceLanguage,
  extractPreCodeMeta,
  GITHUB_ALERT_PRESENTATIONS,
  nodeToPlainText,
};
// SCIENT-FORK:END
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

function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const rewrittenHref = rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
  return WINDOWS_DRIVE_PATH_REGEX.test(rewrittenHref)
    ? rewrittenHref.replaceAll("\\", "/")
    : rewrittenHref;
}

// Heading ids are added after sanitizing, which would prefix them a second time.
const CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS = [
  ...CHAT_MARKDOWN_REHYPE_PLUGINS,
  rehypeHeadingIds,
  rehypeChipPunctuation,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

// SCIENT-FORK:START — retain safe scientific images without opting into raw HTML.
const CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS = [
  ...CHAT_MARKDOWN_REHYPE_PLUGINS_WITHOUT_RAW,
  rehypeHeadingIds,
  rehypeChipPunctuation,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
// SCIENT-FORK:END

// SCIENT-FORK:START — one stable list per direction keeps the shared renderer and its cache.
const directionalRehypeLists = new Map<string, PluggableList>();
function directionalRehypePlugins(
  parseRawHtml: boolean,
  options: Parameters<typeof rehypeScientBidi>[0],
): PluggableList {
  const key = `${parseRawHtml}\0${options.direction}\0${options.requestedDirection}`;
  let plugins = directionalRehypeLists.get(key);
  if (!plugins) {
    plugins = [
      ...(parseRawHtml
        ? CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS
        : CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS),
      [rehypeScientBidi, options],
    ];
    directionalRehypeLists.set(key, plugins);
  }
  return plugins;
}
// SCIENT-FORK:END

function markdownUrlTransform(href: string) {
  // SCIENT-FORK:START — quotes from Markdown files are citations too.
  if (parseComposerCitationHref(href)) return href;
  // SCIENT-FORK:END
  if (parseComposerContextHref(href)) return href;
  if (parseThreadLinkHref(href)) return href;
  if (isWindowsDrivePathHref(href)) return href;
  return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
}

const NO_MARKDOWN_EDITORS: ReadonlyArray<EditorId> = [];

type MarkdownServerConfigFields = ReturnType<typeof markdownServerConfigFields>;

function markdownServerConfigFields(config: ServerConfig | null) {
  return {
    pullRequestsEnabled: config !== null,
    availableEditors: config?.availableEditors ?? NO_MARKDOWN_EDITORS,
    revealInFileManagerLabel:
      config?.shellRevealInFileManager === true && config.availableEditors.includes("file-manager")
        ? config.shellRevealInFileManagerKind === undefined
          ? revealInFileExplorerLabelForOs(config.environment.platform.os)
          : revealInFileExplorerLabelForKind(config.shellRevealInFileManagerKind)
        : undefined,
  };
}

function markdownServerConfigFieldsEqual(
  previous: MarkdownServerConfigFields,
  next: MarkdownServerConfigFields,
): boolean {
  return (
    previous.pullRequestsEnabled === next.pullRequestsEnabled &&
    previous.revealInFileManagerLabel === next.revealInFileManagerLabel &&
    previous.availableEditors.length === next.availableEditors.length &&
    previous.availableEditors.every((editor, index) => editor === next.availableEditors[index])
  );
}

// Compare only markdown config fields to avoid rerendering replies on every provider status push.
const markdownServerConfigFieldsAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) => {
    const next = markdownServerConfigFields(get(serverEnvironment.configValueAtom(environmentId)));
    const previous = Option.getOrNull(get.self<MarkdownServerConfigFields>());
    return previous !== null && markdownServerConfigFieldsEqual(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("markdown-server-config-fields")),
);

function fileLinkSourcesKey(
  text: string,
  cwd: string | undefined,
  imageBaseDir: string | undefined,
  // SCIENT-FORK:START — links resolve against the editable workspace root.
  workspaceRoot: string | null | undefined,
  // SCIENT-FORK:END
): string {
  const hrefs = extractMarkdownLinkHrefs(renderCodexInlineDirectivesAsMarkdown(text))
    .filter((href) => !parseComposerContextHref(href))
    .map(normalizeMarkdownLinkHrefKey)
    .filter((href) => resolveMarkdownFileLinkMeta(href, cwd, imageBaseDir ?? cwd, workspaceRoot));
  const spans = extractInlineCodeSpans(text).filter((span) =>
    resolveInlineCodeFileLinkMeta(span, cwd, imageBaseDir ?? cwd, workspaceRoot),
  );
  return JSON.stringify([[...new Set(hrefs)], [...new Set(spans)]]);
}

function resolveFileLinkSources(
  key: string,
  cwd: string | undefined,
  imageBaseDir: string | undefined,
  // SCIENT-FORK:START — links resolve against the editable workspace root.
  workspaceRoot: string | null | undefined,
  // SCIENT-FORK:END
) {
  const [hrefs, spans] = JSON.parse(key) as [string[], string[]];
  const markdownFileLinkMetaByHref = new Map<string, MarkdownFileLinkMeta>();
  for (const href of hrefs) {
    // SCIENT-FORK:START — looked up by the link's key (markdown-links.ts).
    const lookupKey = markdownLinkLookupKey(href);
    if (markdownFileLinkMetaByHref.has(lookupKey)) continue;
    const meta = resolveMarkdownFileLinkMeta(href, cwd, imageBaseDir ?? cwd, workspaceRoot);
    if (meta) markdownFileLinkMetaByHref.set(lookupKey, meta);
    // SCIENT-FORK:END
  }
  const inlineCodeFileLinkMetaByText = new Map<string, MarkdownFileLinkMeta>();
  for (const span of spans) {
    const meta = resolveInlineCodeFileLinkMeta(span, cwd, imageBaseDir ?? cwd, workspaceRoot);
    if (meta) inlineCodeFileLinkMetaByText.set(span, meta);
  }
  const fileLinkParentSuffixByPath = buildFileLinkParentSuffixByPath([
    ...[...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath),
    ...[...inlineCodeFileLinkMetaByText.values()].map((meta) => meta.filePath),
  ]);
  return { markdownFileLinkMetaByHref, inlineCodeFileLinkMetaByText, fileLinkParentSuffixByPath };
}

function useChatMarkdownState({
  // SCIENT-FORK:START — math normalization keeps the authored text for Find.
  text: textProp,
  // SCIENT-FORK:END
  inline = false,
  cwd,
  // SCIENT-FORK:START — file links resolve against the editable workspace root.
  fileLinkWorkspaceRoot,
  // SCIENT-FORK:END
  threadRef,
  pullRequestPanelRef,
  environmentId: explicitEnvironmentId,
  onTaskListChange,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  // SCIENT-FORK:START — content direction; `messageId` also scopes the streaming reveal.
  contentDirection,
  messageId,
  directionHint,
  // SCIENT-FORK:END
  onUseArtifactTemplate,
  onRunShellCommand,
  imageBaseDir,
  // SCIENT-FORK:START — file previews caption standalone images.
  imageCaptions = false,
  // SCIENT-FORK:END
  workspaceMutationId,
  onImageExpand,
  renderContextReference,
  headingLevelOffset = 0,
  sourceControlMedia = false,
  // SCIENT-FORK:START — a broken file link may resolve to the one changed file it names.
  changedFiles,
  // SCIENT-FORK:END
}: ChatMarkdownProps) {
  // SCIENT-FORK:START — length-preserving delimiter normalization keeps offset-based actions correct.
  // Retain original text so refinement can recover each backslash pair's inline/display intent.
  const text = scientMathMarkdownText(textProp);
  // The message direction is held while an auto message streams.
  const { effectiveContentDirection, resolvedContentDirection } = useChatContentDirection({
    text,
    contentDirection,
    messageId,
    directionHint,
    isStreaming,
  });
  // SCIENT-FORK:END
  const resolvedTheme = useRenderedAppearance();
  const markdownRef = useRef<HTMLElement>(null);
  // SCIENT-FORK:START — a streaming answer is revealed line by line (chat/useStreamingBlockEntrance.ts).
  useStreamingBlockEntrance(markdownRef, isStreaming, messageId);
  // SCIENT-FORK:END
  const mediaRequestId = useRef(0);

  const mediaScopeKey = [
    threadRef?.environmentId,
    threadRef?.threadId,
    explicitEnvironmentId,
    cwd,
    imageBaseDir,
  ].join("\u0000");
  // Hide requests from an old scope even if they resolve before effect cleanup.
  const [localMedia, setLocalMedia] = useState<{
    scope: string;
    preview: ExpandedImagePreview;
  } | null>(null);
  const localMediaPreview = localMedia?.scope === mediaScopeKey ? localMedia.preview : null;
  const closeLocalMediaPreview = () => setLocalMedia(null);
  const expandMedia =
    onImageExpand ??
    ((preview: ExpandedImagePreview) => setLocalMedia({ scope: mediaScopeKey, preview }));
  const [mediaScope, setMediaScope] = useState(mediaScopeKey);
  if (mediaScope !== mediaScopeKey) {
    setMediaScope(mediaScopeKey);
    setLocalMedia(null);
  }
  // Layout cleanup blocks stale requests from reaching onImageExpand before paint.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- layout cleanup invalidates media requests still loading for the old scope before paint
  useLayoutEffect(
    () => () => {
      mediaRequestId.current += 1;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Leaving the scope invalidates media requests still loading for it.
    [mediaScopeKey],
  );
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const searchProjectEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    reportFailure: false,
  });
  // SCIENT-FORK:START — every file link asks the environment what it means.
  const resolveEnvironmentFileLink = useAtomQueryRunner(environmentFileLinkResolution, {
    reportFailure: false,
    refresh: true,
  });
  // SCIENT-FORK:END
  const getFilesystemMetadata = useAtomQueryRunner(filesystemEnvironment.getMetadata, {
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
  // SCIENT-FORK: the environment HTML preview uses the reactive connection.
  const preparedConnection = usePreparedConnection(environmentId);
  const openMarkdownMedia = (
    source: string,
    resolvedFilePath?: string,
    clickedImage?: HTMLImageElement | null,
  ) => {
    const requestId = ++mediaRequestId.current;
    void resolveMarkdownMediaPreview({
      source,
      resolvedFilePath,
      cwd,
      threadRef,
      // Read the connection on click; reconnect replaces it, and subscriptions would refresh every markdown
      // context.
      httpBaseUrl:
        environmentId === null ? undefined : readPreparedConnection(environmentId)?.httpBaseUrl,
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
        let description =
          error instanceof Error
            ? error.message
            : "The file could not be loaded. It may have been moved or deleted.";
        if (
          isAssetNotFoundError(error) &&
          error.resource._tag === "media-file" &&
          environmentId !== null
        ) {
          // The connection may resolve while the media lookup is pending.
          const target = readPreparedConnection(environmentId)?.target ?? null;
          if (
            target !== null &&
            resolveRemoteOpenState({
              target,
              sshTarget: null,
              remoteOpenTargets: undefined,
              isDesktopRenderer: window.desktopBridge !== undefined,
            }).mode !== "local-exec"
          ) {
            description = `The file was not found on ${target.label} at ${error.checkedPath ?? error.resource.path}.`;
          }
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Media unavailable",
            description,
          }),
        );
      },
    );
  };
  const { pullRequestsEnabled, availableEditors, revealInFileManagerLabel } = useAtomValue(
    markdownServerConfigFieldsAtom(environmentId),
  );
  const projects = useProjects();
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const preferredEditorMenuLabel = openInEditorMenuLabel(preferredEditor);
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const revealFileInFileManager = (filePath: string) => {
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
  };
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const handleCopy = (event: ReactClipboardEvent<HTMLElement>) => {
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
  };
  const openChangeRequestLink = useOpenChangeRequestLink(threadRef, pullRequestPanelRef);
  const openDeferredMarkdownLink = useOpenLink(threadRef);
  // Subscribe so hydrated settings apply before the anchor synchronously decides whether to intercept _blank.
  const linkTargetPreference = useClientSettings((settings) => settings.browserLinkTarget);
  // Keyed by the file links found, not the text, so streamed text that adds none keeps the
  // renderer context, and every block reading it, unchanged.
  // A template literal marks the key as a string, so the compiler memoizes the maps on its value.
  const fileLinksKey = `${fileLinkSourcesKey(text, cwd, imageBaseDir, fileLinkWorkspaceRoot)}`;
  const { markdownFileLinkMetaByHref, inlineCodeFileLinkMetaByText, fileLinkParentSuffixByPath } =
    resolveFileLinkSources(fileLinksKey, cwd, imageBaseDir, fileLinkWorkspaceRoot);
  const resolveThreadPullRequest = (
    href: string,
  ): (ThreadPullRequestKey & { readonly url: string }) | null => {
    if (
      threadRef === undefined ||
      readThreadShell(threadRef) === null ||
      !pullRequestLinking.canLink(href)
    )
      return null;
    const parsed = sourceControlClients.parseChangeRequestUrl(href)?.link;
    return parsed === undefined ? null : { ...parsed, url: href };
  };
  const linkedThreadPullRequestFor = (href: string) => {
    if (threadRef === undefined || !pullRequestLinking.isLinked(readThreadShell(threadRef), href))
      return null;
    const parsed = sourceControlClients.parseChangeRequestUrl(href)?.link;
    return parsed === undefined ? null : { ...parsed, url: href };
  };
  const updateThreadPullRequestLink = async (href: string, linked: boolean) => {
    if (threadRef === undefined || (!linked && linkedThreadPullRequestFor(href) === null)) return;
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    await pullRequestLinking.changeLink(threadRef, href, linked);
  };
  const openExternalLinkInPreview = (url: string) => {
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
  };
  // SCIENT-FORK:START — the hook's original click intent crosses this existing Browser seam.
  const openMarkdownFileInPreview = (
    path: string,
    _workspaceRelativePath: string,
    isCurrent?: () => boolean,
  ) => {
    // SCIENT-FORK:END
    const preparedConnection = threadRef ? readPreparedConnection(threadRef.environmentId) : null;
    if (!threadRef || !cwd || !canOperatePreview || preparedConnection === null) {
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
      filePath: path,
      workspaceRoot: cwd,
      httpBaseUrl: preparedConnection.httpBaseUrl,
      createAssetUrl,
      openPreview,
      // SCIENT-FORK:START — retain intent through capability minting and Browser opening.
      ...(isCurrent ? { isCurrent } : {}),
      // SCIENT-FORK:END
    });
  };
  // SCIENT-FORK:START — pages outside the workspace open in the integrated browser
  const openEnvironmentHtmlInPreview = useChatEnvironmentHtmlPreview({
    threadRef,
    preparedConnection,
    createAssetUrl,
    openPreview,
  });
  // SCIENT-FORK:END
  const findWorkspaceFileMatch = async (fileLinkMeta: MarkdownFileLinkMeta) => {
    const workspaceRelativePath = fileLinkMeta.workspaceLookupPath;
    if (
      !workspaceRelativePath ||
      !cwd ||
      environmentId === null ||
      !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
    ) {
      return null;
    }
    const isBasename = needsWorkspaceBasenameLookup(workspaceRelativePath);
    const strippedPath = isBasename
      ? null
      : stripRepeatedWorkspacePrefix(workspaceRelativePath, cwd);
    if (!isBasename && strippedPath === null) return null;
    const result = await searchProjectEntries({
      environmentId,
      input: {
        cwd,
        query: strippedPath ?? workspaceRelativePath,
        limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
        kind: "file",
      },
    });
    if (result._tag !== "Success") return null;
    if (strippedPath === null) {
      return pickWorkspaceBasenameMatch(workspaceRelativePath, result.value.entries);
    }
    const match = pickStrippedWorkspaceMatch(strippedPath, cwd, result.value.entries);
    if (match === null) return null;
    // Search can be truncated or still scanning, so it cannot rule out the
    // literal path. Check the host before redirecting to the stripped match.
    const metadata = await getFilesystemMetadata({
      environmentId,
      input: { paths: [resolveWorkspaceFilePath(workspaceRelativePath, cwd)] },
    });
    return metadata._tag === "Success" && metadata.value.entries[0] === null ? match : null;
  };
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
  const fileLinkChip = (
    fileLinkMeta: MarkdownFileLinkMeta,
    copyMarkdown: string,
    mediaSource?: string,
  ) => {
    // SCIENT-FORK:START — HTML opens in the browser by its workspace-relative path.
    const browserRelativePath = fileLinkMeta.workspaceRelativePath;
    // SCIENT-FORK:END
    const resolveHostPath = () =>
      resolveMarkdownFileHostPath({
        meta: fileLinkMeta,
        cwd,
        findWorkspaceMatch: () => findWorkspaceFileMatch(fileLinkMeta),
      });
    const mediaPath = mediaSource ?? fileLinkMeta.filePath;
    const canPreviewMedia =
      mediaMimeTypeFromExtension(
        fileLinkMeta.basename.slice(fileLinkMeta.basename.lastIndexOf(".")),
      ) !== null;
    // SCIENT-FORK:START — only the environment owning the files can resolve home-relative links.
    // Pass authored ~/ paths unchanged; media uses its environment action because it has no panel path.
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
    // SCIENT-FORK:END

    return (
      <MarkdownFileLink
        environmentId={environmentId}
        href={fileLinkMeta.targetPath}
        targetPath={fileLinkMeta.targetPath}
        iconPath={fileLinkMeta.filePath}
        workspaceRelativePath={fileLinkMeta.workspaceRelativePath}
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
        onOpen={
          canUseShellActions
            ? async () =>
                openInPreferredEditor(
                  markdownFileEditorTarget(fileLinkMeta, await resolveHostPath()),
                )
            : undefined
        }
        resolveCopyPaths={async () =>
          markdownFileCopyPaths(fileLinkMeta, await resolveHostPath(), cwd)
        }
        // SCIENT-FORK:START — every file link asks the environment what it means.
        onOpenInPanel={
          homeRelativePath !== undefined
            ? openHomeRelativeLinkInPanel
            : (path, line) =>
                openFileInPanel(
                  path,
                  line,
                  fileLinkMeta.workspaceLookupPath
                    ? () => findWorkspaceFileMatch(fileLinkMeta)
                    : undefined,
                )
        }
        onOpenMedia={
          threadRef && canPreviewMedia
            ? () => openMarkdownMediaLink(mediaPath, fileLinkMeta.filePath, homeRelativePath)
            : undefined
        }
        // SCIENT-FORK:END
        openInEditorMenuLabel={preferredEditorMenuLabel}
        onReveal={
          canUseShellActions && revealInFileManagerLabel !== undefined
            ? async () => revealFileInFileManager((await resolveHostPath()).absolutePath)
            : undefined
        }
        revealLabel={revealInFileManagerLabel}
        // SCIENT-FORK:START — the browser target follows the canonical workspace-file policy;
        // pages outside the workspace open through the environment.
        onOpenInBrowser={
          threadRef &&
          canOperatePreview &&
          isPreviewAvailableFor(threadRef.environmentId) &&
          resolveWorkspaceFileLinkOpenTarget(fileLinkMeta.filePath) === "browser"
            ? () =>
                openHtmlLinkInBrowser(fileLinkMeta.filePath, browserRelativePath, homeRelativePath)
            : undefined
        }
        // SCIENT-FORK:END
      />
    );
  };

  const componentState = (() => ({
    canOperateHost,
    canOperatePreview,
    cwd,
    diffThemeName,
    environmentId,
    expandMedia,
    fileLinkChip,
    sourceControlMedia,
    renderContextReference,
    headingLevelOffset,
    imageBaseDir,
    workspaceMutationId,
    inlineCodeFileLinkMetaByText,
    inline,
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
    pullRequestsEnabled,
    skills,
    threadRef,
    updateThreadPullRequestLink,
    // SCIENT-FORK:START — file-link root, image captions and direction.
    fileLinkWorkspaceRoot,
    imageCaptions,
    resolvedContentDirection,
    // SCIENT-FORK:END
  }))();
  return {
    componentState,
    // SCIENT-FORK:START — math-normalized text and the message direction.
    markdownText: text,
    resolvedContentDirection,
    effectiveContentDirection,
    // SCIENT-FORK:END
    handleCopy,
    markdownRef,
    localMediaPreview,
    closeLocalMediaPreview,
  };
}

const ChatMarkdownRendererContext = React.createContext<
  ReturnType<typeof useChatMarkdownState>["componentState"]
>(null!);

// Isolate streamed source text from the renderer context; only offset-based renderers need it.
const ChatMarkdownTextContext = React.createContext("");

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

// Native word selection stops at hyphens and dots, so a double-click takes the whole span.
function selectInlineCode(event: ReactMouseEvent<HTMLElement>) {
  window.getSelection()?.selectAllChildren(event.currentTarget);
}

const CHAT_MARKDOWN_COMPONENTS = {
  h1: markdownHeadingRenderer(1),
  h2: markdownHeadingRenderer(2),
  h3: markdownHeadingRenderer(3),
  h4: markdownHeadingRenderer(4),
  h5: markdownHeadingRenderer(5),
  h6: markdownHeadingRenderer(6),
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
  p: function MarkdownParagraph({ node: _node, children, ...props }) {
    const { skills, threadRef } = use(ChatMarkdownRendererContext);
    return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills, threadRef)}</p>;
  },
  blockquote: function MarkdownBlockquote({ node: _node, children, ...props }) {
    const alert =
      GITHUB_ALERT_PRESENTATIONS[String((props as Record<string, unknown>)["data-alert"] ?? "")];
    if (!alert) {
      return <blockquote {...props}>{children}</blockquote>;
    }
    return (
      <div
        role="note"
        dir={props.dir}
        className={cn("my-1 border-s-2 ps-3", alert.borderClassName)}
      >
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
  ol: function MarkdownOrderedList({ node, start, style, ...props }) {
    const itemCount =
      node?.children?.filter((child) => child.type === "element" && child.tagName === "li")
        .length ?? 0;
    const gutterStyle = orderedListGutterStyle(itemCount, start);
    return (
      <ol {...props} start={start} style={gutterStyle ? { ...style, ...gutterStyle } : style} />
    );
  },
  li: function MarkdownListItem({ node, children, ...props }) {
    const { skills, threadRef } = use(ChatMarkdownRendererContext);
    // Resolve checkbox markers by offset to avoid rerendering list items on every streamed token.
    const isTaskItem = String(props.className ?? "").includes("task-list-item");
    return (
      <li {...props} data-list-item-offset={isTaskItem ? node?.position?.start.offset : undefined}>
        {renderSkillInlineMarkdownChildren(children, skills, threadRef)}
      </li>
    );
  },
  input: function MarkdownInput({ node: _node, type, checked, disabled: _disabled, ...props }) {
    const { onTaskListChange } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownTextContext);
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
          const listItemStart = Number(event.currentTarget.closest("li")?.dataset.listItemOffset);
          if (!Number.isSafeInteger(listItemStart)) return;
          const markerOffset = findTaskListMarkerOffset(text, listItemStart);
          if (markerOffset === null) return;
          onTaskListChange({ markerOffset, checked: event.currentTarget.checked });
        }}
      />
    );
  },
  a: function MarkdownAnchor({ node, href, children, title: _title, ...props }) {
    const {
      canOperateHost,
      canOperatePreview,
      cwd,
      environmentId,
      imageBaseDir,
      markdownFileLinkMetaByHref,
      threadRef,
      openMarkdownMedia,
      openChangeRequestLink,
      openDeferredMarkdownLink,
      linkTargetPreference,
      openExternalLinkInPreview,
      projects,
      linkedThreadPullRequestFor,
      resolveThreadPullRequest,
      pullRequestsEnabled,
      updateThreadPullRequestLink,
      fileLinkChip,
      renderContextReference,
      // SCIENT-FORK:START — file links resolve against the editable workspace root.
      fileLinkWorkspaceRoot,
      // SCIENT-FORK:END
    } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownTextContext);
    // SCIENT-FORK:START — quotes from Markdown files are citations too.
    const citation = href ? parseComposerCitationHref(href) : null;
    // SCIENT-FORK:END
    if (citation) return <AssistantCitationChip citation={citation} />;
    const threadLink = href ? parseThreadLinkHref(href) : null;
    if (threadLink) {
      const written = hastPlainTextDeep(node);
      // An autolink's text is its own URL, which is no label.
      const label = written && parseThreadLinkHref(written) === null ? written : null;
      return environmentId ? (
        <MarkdownThreadLink environmentId={environmentId} link={threadLink} label={label} />
      ) : (
        <span>{label ?? "Thread"}</span>
      );
    }
    const contextReference = href ? parseComposerContextHref(href) : null;
    if (contextReference) {
      const label = hastPlainTextDeep(node) || contextReference.contextId;
      return renderContextReference ? (
        renderContextReference({ ...contextReference, label })
      ) : (
        <span>{label}</span>
      );
    }
    const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
    // SCIENT-FORK:START — links are looked up by their lookup key and resolve against the
    // editable workspace root.
    const fileLinkMeta = normalizedHref
      ? (markdownFileLinkMetaByHref.get(markdownLinkLookupKey(normalizedHref)) ??
        resolveMarkdownFileLinkMeta(
          normalizedHref,
          cwd,
          imageBaseDir ?? cwd,
          fileLinkWorkspaceRoot,
        ))
      : null;
    // SCIENT-FORK:END
    if (!fileLinkMeta) {
      const faviconHost = resolveExternalWebLinkHost(href);
      const hasText = hastHasText(node);
      const pullRequestAutolink = String(
        (props as Record<string, unknown>)["data-pull-request-autolink"] ?? "",
      );
      const pullRequestCopy =
        pullRequestAutolink === "commit"
          ? /\/commit\/([0-9a-f]{7,40})$/iu.exec(href ?? "")?.[1]
          : pullRequestAutolink === "reference" || pullRequestAutolink === "mention"
            ? plainHastText(node)
            : undefined;
      const isPullRequestAutolink = pullRequestCopy !== undefined;
      const confirmBeforeOpen = pullRequestAutolink === "reference";
      const pullRequestCandidateUrl =
        confirmBeforeOpen && href
          ? sourceControlClients.changeRequestUrlFromReferenceAutolink(href)
          : href;
      const pullRequestPreviewTarget = pullRequestCandidateUrl
        ? resolvePullRequestPreviewTarget({
            environmentId,
            projects,
            pullRequestsEnabled,
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
          data-markdown-image-link={!hasText || undefined}
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
              mediaKindFromPath(href) !== "audio" &&
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
            if (
              !href ||
              openChangeRequestLink(event, href, undefined, environmentId ?? undefined)
            ) {
              return;
            }
            if (event.defaultPrevented) return;
            if (
              resolveLinkTarget({
                url: href,
                event,
                preference: linkTargetPreference,
                canOpenInApp: canOpenInPreview,
              }) !== "app"
            ) {
              // Open desktop Alt-clicks before Chromium downloads them so link routers can read the held key.
              if (isElectron && event.altKey) {
                event.preventDefault();
                event.stopPropagation();
                void readLocalApi()
                  ?.shell.openExternal(href)
                  .catch((cause) =>
                    reportMarkdownActionFailure(
                      { operation: "open-link-external", target: href },
                      cause,
                    ),
                  );
              }
              return;
            }
            event.preventDefault();
            event.stopPropagation();
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
          {faviconHost && hasText && !isPullRequestAutolink ? (
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
        <span className="whitespace-normal">{children} </span>
        {chip}
      </span>
    );
  },
  code: function MarkdownCode({ node, children, className, ...props }) {
    // SCIENT-FORK:START — file-link root, and math streaming state.
    const {
      cwd,
      imageBaseDir,
      inlineCodeFileLinkMetaByText,
      fileLinkChip,
      fileLinkWorkspaceRoot,
      isStreaming,
      inline,
    } = use(ChatMarkdownRendererContext);
    // SCIENT-FORK:END
    // SCIENT-FORK:START — retain scientific inline math while Find reveals authored source.
    if (isScientMathCodeClassName(className)) {
      // Read only by math, so other inline code does not re-render on streamed tokens.
      const authoredMathText = use(ScientAuthoredMathTextContext);
      const tex = nodeToPlainText(children);
      return (
        <ScientMathFindSurface sourceText={authoredMathNodeSource(node, authoredMathText, tex)}>
          <ScientInlineMath tex={tex} isStreaming={isStreaming} focusable={!inline} />
        </ScientMathFindSurface>
      );
    }
    // SCIENT-FORK:END
    if (node?.properties?.dataInlineCode != null) {
      const codeText = nodeToPlainText(children);
      const fileLinkMeta =
        inlineCodeFileLinkMetaByText.get(codeText.trim()) ??
        // SCIENT-FORK:START — file links resolve against the editable workspace root.
        resolveInlineCodeFileLinkMeta(codeText, cwd, imageBaseDir ?? cwd, fileLinkWorkspaceRoot);
      // SCIENT-FORK:END
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
            codeProps={{ ...props, className, dir: "ltr", onDoubleClick: selectInlineCode }}
            color={inlineCssColor}
          >
            {children}
          </ScientInlineColorCode>
        );
      }
      // SCIENT-FORK:END
      return (
        // SCIENT-FORK: code stays left-to-right inside right-to-left prose.
        <code {...props} className={className} dir="ltr" onDoubleClick={selectInlineCode}>
          {children}
        </code>
      );
    }
    return (
      // SCIENT-FORK:START — code stays left-to-right inside right-to-left prose.
      <code {...props} className={className} dir="ltr">
        {/* SCIENT-FORK:END */}
        {children}
      </code>
    );
  },
  img: function MarkdownImage({ node, title, src, alt, ...props }) {
    const {
      expandMedia,
      cwd,
      environmentId,
      sourceControlMedia,
      imageBaseDir,
      threadRef,
      workspaceMutationId,
      renderContextReference,
      // SCIENT-FORK:START — image cards wait for the settled message; file previews caption them.
      imageCaptions,
      isStreaming,
      // SCIENT-FORK:END
      fileLinkChip,
    } = use(ChatMarkdownRendererContext);
    const imageExpand = use(MarkdownLinkContext) ? undefined : expandMedia;
    const contextReference = typeof src === "string" ? parseComposerContextHref(src) : null;
    if (contextReference) {
      const label = alt || contextReference.contextId;
      return renderContextReference ? (
        renderContextReference({ ...contextReference, label })
      ) : (
        <span>{label}</span>
      );
    }
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
    // SCIENT-FORK:START — image copy Markdown wraps spaced destinations in <…> (scient/images).
    const copyMarkdown = inlineWorkspaceImageMarkdownSource(altText, srcString, authoredTitle);
    // SCIENT-FORK:END
    const { className, style: _style, width, height, ...imageProps } = props;
    const authoredSizeStyle = authoredImageSizeStyle(width, height);
    const imageSource = classifyMarkdownImageSource(classifiedSrc, imageBaseDir ?? cwd);
    const mediaKind = mediaKindFromPath(classifiedSrc);
    if (mediaKind === "audio") {
      const filePath = imageSource._tag === "WorkspaceFile" ? imageSource.path : null;
      const name =
        (filePath ?? classifiedSrc.split(/[?#]/, 1)[0] ?? "").split(/[\\/]/).at(-1) ||
        altText ||
        "Audio";
      if (imageSource._tag !== "Direct" && !(filePath && threadRef)) {
        return <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} kind="audio" />;
      }
      return (
        <InlineAudioPreview
          key={classifiedSrc}
          name={name}
          copyMarkdown={copyMarkdown}
          {...(filePath && threadRef
            ? {
                environmentId: threadRef.environmentId,
                resource: {
                  _tag: "media-file" as const,
                  threadId: threadRef.threadId,
                  path: filePath,
                },
                onOpen: () => useRightPanelStore.getState().openFile(threadRef, filePath),
              }
            : imageSource._tag === "Direct"
              ? { src: resolveProtocolRelativeMediaUrl(imageSource.uri) }
              : {})}
        />
      );
    }
    if (mediaKind === null && imageSource._tag === "WorkspaceFile") {
      const fileLinkMeta = resolveMarkdownFileLinkMeta(srcString, cwd, imageBaseDir ?? cwd);
      if (fileLinkMeta) return fileLinkChip(fileLinkMeta, copyMarkdown, srcString);
    }
    const kind = mediaKind ?? "image";
    const directUri = imageSource._tag === "Direct" ? imageSource.uri : null;
    const hostMediaUrl =
      directUri === null
        ? null
        : (sourceControlClients.mediaUrl(resolveProtocolRelativeMediaUrl(directUri))?.fetchUrl ??
          null);
    // SCIENT-FORK:START — web images render as a referenced link until the user loads one, and
    // standalone workspace images render as Scient image cards (scient/images).
    const image =
      imageSource._tag === "WorkspaceFile"
        ? resolveInlineWorkspaceImage({ alt, cwd, src: imageSource.path })
        : null;
    const useScientImageCard = Boolean(node?.properties?.dataScientImageCard);
    const remoteImageReference = useScientRemoteImageReference({
      directUri,
      altText,
      kind,
      markdownSource: copyMarkdown,
      id: props.id,
      MarkdownLinkContext,
      renderImage: () => <MarkdownImage node={node} alt={alt} src={src} title={title} {...props} />,
    });
    const workspaceImageCard = scientWorkspaceImageCard({
      useScientImageCard,
      image,
      markdownSource: copyMarkdown,
      threadRef,
      isStreaming,
      srcFragment: markdownImageSourceFragment(classifiedSrc),
      imageCaptions,
      authoredTitle,
      altText,
      srcString,
      workspaceMutationId,
    });
    if (workspaceImageCard !== null) return workspaceImageCard;
    // SCIENT-FORK:END
    if (
      sourceControlMedia &&
      cwd !== undefined &&
      environmentId !== null &&
      directUri !== null &&
      hostMediaUrl !== null
    ) {
      return (
        <ChatMarkdownAssetImage
          environmentId={environmentId}
          resource={{ _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd, url: hostMediaUrl }}
          alt={altText}
          kind={kind}
          copyMarkdown={copyMarkdown}
          standalone={standalone}
          className={className}
          style={authoredSizeStyle}
          imageProps={imageProps}
          srcFragment={markdownImageSourceFragment(classifiedSrc)}
          originalUrl={resolveProtocolRelativeMediaUrl(directUri)}
          framed={false}
          // SCIENT-FORK:START — the direct fallback is gated: an unsignable web asset becomes the
          // link card instead of a direct fetch.
          fallbackSrc={remoteImageReference === null ? hostMediaUrl : undefined}
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
            copyMarkdown={copyMarkdown}
            originalUrl={originalUrl}
            style={authoredSizeStyle}
            actionsSource={actionsSource}
          />
        );
      }
      // SCIENT-FORK:START — file previews caption a standalone web image like the rich editor.
      if (imageCaptions && useScientImageCard) {
        return (
          <ScientDirectImageFigure
            src={mediaSrc}
            authoredSource={srcString}
            alt={altText}
            caption={authoredTitle}
            markdownSource={copyMarkdown}
          />
        );
      }
      // SCIENT-FORK:END
      return (
        <ChatMarkdownImage
          key={mediaSrc}
          src={mediaSrc}
          alt={altText}
          copyMarkdown={copyMarkdown}
          standalone={standalone}
          className={className}
          style={authoredSizeStyle}
          // SCIENT-FORK:START — preserve authored image attributes, including width and height.
          imageProps={props}
          // SCIENT-FORK:END
          actionsSource={actionsSource}
          originalUrl={originalUrl}
          onImageExpand={imageExpand}
        />
      );
    }
    const hostImageUrl = use(HostImageUrlContext);
    if (imageSource._tag === "WorkspaceFile" && kind === "image" && hostImageUrl !== null) {
      const hostSrc = hostImageUrl(imageSource.path);
      return (
        <ChatMarkdownImage
          key={hostSrc}
          src={hostSrc}
          alt={altText}
          copyMarkdown={copyMarkdown}
          standalone={standalone}
          className={className}
          style={authoredSizeStyle}
          imageProps={imageProps}
          actionsSource={{ kind, name: altText || kind, src: hostSrc }}
          onImageExpand={imageExpand}
        />
      );
    }
    if (imageSource._tag === "WorkspaceFile" && threadRef) {
      return (
        <ChatMarkdownAssetImage
          environmentId={threadRef.environmentId}
          // SCIENT-FORK:START — a workspace image keeps its own workspace (scient/images).
          resource={
            image
              ? inlineWorkspaceImageResource(image, threadRef)
              : {
                  _tag: "media-file",
                  threadId: threadRef.threadId,
                  path: imageSource.path,
                }
          }
          // SCIENT-FORK:END
          alt={altText}
          kind={kind}
          copyMarkdown={copyMarkdown}
          srcFragment={markdownImageSourceFragment(classifiedSrc)}
          standalone={standalone}
          style={authoredSizeStyle}
          workspaceRoot={cwd}
          workspaceMutationId={workspaceMutationId}
          onImageExpand={imageExpand}
        />
      );
    }
    return <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} kind={kind} />;
  },
  // SCIENT-FORK:START — a <picture> source never fetches a web address; its <img> is gated
  source: ScientMarkdownSource,
  // SCIENT-FORK:END
  table: function MarkdownTableRenderer({ node: _node, ...props }) {
    // SCIENT-FORK:START — a table follows its own or the message's direction.
    const { resolvedContentDirection } = use(ChatMarkdownRendererContext);
    const tableDirection =
      props.dir === "rtl" || props.dir === "ltr" ? props.dir : resolvedContentDirection;
    return <MarkdownTable {...props} dir={tableDirection} />;
    // SCIENT-FORK:END
  },
  details: function MarkdownDetailsRenderer({ node: _node, children, open: detailsOpen }) {
    return <MarkdownDetails open={detailsOpen}>{children}</MarkdownDetails>;
  },
  pre: function MarkdownPre({ node, children, ...props }) {
    // SCIENT-FORK:START — direction; Mermaid's expandMedia is unused.
    const {
      resolvedTheme,
      diffThemeName,
      isStreaming,
      onRunShellCommand,
      resolvedContentDirection,
      inline,
    } = use(ChatMarkdownRendererContext);
    // SCIENT-FORK:END
    const text = use(ChatMarkdownTextContext);
    const codeBlock = extractCodeBlock(children);
    if (!codeBlock) {
      return <pre {...props}>{children}</pre>;
    }
    // SCIENT-FORK:START — retain scientific display math while Find reveals authored source.
    if (isScientMathCodeClassName(codeBlock.className)) {
      const authoredMathText = use(ScientAuthoredMathTextContext);
      return (
        <ScientMathFindSurface
          sourceText={authoredMathNodeSource(node, authoredMathText, codeBlock.code)}
        >
          <ScientDisplayMath tex={codeBlock.code} isStreaming={isStreaming} focusable={!inline} />
        </ScientMathFindSurface>
      );
    }
    // SCIENT-FORK:END

    const language = extractFenceLanguage(codeBlock.className);
    // SCIENT-FORK:START — the code block is Scient's (scient/presentation/MarkdownCodeBlock.tsx).
    // Complete Mermaid fences may render during streaming, but unfinished source stays readable.
    // Other visual grammars still wait for the settled message.
    const fenceMeta = extractPreCodeMeta(node);
    const fenceTitle = extractFenceTitle(fenceMeta);
    const richFenceKind = resolveScientRichFenceKind(language);
    if (
      richFenceKind != null &&
      (!isStreaming ||
        (richFenceKind === "mermaid" && isClosedCodeFence(node, text, codeBlock.code)))
    ) {
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
    // The box direction is shared with the Copy message button's rich flavour.
    const copyTextDirection = chatCodeBoxDirection({
      code: codeBlock.code,
      language,
      fenceMeta,
      conversationDirection: resolvedContentDirection,
      isStreaming,
    });
    // SCIENT-FORK:END
    return (
      <ScientMarkdownCodeBlock
        code={codeBlock.code}
        language={language}
        fenceTitle={fenceTitle}
        theme={resolvedTheme}
        // SCIENT-FORK:START — only shell fences run (the check moved here from the code block).
        onRunShellCommand={
          onRunShellCommand &&
          /^(?:sh|bash|zsh|fish|shell|powershell|pwsh)$/.test(language) &&
          !isStreaming &&
          isClosedCodeFence(node, text, codeBlock.code)
            ? onRunShellCommand
            : undefined
        }
        copyTextDirection={copyTextDirection}
        // SCIENT-FORK:END
        isStreaming={isStreaming}
        // SCIENT-FORK:START — the code block renders its own highlighted body and fallback.
        fallback={<pre {...props}>{children}</pre>}
        onCopyFailure={(cause) =>
          reportMarkdownActionFailure(
            { operation: "copy-code-block", language, ...(fenceTitle ? { fenceTitle } : {}) },
            cause,
          )
        }
      />
      // SCIENT-FORK:END
    );
  },
} satisfies Components;

const markdownRenderers = new WeakMap<
  PluggableList,
  WeakMap<PluggableList, ReturnType<typeof createMarkdownRenderer>>
>();

function markdownRenderer(remarkPlugins: PluggableList, rehypePlugins: PluggableList) {
  let byRehype = markdownRenderers.get(remarkPlugins);
  if (!byRehype) markdownRenderers.set(remarkPlugins, (byRehype = new WeakMap()));
  let renderer = byRehype.get(rehypePlugins);
  if (!renderer) {
    renderer = createMarkdownRenderer({
      remarkPlugins,
      rehypePlugins,
      components: CHAT_MARKDOWN_COMPONENTS,
      urlTransform: markdownUrlTransform,
    });
    byRehype.set(rehypePlugins, renderer);
  }
  return renderer;
}

const MarkdownSource = memo(function MarkdownSource({
  text,
  // SCIENT-FORK:START — math nodes read the source as authored.
  authoredText,
  // SCIENT-FORK:END
  remarkPlugins,
  rehypePlugins,
  shared,
  cache,
}: {
  text: string;
  // SCIENT-FORK:START
  authoredText: string;
  // SCIENT-FORK:END
  remarkPlugins: PluggableList;
  rehypePlugins: PluggableList;
  /** The plugins are one of the shared sets. */
  shared: boolean;
  /** The text will not change again; streamed text would only fill the cache with prefixes. */
  cache: boolean;
}) {
  // Per-instance plugins, such as the incremental parser, set up their state on every render.
  const render = shared
    ? markdownRenderer(remarkPlugins, rehypePlugins)
    : createMarkdownRenderer({
        remarkPlugins,
        rehypePlugins,
        components: CHAT_MARKDOWN_COMPONENTS,
        urlTransform: markdownUrlTransform,
      });
  return (
    <ChatMarkdownTextContext value={text}>
      {/* SCIENT-FORK:START — it changes per streamed token, so only math reads it. */}
      <ScientAuthoredMathTextContext value={authoredText}>
        {render(text, shared && cache)}
      </ScientAuthoredMathTextContext>
      {/* SCIENT-FORK:END */}
    </ChatMarkdownTextContext>
  );
});

function ChatMarkdown({
  text,
  className,
  inline = false,
  lineBreaks = false,
  parseRawHtml = true,
  extraRemarkPlugins = EMPTY_REMARK_PLUGINS,
  ...props
}: ChatMarkdownProps) {
  const {
    componentState,
    // SCIENT-FORK:START — math-normalized text and the message direction.
    markdownText,
    resolvedContentDirection,
    effectiveContentDirection,
    // SCIENT-FORK:END
    handleCopy,
    markdownRef,
    localMediaPreview,
    closeLocalMediaPreview,
  } = useChatMarkdownState({ text, inline, ...props });
  // SCIENT-FORK:START — authored math intent reads offsets in the whole message, so a message
  // that needs it renders whole; every other message takes the shared, cached path.
  const sharedRemarkPlugins = lineBreaks
    ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS
    : CHAT_MARKDOWN_REMARK_PLUGINS;
  const messageRemarkPlugins = scientMathRemarkPluginsForMessage(sharedRemarkPlugins, text);
  const wholeMessage = messageRemarkPlugins !== sharedRemarkPlugins || markdownText !== text;
  // SCIENT-FORK:END
  // Streaming re-renders only the last block; offsets for task edits need the whole text.
  // SCIENT-FORK: the split outlives the stream, so a web image the reader loaded stays loaded.
  const streamingBlocks =
    !inline && extraRemarkPlugins.length === 0 && !props.onTaskListChange && !wholeMessage
      ? splitMarkdownBlocks(text)
      : null;
  const incrementalParsing =
    props.isStreaming === true &&
    streamingBlocks === null &&
    extraRemarkPlugins.length === 0 &&
    /(?:^|\n) {0,3}(?:`{3}|~{3})/.test(text);
  const Root = inline ? "span" : "div";
  const bindMarkdownRef = (node: HTMLElement | null) => {
    markdownRef.current = node;
  };
  // Extra and incremental plugins are per instance, so their output is not shared.
  const instancePlugins = extraRemarkPlugins.length > 0 || incrementalParsing;
  const remarkPlugins = instancePlugins
    ? scientMathRemarkPluginsForMessage(
        [
          ...sharedRemarkPlugins,
          ...extraRemarkPlugins,
          ...(incrementalParsing ? [createIncrementalMarkdownPlugin()] : []),
        ],
        text,
      )
    : messageRemarkPlugins;
  const uncachedPlugins = instancePlugins || wholeMessage;
  const blocks = streamingBlocks ?? [markdownText];
  // SCIENT-FORK:START — the message direction, after the shared pipeline.
  const rehypePlugins = directionalRehypePlugins(parseRawHtml, {
    direction: resolvedContentDirection,
    requestedDirection: effectiveContentDirection,
  });
  // SCIENT-FORK:END

  return (
    <Root
      ref={bindMarkdownRef}
      className={cn(
        "chat-markdown w-full min-w-0 [overflow-wrap:anywhere] [word-break:break-word]",
        !inline &&
          "text-sm leading-relaxed text-foreground/[calc(90%+var(--appearance-contrast-boost)/10)]",
        className,
      )}
      // SCIENT-FORK:START — the message direction (scient/bidi).
      dir={resolvedContentDirection}
      data-scient-content-direction={resolvedContentDirection}
      // SCIENT-FORK:END
      data-streaming={componentState.isStreaming ? "" : undefined}
      onCopy={handleCopy}
    >
      <ChatMarkdownRendererContext value={componentState}>
        {blocks.map((source, index) => (
          <MarkdownSource
            // oxlint-disable-next-line react/no-array-index-key -- streamed blocks only change at the end
            key={index}
            text={source}
            // SCIENT-FORK:START — a split message has no math normalization to undo.
            authoredText={streamingBlocks ? source : text}
            // SCIENT-FORK:END
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            shared={!uncachedPlugins}
            // Every block before the last is finished, so its parse can be reused.
            cache={!props.isStreaming || index < blocks.length - 1}
          />
        ))}
      </ChatMarkdownRendererContext>
      {localMediaPreview ? (
        <ExpandedImageDialog preview={localMediaPreview} onClose={closeLocalMediaPreview} />
      ) : null}
    </Root>
  );
}

export default memo(ChatMarkdown);
