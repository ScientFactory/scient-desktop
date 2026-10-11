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
