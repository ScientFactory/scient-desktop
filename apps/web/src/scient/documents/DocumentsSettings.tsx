import type { EnvironmentId } from "@t3tools/contracts";
import { FileTextIcon, RefreshCwIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { Fragment, useEffect, useState, type ReactNode } from "react";

import latexLogo from "~/assets/documents/latex.svg";
import markdownLogo from "~/assets/documents/markdown.svg";
import wordLogo from "~/assets/documents/word.svg";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTargetId,
} from "~/components/settings/settingsLayout";
import { useOptionalSettingsScope } from "~/components/settings/SettingsScopeContext";
import { FoldedSettingsSection } from "~/components/settings/FoldedSettingsSection";
import { SettingsGroup } from "~/components/settings/SettingsGroup";
import {
  SettingsSourceGroup,
  SettingsSourcePanel,
  SettingsSourceStrip,
  SettingsSourceStripItem,
} from "~/components/settings/SettingsSourceStrip";

import {
  RENDER_MARKDOWN_STORAGE_KEY,
  SCIENT_DEFAULT_RENDER_MARKDOWN,
} from "../fileOpening/fileOpeningPolicy";
import {
  DEFAULT_LATEX_PREVIEW_MODE,
  LATEX_PREVIEW_MODE_LABELS,
  LATEX_PREVIEW_MODE_STORAGE_KEY,
  LATEX_PREVIEW_MODES,
  normalizeLatexPreviewMode,
} from "../latex/scientLatexSurfaceModel";
import {
  LATEX_COMPILER_CHOICES,
  latexCompilerAvailabilityLabel,
  normalizeLatexCompilerChoice,
} from "../latex/latexCompiler";
import { formatLatexDownloadSize } from "../latex/latexToolchainSetupModel";
import { PandocSettingsRow } from "../wordExport/PandocSettingsRow";
import { pandocToolSummary } from "../wordExport/pandocToolModel";
import { usePandocTool, type PandocToolController } from "../wordExport/usePandocTool";
import {
  DEFAULT_NEW_DOCUMENT_COMPILER,
  NEW_DOCUMENT_COMPILER_STORAGE_KEY,
  DEFAULT_NEW_DOCUMENT_LANGUAGE,
  NEW_DOCUMENT_LANGUAGE_STORAGE_KEY,
  normalizeNewDocumentLanguage,
} from "./documentPreferences";
import { NEW_DOCUMENT_LANGUAGES } from "./documentTemplates";
import { useLatexInstallation, type LatexInstallationController } from "./useLatexInstallation";
import { TemplatesSettingsRow } from "./TemplateLibrarySettings";

const SELECTED_FORMAT_STORAGE_KEY = "scient.documentsSettingsFormat";
const FORMAT_LOGOS = { latex: latexLogo, markdown: markdownLogo, word: wordLogo };
const DOCUMENT_FORMATS = ["latex", "markdown", "word"] as const;
type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/** Rows settings search can jump to, and the tab each lives under. */
const SEARCH_TARGET_FORMATS: Readonly<Record<string, DocumentFormat>> = {
  "latex-installation": "latex",
  "latex-additional-compilers": "latex",
  "new-document-template": "latex",
  "new-document-language": "latex",
  "new-document-compiler": "latex",
  "latex-compilers": "latex",
  "latex-open-in": "latex",
  "markdown-open-in": "markdown",
  "word-export": "word",
};

const MARKDOWN_VIEWS = [
  { id: "rich", label: "Rich" },
  { id: "source", label: "Source" },
] as const;

function OptionSelect<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly groups: ReadonlyArray<ReadonlyArray<{ readonly id: T; readonly name: string }>>;
  readonly onChange: (value: T) => void;
}) {
  const options = props.groups.flat();
  return (
    <Select
      value={props.value}
      onValueChange={(value) => {
        const next = options.find((option) => option.id === value);
        if (next) props.onChange(next.id);
      }}
    >
      <SelectTrigger size="sm" width="content" aria-label={props.label}>
        <SelectValue>{options.find((option) => option.id === props.value)?.name}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false} matchTriggerWidth={false}>
        {props.groups.map((group, index) => (
          <Fragment key={group[0]?.id ?? index}>
            {index > 0 ? <SelectSeparator /> : null}
            {group.map((option) => (
              <SelectItem key={option.id} hideIndicator value={option.id}>
                {option.name}
              </SelectItem>
            ))}
          </Fragment>
        ))}
      </SelectPopup>
    </Select>
  );
}

function LatexInstallationRow({
  installation,
}: {
  readonly installation: LatexInstallationController;
}) {
  const { view, act, report } = installation;
  const problem = view.kind === "failed" || view.kind === "unreadable";
  const action =
    view.actionLabel === null ? null : (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={view.busy || installation.refreshing}
        onClick={act}
      >
        {view.actionLabel}
      </Button>
    );
  const download =
    report?.canInstallManaged && (view.actionLabel !== null || view.busy || problem) ? (
      <span className="block">
        {report.downloadBytes == null
          ? "Base archive size is unavailable."
          : `Base archive: ${formatLatexDownloadSize(report.downloadBytes)}.`}{" "}
        Additional LaTeX packages download during setup and on first use.
      </span>
    ) : null;
  return (
    <>
      <SettingsRow
        id="latex-installation"
        title="LaTeX tools"
        description={
          <span role={problem && view.additionalDetail === null ? "alert" : "status"}>
            <span className="block">
              {view.summary} · {view.detail}
            </span>
            {view.actionTarget === "tools" ? download : null}
          </span>
        }
        serverScoped
        control={view.actionTarget === "tools" ? action : null}
      />
      {view.additionalDetail !== null ? (
        <SettingsRow
          id="latex-additional-compilers"
          title="Additional compilers"
          description={
            <span className={cn(problem && "text-destructive")} role={problem ? "alert" : "status"}>
              {view.additionalDetail}
              {download}
            </span>
          }
          serverScoped
          control={action}
        />
      ) : null}
    </>
  );
}

function LatexTechnicalDetails({
  installation,
}: {
  readonly installation: LatexInstallationController | null;
}) {
  const report = installation?.report ?? null;
  return (
    <FoldedSettingsSection
      id="latex-compilers"
      title="Technical details"
      summary="Compiler versions and executable paths."
      headerPlacement="row"
    >
      <SettingsRow
        title="PDF build driver"
        serverScoped
        description={
          report === null ? (
            installation === null ? (
              "Offline"
            ) : (
              "Not checked"
            )
          ) : (
            <span className="flex flex-col gap-1">
              <span>
                {report.kind ?? "Not installed"}
                {report.version ? ` · ${report.version}` : ""}
                {report.source
                  ? ` · ${report.source === "scient-managed" ? "Scient-managed TinyTeX" : "System installation"}`
                  : ""}
              </span>
              {report.executable ? <span className="break-all">{report.executable}</span> : null}
            </span>
          )
        }
      />
      {LATEX_COMPILER_CHOICES.map((choice) => {
        if (choice.id === "automatic") return null;
        const availability = report?.compilers.find((item) => item.compiler === choice.id);
        const label = availability?.available
          ? "Available"
          : latexCompilerAvailabilityLabel(report, choice.id, installation === null);
        return (
          <SettingsRow
            key={choice.id}
            title={choice.name}
            serverScoped
            description={
              <span className="flex flex-col gap-1">
                <span>
                  {label}
                  {availability?.version ? ` · ${availability.version}` : ""}
                </span>
                {availability?.executable ? (
                  <span className="break-all">{availability.executable}</span>
                ) : null}
              </span>
            }
          />
        );
      })}
    </FoldedSettingsSection>
  );
}

function LatexPanel(props: {
  readonly hidden: boolean;
  readonly installation: LatexInstallationController | null;
}) {
  const [language, setLanguage] = useLocalStorage(
    NEW_DOCUMENT_LANGUAGE_STORAGE_KEY,
    DEFAULT_NEW_DOCUMENT_LANGUAGE,
    Schema.String,
  );
  const [compiler, setCompiler] = useLocalStorage(
    NEW_DOCUMENT_COMPILER_STORAGE_KEY,
    DEFAULT_NEW_DOCUMENT_COMPILER,
    Schema.String,
  );
  // The view the editor remembers: choosing here or in the editor is the same choice.
  const [view, setView] = useLocalStorage(
    LATEX_PREVIEW_MODE_STORAGE_KEY,
    DEFAULT_LATEX_PREVIEW_MODE,
    Schema.String,
  );
  return (
    <div
      id="documents-latex"
      aria-labelledby="documents-latex-trigger"
      hidden={props.hidden}
      className="space-y-6 pt-4"
    >
      <SettingsSection id="latex-tools" title="Tools" variant="plain">
        <div className="space-y-3">
          <SettingsGroup>
            {props.installation ? (
              <LatexInstallationRow installation={props.installation} />
            ) : (
              <OfflineToolRow id="latex-installation" title="LaTeX tools" />
            )}
          </SettingsGroup>
          <LatexTechnicalDetails installation={props.installation} />
        </div>
      </SettingsSection>
      <SettingsSection id="latex-preferences" title="Document preferences">
        <TemplatesSettingsRow />
        <SettingsRow
          id="new-document-language"
          title="Language for new documents"
          control={
            <OptionSelect
              label="Language for new documents"
              value={normalizeNewDocumentLanguage(language)}
              groups={[NEW_DOCUMENT_LANGUAGES]}
              onChange={setLanguage}
            />
          }
        />
        <SettingsRow
          id="new-document-compiler"
          title="Default compiler for new documents"
          description="Automatic chooses by document requirements and does not download software. Template engine declarations take precedence. Hebrew uses XeLaTeX unless LuaLaTeX is selected. Existing documents are unchanged."
          control={
            <OptionSelect
              label="Default compiler for new documents"
              value={normalizeLatexCompilerChoice(compiler)}
              groups={[LATEX_COMPILER_CHOICES]}
              onChange={setCompiler}
            />
          }
        />
        <SettingsRow
          id="latex-open-in"
          title="Open files in"
          control={
            <OptionSelect
              label="Open LaTeX files in"
              value={normalizeLatexPreviewMode(view)}
              groups={[
                LATEX_PREVIEW_MODES.map((mode) => ({
                  id: mode,
                  name: LATEX_PREVIEW_MODE_LABELS[mode],
                })),
              ]}
              onChange={setView}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}

function MarkdownPanel(props: { readonly hidden: boolean }) {
  // The view the editor remembers: choosing here or in the editor is the same choice.
  const [rich, setRich] = useLocalStorage(
    RENDER_MARKDOWN_STORAGE_KEY,
    SCIENT_DEFAULT_RENDER_MARKDOWN,
    Schema.Boolean,
  );
  return (
    <SettingsSourcePanel
      id="documents-markdown"
      aria-labelledby="documents-markdown-trigger"
      hidden={props.hidden}
    >
      <SettingsRow
        id="markdown-open-in"
        title="Open files in"
        control={
          <OptionSelect
            label="Open Markdown files in"
            value={rich ? "rich" : "source"}
            groups={[MARKDOWN_VIEWS.map((entry) => ({ id: entry.id, name: entry.label }))]}
            onChange={(next) => setRich(next === "rich")}
          />
        }
      />
    </SettingsSourcePanel>
  );
}

/** A server tool's row while no server is connected: the tool is there, just out of reach. */
function OfflineToolRow(props: { readonly id: string; readonly title: string }) {
  return <SettingsRow id={props.id} title={props.title} description="Offline" />;
}

function WordPanel(props: {
  readonly hidden: boolean;
  readonly pandoc: PandocToolController | null;
}) {
  return (
    <SettingsSourcePanel
      id="documents-word"
      aria-labelledby="documents-word-trigger"
      hidden={props.hidden}
    >
      {props.pandoc ? (
        <PandocSettingsRow controller={props.pandoc} />
      ) : (
        <OfflineToolRow id="word-export" title="Pandoc" />
      )}
    </SettingsSourcePanel>
  );
}

/** Server tools; absent while the chosen environment is not connected, shown as Offline. */
interface DocumentsServerTools {
  readonly installation: LatexInstallationController;
  readonly pandoc: PandocToolController;
}

function DocumentsSection(props: {
  readonly server: DocumentsServerTools | null;
  readonly headerAction?: ReactNode;
}) {
  const [stored, setStored] = useLocalStorage(SELECTED_FORMAT_STORAGE_KEY, "latex", Schema.String);
  const [collapsed, setCollapsed] = useState(false);
  // A settings-search jump to a row opens that row's tab once; the tabs stay
  // the person's to change even while the jump is still pending.
  const target = useSettingsSearchTargetId();
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const targetFormat =
    target === null || target === openedFor ? null : (SEARCH_TARGET_FORMATS[target] ?? null);
  useEffect(() => {
    if (target === null) setOpenedFor(null);
    if (targetFormat === null || target === null) return;
    setStored(targetFormat);
    setCollapsed(false);
    setOpenedFor(target);
  }, [setStored, target, targetFormat]);
  const selected: DocumentFormat =
    targetFormat ?? DOCUMENT_FORMATS.find((format) => format === stored) ?? "latex";
  const isCollapsed = targetFormat === null && collapsed;
  const items: ReadonlyArray<{
    readonly id: DocumentFormat;
    readonly label: string;
    readonly detail: string;
  }> = [
    { id: "latex", label: "LaTeX", detail: props.server?.installation.view.summary ?? "Offline" },
    { id: "markdown", label: "Markdown", detail: "Built in" },
    {
      id: "word",
      label: "Word",
      detail: props.server ? pandocToolSummary(props.server.pandoc.view) : "Offline",
    },
  ];
  return (
    <SettingsSection
      id="documents"
      title="Documents"
      icon={<FileTextIcon className="size-4 text-muted-foreground" />}
      variant="plain"
      headerAction={props.headerAction}
    >
      <div className="px-3 sm:px-4">
        <SettingsSourceGroup activePanelId={isCollapsed ? null : `documents-${selected}`}>
          <SettingsSourceStrip label="Document formats">
            {items.map((item, index) => (
              <SettingsSourceStripItem
                key={item.id}
                id={`documents-${item.id}-trigger`}
                controls={`documents-${item.id}`}
                expanded={!isCollapsed && item.id === selected}
                separated={index > 0}
                label={item.label}
                detail={item.detail}
                icon={
                  <img
                    src={FORMAT_LOGOS[item.id]}
                    alt=""
                    // Each logo is a coloured square tile, so all three read the same in both themes.
                    className="size-7 shrink-0 object-contain"
                  />
                }
                onToggle={() => {
                  if (item.id === selected) {
                    setCollapsed((current) => !current);
                  } else {
                    setStored(item.id);
                    setCollapsed(false);
                  }
                }}
              />
            ))}
          </SettingsSourceStrip>
          {selected === "latex" ? (
            <LatexPanel hidden={isCollapsed} installation={props.server?.installation ?? null} />
          ) : selected === "word" ? (
            <WordPanel hidden={isCollapsed} pandoc={props.server?.pandoc ?? null} />
          ) : (
            <MarkdownPanel hidden={isCollapsed} />
          )}
        </SettingsSourceGroup>
      </div>
    </SettingsSection>
  );
}

function EnvironmentDocumentsSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const installation = useLatexInstallation(props.environmentId);
  const pandoc = usePandocTool(props.environmentId);
  const checking =
    installation.refreshing || installation.view.busy || pandoc.checking || pandoc.view.busy;
  return (
    <SettingsPageContainer>
      <DocumentsSection
        server={{ installation, pandoc }}
        headerAction={
          <div className="flex items-center gap-1.5">
            <span className="hidden text-xs text-muted-foreground sm:inline">{props.label}</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={checking}
                    aria-label="Check installations again"
                    onClick={() => {
                      pandoc.refresh();
                      void installation.refresh();
                    }}
                  >
                    <RefreshCwIcon className={cn(installation.refreshing && "animate-spin")} />
                  </Button>
                }
              />
              <TooltipPopup side="top">Check installations again</TooltipPopup>
            </Tooltip>
          </div>
        }
      />
    </SettingsPageContainer>
  );
}

/**
 * Settings ▸ Documents: LaTeX, Markdown, and Word side by side, the way
 * Scientific Computing shows its languages. Word holds the export to Word,
 * which serves LaTeX, Markdown, and conversations alike. Preferences are this
 * device's; the installs are the server's.
 */
export function DocumentsSettings() {
  const primaryId = usePrimaryEnvironmentId();
  // The one connected environment the settings scope chose, the same one its
  // picker names. A scope with none connected shows the server tools Offline.
  const scope = useOptionalSettingsScope();
  const environmentId = scope === null ? primaryId : (scope.environment?.environmentId ?? null);
  const environment = useEnvironment(environmentId);
  if (environmentId === null || environment === null) {
    return (
      <SettingsPageContainer>
        <DocumentsSection server={null} />
      </SettingsPageContainer>
    );
  }
  return (
    <EnvironmentDocumentsSettings
      key={environmentId}
      environmentId={environmentId}
      label={environment.label}
    />
  );
}
