import type {
  BrowserImportFailureReason,
  BrowserImportSource,
  BrowserImportUnavailableReason,
  SessionCookie,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type {
  CookieReadResult,
  ImportedCookie,
} from "../../preview/BrowserImport/CookieDatabase.ts";
import {
  connectableDefinition,
  listSourceProfiles,
  type BrowserImportPathContext,
  type BrowserImportSourceDefinition,
} from "../../preview/BrowserImport/Sources.ts";
import { browserConnections } from "./browserConnection.ts";
import { installedChromiumBrowsers } from "./chromeWindow.ts";

/** A cookie the browser handed over, as an import from its files would have read it. */
export function importedCookie(cookie: SessionCookie): ImportedCookie {
  const https =
    cookie.secure || cookie.name.startsWith("__Host-") || cookie.name.startsWith("__Secure-");
  return {
    url: `${https ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,
    // Host-only cookies carry no domain, as the import's writer expects.
    domain: cookie.hostOnly ? undefined : cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expirationDate: cookie.expires,
    sameSite: cookie.sameSite,
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  };
}

/**
 * A browser Windows keeps from other apps, listed with its profiles and how to connect; undefined
 * for any other browser. Profiles come from its metadata: its cookie files are never opened.
 */
export const listedThroughBrowser = Effect.fn("DesktopAccounts.listedThroughBrowser")(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  unavailable: BrowserImportUnavailableReason | undefined,
) {
  const connectable =
    unavailable === "appBoundEncryption" ? connectableDefinition(definition, context) : undefined;
  if (connectable === undefined) return undefined;
  return {
    id: definition.id,
    name: definition.name,
    profiles: yield* listSourceProfiles(connectable.definition, context, false),
    unavailable,
    connection: { settingsUrl: connectable.connection.settingsUrl },
  } satisfies BrowserImportSource;
});

export type ReadThroughBrowser =
  | { readonly ok: true; readonly read: CookieReadResult }
  | { readonly ok: false; readonly reason: BrowserImportFailureReason };

/**
 * The profile's cookies handed over by its browser, for a browser Windows keeps from other apps;
 * undefined for any other browser, which is read from its files. The profile must be listed.
 */
export const readThroughBrowser = Effect.fn("DesktopAccounts.readThroughBrowser")(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  input: {
    readonly unavailable: BrowserImportUnavailableReason | undefined;
    readonly sourceProfileDirectory: string;
    readonly environment: NodeJS.ProcessEnv;
  },
) {
  const connectable =
    input.unavailable === "appBoundEncryption"
      ? connectableDefinition(definition, context)
      : undefined;
  if (connectable === undefined) return undefined;
  const fail = (reason: BrowserImportFailureReason): ReadThroughBrowser => ({ ok: false, reason });
  // Only a listed profile: the directory goes on the browser's command line.
  const listed = yield* listSourceProfiles(connectable.definition, context, false);
  if (!listed.some((profile) => profile.directory === input.sourceProfileDirectory))
    return fail("unknownSourceProfile");
  // Off: nothing opens, and the person learns which setting to turn on.
  if (!(yield* Effect.promise(() => browserConnections.isOn(connectable.userDataDirectory))))
    return fail("connectionOff");
  const browser = installedChromiumBrowsers({
    platform: context.platform,
    env: input.environment,
    home: input.environment.HOME ?? input.environment.USERPROFILE ?? "",
  }).find(({ name }) => name === connectable.connection.browser);
  if (browser === undefined) return fail("connectionFailed");
  // Every wait and refusal settles as an outcome; a defect still reads as a failed connection.
  const read = yield* Effect.promise(() =>
    browserConnections
      .readProfile(
        { userDataDirectory: connectable.userDataDirectory, executable: browser.executable },
        input.sourceProfileDirectory,
      )
      .catch(() => ({ ok: false as const, reason: "connectionFailed" as const })),
  );
  if (!read.ok) return fail(read.reason);
  return {
    ok: true,
    read: {
      cookies: read.cookies.map(importedCookie),
      // Cookies whose partition Scient can't carry exactly are left out, never altered.
      undecryptable: read.unsupported,
      undecryptableHosts: [],
      skippedByReason: {
        appBoundEncryption: 0,
        decryptFailed: 0,
        partitionUnsupported: read.unsupported,
      },
    },
  } satisfies ReadThroughBrowser;
});

/** Whether the source's browser has remote debugging on; undefined for any other browser. */
export const throughBrowserIsOn = (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
) => {
  const connectable = connectableDefinition(definition, context);
  return connectable === undefined
    ? Effect.undefined
    : Effect.promise(() => browserConnections.isOn(connectable.userDataDirectory));
};
