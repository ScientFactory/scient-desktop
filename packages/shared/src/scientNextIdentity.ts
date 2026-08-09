/**
 * Scient's product label plus its production and development runtime identity.
 *
 * Keep this small, explicit, and separate from T3's internal package names.
 * Production deliberately keeps the canonical Scient install identity so the
 * existing updater can replace the legacy desktop app. Development and data
 * storage remain isolated: a production update must never silently open or
 * mutate the legacy app's user-data directory.
 */
export const SCIENT_NEXT_IDENTITY = {
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
  previewPartitionPrefix: "persist:scient-next-preview-",
  clientSettingsStorageKey: "scient-next:client-settings:v1",
  safetyEnvelopeMarker: "true",
  safetyEnvelopeEnabled: true,
  cloudEnabled: false,
  autoUpdateEnabled: true,
  outboundTelemetryEnabled: false,
} as const;

export type ScientNextIdentity = typeof SCIENT_NEXT_IDENTITY;
