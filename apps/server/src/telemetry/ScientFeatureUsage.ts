/**
 * Scient's own features, recorded like T3's in `FeatureUsage.ts`: actions people take through
 * requests and routes, and agents through tools. Never a read, refresh or subscription; only the
 * feature name and closed variants, never a path, id or text.
 */
import { WS_METHODS } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest } from "effect/http";

import { AnalyticsService } from "./AnalyticsService.ts";
import type { FeatureUsage } from "./FeatureUsage.ts";

type Payload = Readonly<Record<string, unknown>>;

const IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/u;

function literal(payload: Payload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && IDENTIFIER.test(value) ? value : undefined;
}

const use = (feature: string, variant?: string): FeatureUsage =>
  variant === undefined ? { feature } : { feature, variant };

const enabled = (payload: Payload) =>
  typeof payload.enabled === "boolean" ? (payload.enabled ? "on" : "off") : undefined;

/** WebSocket requests that start a Scient feature. */
const METHOD_FEATURES: Readonly<Record<string, (payload: Payload) => FeatureUsage>> = {
  // Compute and data
  [WS_METHODS.computeStartSession]: (payload) =>
    use("compute.session.start", literal(payload, "languageId")),
  [WS_METHODS.computeRestartSession]: () => use("compute.session.restart"),
  [WS_METHODS.computeInterruptSession]: () => use("compute.interrupt"),
  [WS_METHODS.computeInspectVariables]: () => use("compute.variables.view"),
  [WS_METHODS.computeReadTable]: () => use("compute.table.view"),
  [WS_METHODS.computeSaveOutput]: () => use("compute.output.save"),
  [WS_METHODS.computeSaveConsoleNotebook]: () => use("compute.console.save_notebook"),
  [WS_METHODS.computeManageRuntime]: (payload) =>
    use("compute.runtime.manage", literal(payload, "action")),
  [WS_METHODS.dataReadFileTable]: () => use("data.table.open"),
  [WS_METHODS.analysisPromoteRun]: () => use("analysis.run.promote"),
  [WS_METHODS.analysisCleanupRun]: () => use("analysis.cleanup", "run"),
  [WS_METHODS.analysisCleanupProject]: () => use("analysis.cleanup", "project"),
  // Accounts and papers
  [WS_METHODS.accountsSave]: () => use("accounts.save"),
  [WS_METHODS.accountsRemove]: () => use("accounts.remove"),
  [WS_METHODS.accountsTest]: () => use("accounts.test"),
  [WS_METHODS.accountsLinkKey]: () => use("accounts.key.link"),
  [WS_METHODS.accountsPaperForSource]: () => use("papers.get", "source"),
  [WS_METHODS.accountsPapersRequest]: () => use("papers.get", "request"),
  [WS_METHODS.accountsPapersContinue]: () => use("papers.continue"),
  [WS_METHODS.accountsUniversitySearch]: () => use("university.search"),
  [WS_METHODS.accountsUniversitySignIn]: () => use("university.sign_in"),
  [WS_METHODS.accountsUniversityBrowse]: () => use("university.browse"),
  [WS_METHODS.accountsSetAgentAccess]: () => use("accounts.agent_access.set"),
  [WS_METHODS.accountsProfileChoose]: () => use("accounts.profile.choose"),
  [WS_METHODS.accountsApprovalRespond]: () => use("accounts.approval.respond"),
  [WS_METHODS.accountsOnePasswordConnect]: () => use("accounts.password_manager.connect"),
  [WS_METHODS.accountsImportPasswords]: () => use("accounts.passwords.import"),
  [WS_METHODS.accountsFillValues]: () => use("accounts.fill"),
  // Extensions and skills
  [WS_METHODS.extensionsProviderStoreSearch]: () => use("providers.store.search"),
  [WS_METHODS.extensionsDiscoverSearch]: () => use("extensions.discover.search"),
  [WS_METHODS.extensionsPluginInstall]: () => use("extensions.plugin.install"),
  [WS_METHODS.extensionsPluginRemove]: () => use("extensions.plugin.remove"),
  [WS_METHODS.extensionsPluginSetEnabled]: (payload) =>
    use("extensions.plugin.set_enabled", enabled(payload)),
  [WS_METHODS.extensionsConnectorAdd]: () => use("extensions.connector.add"),
  [WS_METHODS.extensionsConnectorStartSignIn]: () => use("extensions.connector.sign_in"),
  [WS_METHODS.extensionsConnectorRemove]: () => use("extensions.connector.remove"),
  [WS_METHODS.extensionsConnectorTest]: () => use("extensions.connector.test"),
  [WS_METHODS.providerPluginsAct]: (payload) =>
    use(
      "providers.plugin.action",
      typeof payload.action === "object" && payload.action !== null
        ? literal(payload.action as Payload, "type")
        : undefined,
    ),
  [WS_METHODS.skillsSetProjectPreference]: () => use("skills.project_preference.set"),
  [WS_METHODS.skillsSetUserActivation]: () => use("skills.activation.set"),
  [WS_METHODS.providerSkillsSetEnabled]: (payload) =>
    use("providers.skills.set_enabled", enabled(payload)),
  // Models and documents
  [WS_METHODS.serverSaveCustomModel]: () => use("custom_model.save"),
  [WS_METHODS.serverRemoveCustomModel]: () => use("custom_model.remove"),
  [WS_METHODS.serverTestCustomModel]: () => use("custom_model.test"),
  [WS_METHODS.documentsPrepareMarkdownPdf]: () => use("pdf.export", "markdown"),
  [WS_METHODS.documentsPrepareConversationPdf]: () => use("pdf.export", "conversation"),
};

/** The Scient feature a WebSocket request uses, or undefined when it is not one. */
export function scientFeatureUsage(method: string, payload: Payload): FeatureUsage | undefined {
  return METHOD_FEATURES[method]?.(payload);
}

/** Scient HTTP routes that start a feature, by path. Builds and imports have their own events. */
const ROUTE_FEATURES: Readonly<Record<string, FeatureUsage>> = {
  "/api/scient/overleaf/v1/token/save": use("overleaf.token.save"),
  "/api/scient/overleaf/v1/connect": use("overleaf.connect"),
  "/api/scient/overleaf/v1/preview": use("overleaf.preview"),
  "/api/scient/overleaf/v1/diff": use("overleaf.diff"),
  "/api/scient/overleaf/v1/sync": use("overleaf.sync"),
  "/api/scient/overleaf/v1/recover": use("overleaf.recover"),
  "/api/scient/overleaf/v1/kept-copies/restore": use("overleaf.kept_copy.restore"),
  "/api/scient/overleaf/v1/undo": use("overleaf.undo"),
  "/api/scient/overleaf/v1/cancel": use("overleaf.cancel"),
  "/api/scient/overleaf/v1/disconnect": use("overleaf.disconnect"),
  "/api/scient/overleaf/v1/relink": use("overleaf.relink"),
  "/api/scient/sources/attachments/preview": use("sources.attachment.open"),
  "/api/scient/sources/metadata/refresh": use("sources.metadata.refresh"),
  "/api/scient/sources/metadata/update": use("sources.metadata.edit"),
  "/api/scient/sources/note/update": use("sources.note.edit"),
  "/api/scient/sources/review/update": use("sources.review"),
  "/api/scient/sources/remove": use("sources.remove"),
  "/api/scient/sources/zotero/library": use("sources.zotero.browse"),
  "/api/scient/sources/local-files/import/begin": use("sources.import", "local_pdf"),
  "/api/scient/sources/import/begin": use("sources.import", "zotero"),
  "/api/scient/sources/zotero/import-scope/begin": use("sources.import", "zotero_collection"),
  "/api/scient/sources/import/retry": use("sources.import.retry"),
  "/api/scient/latex/toolchain/install": use("latex.toolchain.install"),
  "/api/scient/latex/synctex/forward": use("latex.synctex", "forward"),
  "/api/scient/latex/synctex/inverse": use("latex.synctex", "inverse"),
  "/api/scient/latex/images/upload": use("latex.image.insert"),
  "/api/scient/markdown/images/upload": use("markdown.image.insert"),
  "/api/scient/thread-queue/v2/control": use("thread_queue.control"),
  "/api/scient/conversation-export/v1/export": use("conversation.export"),
  "/api/scient/conversation-import/v1/import": use("conversation.import"),
  "/api/scient/word-export/v1/tool/install": use("word_export.install"),
  "/api/scient/word-export/v1/file": use("word_export", "file"),
  "/api/scient/word-export/v1/latex": use("word_export", "latex"),
};

/** The Scient feature an HTTP request uses, or undefined when it is not one. */
export function scientRouteFeatureUsage(method: string, url: string): FeatureUsage | undefined {
  if (method !== "POST") return undefined;
  return ROUTE_FEATURES[url.split("?", 1)[0] ?? ""];
}

/**
 * Records `feature.used` for Scient's HTTP actions with their outcome and duration. It never
 * reads the request body, and a broken observer never affects the request.
 */
export const scientFeatureUsageLayer = HttpRouter.middleware(
  Effect.gen(function* () {
    // Resolved once with the routes; a request's own context does not carry it.
    const analytics = yield* AnalyticsService;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const usage = scientRouteFeatureUsage(request.method, request.url);
        if (usage === undefined) return yield* httpEffect;
        const startedAt = yield* Clock.currentTimeMillis;
        const record = (outcome: "ok" | "error") =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              analytics.record("feature.used", {
                ...usage,
                outcome,
                durationMs: now - startedAt,
              }),
            ),
            Effect.ignoreCause(),
          );
        return yield* httpEffect.pipe(
          Effect.tap((response) => record(response.status < 400 ? "ok" : "error")),
          Effect.tapCause(() => record("error")),
        );
      });
  }),
  { global: true },
);

/**
 * Scient tools that do work. Like T3's handoff tools, a successful call is recorded too; read,
 * list and status tools are recorded only when they fail, because agents call them in loops.
 */
export const SCIENT_ACTION_TOOLS: ReadonlySet<string> = new Set([
  "scient_compute_run",
  "scient_compute_setup",
  "scient_compute_control",
  "scient_notebook_edit",
  "scient_notebook_run",
  "scient_latex_build",
  "scient_pdf_build",
  "scient_document_export",
  "scient_overleaf_connect",
  "scient_overleaf_sync",
  "scient_overleaf_undo",
  "scient_overleaf_manage",
  "scient_paper_get",
  "scient_sources_add",
  "scient_sources_attach_pdf",
  "scient_sources_review",
  "scient_sources_note_update",
  "scient_sources_update",
  "scient_sources_remove",
  "scient_account_add",
  "scient_account_sign_in",
  "scient_account_fill",
  "scient_account_request",
  "scient_project_create",
  "scient_project_clone",
  "scient_skill_load",
]);
