import type { EnvironmentId } from "@t3tools/contracts";
import { FileTextIcon, RefreshCwIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { Fragment, useEffect, useState, type ReactNode } from "react";

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
import { WordExportSettingsSection } from "../wordExport/WordExportSettingsSection";
import {
  DEFAULT_NEW_DOCUMENT_LANGUAGE,
  DEFAULT_NEW_DOCUMENT_TEMPLATE,
  NEW_DOCUMENT_LANGUAGE_STORAGE_KEY,
  NEW_DOCUMENT_TEMPLATE_STORAGE_KEY,
  normalizeNewDocumentLanguage,
  normalizeNewDocumentTemplate,
} from "./documentPreferences";
import {
  MORE_DOCUMENT_TEMPLATES,
  NEW_DOCUMENT_LANGUAGES,
  NEW_DOCUMENT_TEMPLATES,
} from "./documentTemplates";
import { useLatexInstallation, type LatexInstallationController } from "./useLatexInstallation";

const SELECTED_FORMAT_STORAGE_KEY = "scient.documentsSettingsFormat";
const DOCUMENT_FORMATS = ["latex", "markdown"] as const;
type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/** Rows settings search can jump to, and the tab each lives under. */
const SEARCH_TARGET_FORMATS: Readonly<Record<string, DocumentFormat>> = {
  "latex-installation": "latex",
  "new-document-template": "latex",
  "new-document-language": "latex",
  "latex-open-in": "latex",
  "markdown-open-in": "markdown",
};

const MARKDOWN_VIEWS = [
  { id: "rich", label: "Rich" },
  { id: "source", label: "Source" },
] as const;

/** The LaTeX wordmark's TeX, set the way Knuth set it: E lowered, letters kerned. */
function LatexMark({ className }: { readonly className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" className={className}>
      <g
        fill="currentColor"
        fontFamily="KaTeX_Main, 'Latin Modern Roman', 'Times New Roman', serif"
        fontSize="12.5"
      >
        <text x="0.4" y="15">
          T
        </text>
        <text x="7.3" y="17.7">
          E
        </text>
        <text x="14.2" y="15">
          X
        </text>
      </g>
    </svg>
  );
}

/** The Markdown mark (public domain), drawn in the current colour. */
function MarkdownMark({ className }: { readonly className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 208 128" className={className}>
      <rect
        width="198"
        height="118"
        x="5"
        y="5"
        ry="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="10"
      />
      <path
        fill="currentColor"
        d="M30 98V30h20l20 25 20-25h20v68H90V59L70 84 50 59v39zm125 0l-30-33h20V30h20v35h20z"
      />
    </svg>
  );
}

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
      <SelectTrigger size="sm" className="w-44" aria-label={props.label}>
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
  const { view, act } = installation;
  const problem = view.kind === "failed" || view.kind === "unreadable";
  return (
    <SettingsRow
      id="latex-installation"
      title="Installation"
      description={
        <span className={cn(problem && "text-destructive")} role={problem ? "alert" : "status"}>
          {view.detail}
        </span>
      }
      serverScoped
      control={
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
        )
      }
    />
  );
}

function LatexPanel(props: {
  readonly hidden: boolean;
  readonly installation: LatexInstallationController | null;
}) {
  const [template, setTemplate] = useLocalStorage(
    NEW_DOCUMENT_TEMPLATE_STORAGE_KEY,
    DEFAULT_NEW_DOCUMENT_TEMPLATE,
    Schema.String,
  );
  const [language, setLanguage] = useLocalStorage(
    NEW_DOCUMENT_LANGUAGE_STORAGE_KEY,
    DEFAULT_NEW_DOCUMENT_LANGUAGE,
    Schema.String,
  );
  // The view the editor remembers: choosing here or in the editor is the same choice.
  const [view, setView] = useLocalStorage(
    LATEX_PREVIEW_MODE_STORAGE_KEY,
    DEFAULT_LATEX_PREVIEW_MODE,
    Schema.String,
  );
  return (
    <SettingsSourcePanel
      id="documents-latex"
      aria-labelledby="documents-latex-trigger"
      hidden={props.hidden}
    >
      {props.installation ? <LatexInstallationRow installation={props.installation} /> : null}
      <SettingsRow
        id="new-document-template"
        title="Template for new documents"
        control={
          <OptionSelect
            label="Template for new documents"
            value={normalizeNewDocumentTemplate(template)}
            groups={[NEW_DOCUMENT_TEMPLATES, MORE_DOCUMENT_TEMPLATES]}
            onChange={setTemplate}
          />
        }
      />
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
    </SettingsSourcePanel>
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

function DocumentsSection(props: {
  readonly installation: LatexInstallationController | null;
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
  const selected: DocumentFormat = targetFormat ?? (stored === "markdown" ? "markdown" : "latex");
  const isCollapsed = targetFormat === null && collapsed;
  const items: ReadonlyArray<{
    readonly id: DocumentFormat;
    readonly label: string;
    readonly detail: string;
    readonly icon: ReactNode;
  }> = [
    {
      id: "latex",
      label: "LaTeX",
      detail: props.installation?.view.summary ?? "",
      icon: <LatexMark className="size-6 shrink-0 text-foreground" />,
    },
    {
      id: "markdown",
      label: "Markdown",
      detail: "Built in",
      icon: <MarkdownMark className="h-auto w-6 shrink-0 text-foreground" />,
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
                detail={item.detail || undefined}
                icon={item.icon}
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
            <LatexPanel hidden={isCollapsed} installation={props.installation} />
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
  return (
    <SettingsPageContainer>
      <DocumentsSection
        installation={installation}
        headerAction={
          <div className="flex items-center gap-1.5">
            <span className="hidden text-xs text-muted-foreground sm:inline">{props.label}</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={installation.refreshing || installation.view.busy}
                    aria-label="Find LaTeX again"
                    onClick={() => void installation.refresh()}
                  >
                    <RefreshCwIcon className={cn(installation.refreshing && "animate-spin")} />
                  </Button>
                }
              />
              <TooltipPopup side="top">Find LaTeX again</TooltipPopup>
            </Tooltip>
          </div>
        }
      />
      <WordExportSettingsSection environmentId={props.environmentId} />
    </SettingsPageContainer>
  );
}

/**
 * Settings ▸ Documents: LaTeX and Markdown side by side, the way Scientific
 * Computing shows its languages, then Word export, which serves documents and
 * conversations alike. Preferences are this device's; the installs are the
 * server's.
 */
export function DocumentsSettings(props: { readonly environmentId?: EnvironmentId | undefined }) {
  const primaryId = usePrimaryEnvironmentId();
  // The environment chosen in the settings scope, unless an older link names
  // one. A scope that resolves to no connected environment shows no server tools.
  const scope = useOptionalSettingsScope();
  const environmentId =
    props.environmentId ??
    (scope === null ? primaryId : (scope.environment?.environmentId ?? null));
  const environment = useEnvironment(environmentId);
  if (environmentId === null || environment === null) {
    return (
      <SettingsPageContainer>
        <DocumentsSection installation={null} />
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
