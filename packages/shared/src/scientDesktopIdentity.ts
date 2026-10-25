export type DesktopUpdateChannelPolicy = "stable-only" | "user-selectable";

/**
 * Keep development/data scient-next identities compatible. Repository/product renames must never
 * relocate or reset existing user state; internal T3 package names remain separate.
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
  // Scratch retains an owning project and a private plain folder; create-from-name stays disabled.
  // Advertise capability only through ServerConfig when its server flag is set so clients and RPCs
  // share one gate. See UPSTREAM.md.
  projectlessThreadsEnabled: true,
  createProjectFromNameEnabled: false,
  // SCIENT-FORK:END
  desktopUpdateChannelPolicy: "user-selectable" as DesktopUpdateChannelPolicy,
  outboundTelemetryEnabled: false,
} as const;

export type ScientDesktopIdentity = typeof SCIENT_DESKTOP_IDENTITY;
