import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  CONVERSATION_FILE_TYPE,
  linuxConversationMimeXml,
} from "../../scripts/conversation-file-type.mjs";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// Linux ships as an AppImage, so the .desktop entry users end up with is
// created by whatever integration tool they use (AppImageLauncher names it
// appimagekit_<hash>-….desktop) and its filename is not under our control.
// Electron's app.setAsDefaultProtocolClient resolves the desktop id from
// setDesktopName, which cannot match those files — so the browser keeps
// prompting "Choose an application" for every OAuth callback. Instead, write
// our own handler entry pointing at the current AppImage, refresh the desktop
// MIME cache so desktop environments recognize that entry as a handler, and
// use xdg-mime to record it as the scheme default in mimeapps.list.
const { logInfo, logWarning } = makeComponentLogger("desktop-linux-url-handler");

export class DesktopLinuxUrlHandlerRegistrationError extends Schema.TaggedError<DesktopLinuxUrlHandlerRegistrationError>()(
  "DesktopLinuxUrlHandlerRegistrationError",
  {
    step: Schema.Literals([
      "write-desktop-entry",
      "set-default-handler",
      "write-mime-package",
      "install-mime-package",
      "query-file-default",
      "set-file-default-handler",
    ]),
    scheme: Schema.String,
    mimeType: Schema.optionalKey(Schema.String),
    desktopEntryPath: Schema.optionalKey(Schema.String),
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const exitCode = this.exitCode === undefined ? "" : `, xdg-mime exit code ${this.exitCode}`;
    const resource = this.mimeType ?? `${this.scheme}:// URL`;
    return `Failed to register the ${resource} handler (step: ${this.step}${exitCode}).`;
  }
}

const isRegistrationError = Schema.is(DesktopLinuxUrlHandlerRegistrationError);

export class DesktopLinuxUrlHandlerCacheRefreshError extends Schema.TaggedError<DesktopLinuxUrlHandlerCacheRefreshError>()(
  "DesktopLinuxUrlHandlerCacheRefreshError",
  {
    applicationsDir: Schema.String,
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const exitCode =
      this.exitCode === undefined ? "" : `, update-desktop-database exit code ${this.exitCode}`;
    return `Failed to refresh the desktop MIME cache at ${this.applicationsDir}${exitCode}.`;
  }
}

const isCacheRefreshError = Schema.is(DesktopLinuxUrlHandlerCacheRefreshError);

const escapeDesktopEntryString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");

// Exec values are unescaped twice by implementations: first the general
// string-value rules, then the Exec quoting rules — so writing composes the
// layers in reverse. The argument is double-quoted with reserved characters
// backslash-escaped and literal percent signs doubled (field codes), and the
// general string escaping is applied on top: a literal backslash ends up as
// four backslashes in the file, a quote as \\", a dollar sign as \\$.
export function escapeDesktopEntryExecArgument(value: string): string {
  const quoted = value
    .replaceAll("\\", () => "\\\\")
    .replaceAll("`", () => "\\`")
    .replaceAll("$", () => "\\$")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%");
  return escapeDesktopEntryString(`"${quoted}"`);
}

// The AppImage integration entry owns the window identity. This
// hidden URL-only entry must not compete with it for StartupWMClass matching.
export function renderUrlHandlerDesktopEntry(input: {
  readonly displayName: string;
  readonly execTarget: string;
  readonly scheme: string;
  readonly iconPath?: string;
}): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeDesktopEntryString(input.displayName)}`,
    `Exec=${escapeDesktopEntryExecArgument(input.execTarget)} %U`,
    ...(input.iconPath === undefined ? [] : [`Icon=${escapeDesktopEntryString(input.iconPath)}`]),
    "Terminal=false",
    "NoDisplay=true",
    "StartupNotify=false",
    `MimeType=x-scheme-handler/${input.scheme};${CONVERSATION_FILE_TYPE.mediaType};`,
    "",
  ].join("\n");
}

export class DesktopLinuxUrlHandler extends Context.Service<
  DesktopLinuxUrlHandler,
  {
    readonly register: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopLinuxUrlHandler") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const assets = yield* DesktopAssets.DesktopAssets;

  const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);
  const desktopEntryPath = environment.path.join(
    environment.linuxApplicationsDir,
    environment.linuxDesktopEntryName,
  );
  // xdg-mime install copies this vendor-owned XML to the user's mime/packages
  // directory. Keep the source for a future explicit uninstall action; cleanup
  // must use xdg-mime uninstall and remove only this XML and our desktop entry.
  const mimePackagePath = environment.path.join(
    environment.linuxApplicationsDir,
    CONVERSATION_FILE_TYPE.linuxMimePackageName,
  );
  const iconsDir = environment.path.join(environment.linuxApplicationsDir, "..", "icons");
  const iconPath = environment.path.join(iconsDir, `${environment.linuxDesktopEntryName}.png`);

  const writeDesktopEntry = Effect.gen(function* () {
    // Inside the mounted AppImage, process.execPath points at a transient
    // /tmp/.mount_* path — the handler must launch the AppImage itself.
    const execTarget = Option.getOrElse(environment.appImagePath, () => process.execPath);
    const content = renderUrlHandlerDesktopEntry({
      displayName: environment.displayName,
      execTarget,
      scheme,
      ...(environment.isPackaged ? { iconPath } : {}),
    });
    // Pre-ready setup normally wrote this already. Avoid truncating a valid
    // entry while the portal may be reading it during startup.
    const existing = yield* fileSystem
      .readFileString(desktopEntryPath)
      .pipe(Effect.orElseSucceed(() => null));
    if (existing === content) return;
    yield* fileSystem.makeDirectory(environment.linuxApplicationsDir, { recursive: true });
    yield* fileSystem.writeFileString(desktopEntryPath, content);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopLinuxUrlHandlerRegistrationError({
          step: "write-desktop-entry",
          scheme,
          desktopEntryPath,
          cause,
        }),
    ),
  );

  const updateDesktopDatabase = Effect.scoped(
    Effect.gen(function* () {
      const command = ChildProcess.make(
        "update-desktop-database",
        [environment.linuxApplicationsDir],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const handle = yield* spawner.spawn(command);
      const exitCode = yield* handle.exitCode.pipe(Effect.timeout("5 seconds"));
      if (exitCode !== 0) {
        return yield* new DesktopLinuxUrlHandlerCacheRefreshError({
          applicationsDir: environment.linuxApplicationsDir,
          exitCode,
        });
      }
    }),
  ).pipe(
    Effect.mapError((error) =>
      isCacheRefreshError(error)
        ? error
        : new DesktopLinuxUrlHandlerCacheRefreshError({
            applicationsDir: environment.linuxApplicationsDir,
            cause: error,
          }),
    ),
  );

  const setDefaultHandler = Effect.scoped(
    Effect.gen(function* () {
      const command = ChildProcess.make(
        "xdg-mime",
        ["default", environment.linuxDesktopEntryName, `x-scheme-handler/${scheme}`],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const handle = yield* spawner.spawn(command);
      const exitCode = yield* handle.exitCode;
      if ((exitCode as unknown as number) !== 0) {
        return yield* new DesktopLinuxUrlHandlerRegistrationError({
          step: "set-default-handler",
          scheme,
          exitCode: Number(exitCode),
        });
      }
    }),
  ).pipe(
    Effect.mapError((error) =>
      isRegistrationError(error)
        ? error
        : new DesktopLinuxUrlHandlerRegistrationError({
            step: "set-default-handler",
            scheme,
            cause: error,
          }),
    ),
  );

  const registerMimeType = Effect.gen(function* () {
    const content = linuxConversationMimeXml();
    yield* Effect.gen(function* () {
      const existing = yield* fileSystem
        .readFileString(mimePackagePath)
        .pipe(Effect.orElseSucceed(() => null));
      if (existing !== content) {
        yield* fileSystem.makeDirectory(environment.linuxApplicationsDir, { recursive: true });
        yield* fileSystem.writeFileString(mimePackagePath, content);
      }
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopLinuxUrlHandlerRegistrationError({
            step: "write-mime-package",
            scheme,
            mimeType: CONVERSATION_FILE_TYPE.mediaType,
            desktopEntryPath: mimePackagePath,
            cause,
          }),
      ),
    );

    const runMimeCommand = (
      step: "install-mime-package" | "set-file-default-handler",
      args: string[],
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make("xdg-mime", args, {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          );
          const exitCode = Number(yield* handle.exitCode);
          if (exitCode !== 0) {
            return yield* new DesktopLinuxUrlHandlerRegistrationError({
              step,
              scheme,
              mimeType: CONVERSATION_FILE_TYPE.mediaType,
              exitCode,
            });
          }
        }),
      );

    yield* runMimeCommand("install-mime-package", ["install", "--mode", "user", mimePackagePath]);

    // A user or another application may already own the default. Only seed a
    // missing default; later launches never override an explicit choice.
    const currentDefault = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("xdg-mime", ["query", "default", CONVERSATION_FILE_TYPE.mediaType], {
            stdin: "ignore",
            stderr: "ignore",
          }),
        );
        const output = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString);
        const exitCode = Number(yield* handle.exitCode);
        if (exitCode !== 0) {
          return yield* new DesktopLinuxUrlHandlerRegistrationError({
            step: "query-file-default",
            scheme,
            mimeType: CONVERSATION_FILE_TYPE.mediaType,
            exitCode,
          });
        }
        return output.trim();
      }),
    );
    if (currentDefault.length === 0) {
      yield* runMimeCommand("set-file-default-handler", [
        "default",
        environment.linuxDesktopEntryName,
        CONVERSATION_FILE_TYPE.mediaType,
      ]);
    }
  }).pipe(
    Effect.mapError((error) =>
      isRegistrationError(error)
        ? error
        : new DesktopLinuxUrlHandlerRegistrationError({
            step: "install-mime-package",
            scheme,
            mimeType: CONVERSATION_FILE_TYPE.mediaType,
            cause: error,
          }),
    ),
  );

  const register = Effect.gen(function* () {
    if (environment.platform !== "linux") {
      return;
    }
    yield* writeDesktopEntry;
    if (!environment.isPackaged) return;

    yield* Effect.gen(function* () {
      const { png } = yield* assets.iconPaths;
      if (Option.isNone(png)) return;
      // The AppImage mount is temporary; the chooser needs the icon after exit.
      yield* fileSystem.makeDirectory(iconsDir, { recursive: true });
      yield* fileSystem.copyFile(png.value, iconPath);
    }).pipe(
      Effect.catch((error) =>
        logWarning("URL handler icon copy failed", { iconPath, category: error.reason._tag }),
      ),
    );

    yield* updateDesktopDatabase.pipe(
      // Some MIME implementations, including GIO, use mimeinfo.cache to verify
      // that a desktop entry is associated with a scheme. Cache refresh is
      // independently best-effort so a missing update-desktop-database executable
      // does not prevent xdg-mime from recording the requested default.
      Effect.catch((error) =>
        logWarning("desktop MIME cache refresh failed", {
          applicationsDir: environment.linuxApplicationsDir,
          message: error.message,
          ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
        }),
      ),
    );

    yield* setDefaultHandler;
    yield* registerMimeType;
    yield* logInfo("registered URL and conversation file handlers", {
      scheme,
      mimeType: CONVERSATION_FILE_TYPE.mediaType,
    });
  }).pipe(
    // Registration is best-effort: a missing xdg-mime or read-only home must
    // never block startup — the OS chooser remains as fallback.
    Effect.catch((error) =>
      logWarning("desktop handler registration failed", {
        scheme,
        ...(error.mimeType === undefined ? {} : { mimeType: error.mimeType }),
        step: error.step,
        message: error.message,
        ...(error.desktopEntryPath === undefined
          ? {}
          : { desktopEntryPath: error.desktopEntryPath }),
        ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
      }),
    ),
    Effect.withSpan("desktop.linuxUrlHandler.register"),
  );

  return DesktopLinuxUrlHandler.of({ register });
});

export const layer = Layer.effect(DesktopLinuxUrlHandler, make);
