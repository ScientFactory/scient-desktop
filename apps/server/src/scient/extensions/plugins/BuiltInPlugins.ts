/**
 * Existing Scient features described as built-in plugins for the Extensions
 * library. These entries are read-only descriptions: each feature keeps its
 * own settings and grants, so no parallel plugin switch exists. Tool names
 * mirror apps/server/src/mcp/toolkits/<family>/tools.ts.
 */
import type { ExtensionComponent, ScientPluginSummary } from "@t3tools/contracts";

const tools = (capability: string, names: ReadonlyArray<string>): ExtensionComponent => ({
  type: "mcp-tools",
  name: capability,
  detail: names.join(", "),
});

const builtIn = (
  plugin: Pick<ScientPluginSummary, "pluginId" | "displayName" | "description" | "components"> & {
    readonly settingsPath?: string;
  },
): ScientPluginSummary => ({
  ...plugin,
  version: "built-in",
  publisher: "Scient",
  origin: "built-in",
  enabled: true,
  canSetEnabled: false,
  canRemove: false,
  connectorIds: [],
});

export const BUILT_IN_SCIENT_PLUGINS: ReadonlyArray<ScientPluginSummary> = [
  builtIn({
    pluginId: "scient.sources",
    displayName: "Sources",
    description: "Project reference library that agents can read and, when asked, update.",
    components: [
      tools("sources:read", ["scient_sources_list", "scient_sources_get"]),
      tools("sources:write", [
        "scient_sources_add",
        "scient_sources_update",
        "scient_sources_note_update",
        "scient_sources_review",
        "scient_sources_remove",
        "scient_sources_attach_pdf",
        "scient_sources_detach_pdf",
      ]),
      { type: "panel", name: "Sources" },
    ],
  }),
  builtIn({
    pluginId: "scient.documents",
    displayName: "Documents",
    description: "Build validated PDFs from HTML, LaTeX and Markdown project documents.",
    components: [
      tools("documents:build", [
        "scient_pdf_build",
        "scient_latex_build",
        "scient_document_export",
      ]),
    ],
    settingsPath: "/settings/documents",
  }),
  builtIn({
    pluginId: "scient.compute",
    displayName: "Compute",
    description: "Read-only inventory of configured and managed scientific computing runtimes.",
    components: [tools("compute:inventory", ["scient_compute_inventory"])],
    settingsPath: "/settings/scientific-computing",
  }),
  builtIn({
    pluginId: "scient.browser-devices",
    displayName: "Browser and devices",
    description: "Shared browser automation and iOS Simulator or Android Emulator control.",
    components: [
      tools("preview", [
        "preview_status",
        "preview_open",
        "preview_navigate",
        "preview_snapshot",
        "preview_click",
        "preview_type",
        "preview_hover",
        "preview_select",
        "preview_drag",
        "preview_upload",
        "preview_press",
        "preview_scroll",
        "preview_evaluate",
        "preview_wait_for",
        "preview_resize",
        "preview_set_appearance",
        "preview_dialog",
        "preview_recording_start",
        "preview_recording_stop",
        "scient_preview_list",
        "scient_preview_close",
      ]),
      tools("device", ["device_list", "device_open", "device_close", "device_screenshot"]),
      { type: "panel", name: "Browser" },
      { type: "panel", name: "Device" },
    ],
    settingsPath: "/settings/integrations",
  }),
  builtIn({
    pluginId: "scient.pull-requests",
    displayName: "Pull requests",
    description: "Link, watch and guide pull requests opened from Scient threads.",
    components: [
      tools("pull-requests", [
        "link_pull_request",
        "unlink_pull_request",
        "list_thread_pull_requests",
        "watch_pull_request",
        "unwatch_pull_request",
        "write_pull_request_guides",
        "read_pull_request_guide",
      ]),
    ],
    settingsPath: "/settings/source-control",
  }),
  builtIn({
    pluginId: "scient.skills",
    displayName: "Skills",
    description: "Reviewed Scient skills that agents load through turn-scoped skill tools.",
    components: [
      tools("skills:read", [
        "scient_skills_list",
        "scient_skill_load",
        "scient_skill_read_resource",
      ]),
    ],
    settingsPath: "/settings/skills",
  }),
];

/** Bundles may not reuse Scient's namespace, so a bundle cannot impersonate a built-in. */
export const isReservedScientPluginId = (pluginId: string): boolean =>
  pluginId === "scient" || pluginId.startsWith("scient.");
