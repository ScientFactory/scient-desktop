export type DesktopUpdateChannelPolicy = "stable-only" | "user-selectable";

/**
 * Scient Desktop's product label plus its production and development runtime identity.
 *
 * Keep this small, explicit, and separate from T3's internal package names.
 * Production uses the canonical Scient install identity. Development and data
 * storage retain their established `scient-next` compatibility values: a
 * repository rename must never relocate or silently reset existing user data.
 */
export const SCIENT_DESKTOP_IDENTITY = {
  baseName: "Scient",
  cliCommandName: "scient",
  developmentName: "Scient (Dev)",
  appId: "com.scientfactory.scient",
  developmentAppId: "com.scientfactory.scient.next.dev",
  baseDirName: ".scient-next",
  productionScheme: "scient",
  developmentScheme: "scient-next-dev",
  productionUserDataDirName: "scient-next",
  developmentUserDataDirName: "scient-next-dev",
  linuxDesktopEntryName: "scient.desktop",
  linuxDevelopmentDesktopEntryName: "scient-next-dev.desktop",
  linuxWmClass: "scient",
  linuxDevelopmentWmClass: "scient-next-dev",
  serviceUnitName: "scient.service",
  serviceLaunchdLabel: "com.scientfactory.scient.service",
  previewPartitionPrefix: "persist:scient-next-preview-",
  previewEphemeralPartitionPrefix: "scient-next-preview-ephemeral-",
  clientSettingsStorageKey: "scient-next:client-settings:v1",
  safetyEnvelopeMarker: "true",
  safetyEnvelopeEnabled: true,
  cloudEnabled: false,
  autoUpdateEnabled: true,
  // SCIENT-FORK:START — Upstream T3 added two project-creation capabilities in
  // `5cc99e1c23`: threads without a project (#13612) and projects created from
  // just a name (#14527). Scratch threads are approved: they retain a real
  // owning project and each runs in its own plain folder. Create-from-name
  // stays off beside Scient's existing "Create & Add". See UPSTREAM.md.
  // The server advertises the matching `ServerConfig` root
  // only when its flag is set, and every client gates on that field, so one
  // server-side switch keeps the UI, the RPCs, and the folders honest.
  projectlessThreadsEnabled: true,
  createProjectFromNameEnabled: false,
  // SCIENT-FORK:END
  desktopUpdateChannelPolicy: "user-selectable" as DesktopUpdateChannelPolicy,
  outboundTelemetryEnabled: false,
} as const;

export type ScientDesktopIdentity = typeof SCIENT_DESKTOP_IDENTITY;

/**
 * File names of the native helpers Scient ships beside the app (T3 names them
 * `t3-*`). Process lists such as Windows Task Manager show these names, so they
 * carry the product name. Windows adds `.exe` to the resource monitor.
 *
 * The Rust crates keep T3's package names; each `native/<crate>/Cargo.toml`
 * declares a matching `[[bin]] name`. Packaging, runtime lookup, and release
 * staging read these values. See UPSTREAM.md, "Scient-owned release seam".
 */
export const SCIENT_HELPER_EXECUTABLES = {
  resourceMonitor: "scient-resource-monitor",
  browserSecret: "scient-browser-secret",
  kdeCapture: "scient-kde-snap-shot",
  hyprlandCapture: "scient-hyprland-snap-shot",
} as const;

/**
 * Capture helpers that releases before the rename installed into the user's
 * data directory. Setup reports them as needing an update and removes them
 * when the helper is reinstalled or removed.
 */
export const LEGACY_CAPTURE_HELPER_EXECUTABLES = {
  kdeCapture: "t3-kde-snap-shot",
  hyprlandCapture: "t3-hyprland-snap-shot",
} as const;
