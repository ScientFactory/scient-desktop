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
  clientSettingsStorageKey: "scient-next:client-settings:v1",
  safetyEnvelopeMarker: "true",
  safetyEnvelopeEnabled: true,
  cloudEnabled: false,
  autoUpdateEnabled: true,
  outboundTelemetryEnabled: false,
} as const;

export type ScientDesktopIdentity = typeof SCIENT_DESKTOP_IDENTITY;
