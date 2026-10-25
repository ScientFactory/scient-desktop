import { describe, expect, it } from "vite-plus/test";

import { formatStartupCrashReport, parseStartupCrashRecords } from "./crash-log-model";

const BUNDLE =
  "/Users/expo/workingdir/build/apps/mobile/ios/build/Build/Intermediates.noindex/ArchiveIntermediates/T3Code/BuildProductsPath/Release-iphoneos/main.jsbundle";
const FATAL = {
  timestamp: 1789277752000,
  level: "error",
  code: "JSRuntimeError",
  message: [
    "ErrorRecovery fatal exception: Fatal error: Time: 1789277752033.127930",
    "Domain: RCTErrorDomain",
    "Code: 0",
    "Description: Unhandled JS Exception: TypeError: Cannot read property 'defaultModelSelection' of null",
    "",
    "This error is located at:",
    `    at NewTaskFlowProvider (${BUNDLE}:590585:51)`,
    `    at NavigationProvider (${BUNDLE}:139067:3)`,
    "    at RNSSafeAreaView (<anonymous>)",
  ].join("\n"),
};

describe("parseStartupCrashRecords", () => {
  // regression: 0a91b9a116 feat(mobile): show startup crashes in Settings → Diagnostics (#11540)
  it("writes the app version and each crash's full detail", () => {
    const report = formatStartupCrashReport(parseStartupCrashRecords([FATAL]), {
      version: "1.1.1",
      build: "56",
    });
    expect(report.startsWith("Scient 1.1.1 (56)\n")).toBe(true);
    expect(report).toContain("2026-09-13T05:35:52.000Z");
    expect(report).toContain("at NewTaskFlowProvider");
  });
});
