/** Browser setup installs Linux sandbox policy and missing browser libraries together.
 * Rootless calls print the changes and sudo command; repeated setup skips completed work. */
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";
import { resolveRootCliCommand } from "./invocation.ts";

export class BrowserSetupStepError extends Schema.TaggedError<BrowserSetupStepError>()(
  "BrowserSetupStepError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Could not ${this.step}: ${this.detail}`;
  }
}

const runStep = Effect.fn("browserSetup.runStep")(function* (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make(command, args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
    )
    .pipe(Effect.mapError((cause) => new BrowserSetupStepError({ step, detail: String(cause) })));
  if (exitCode !== 0) {
    return yield* new BrowserSetupStepError({ step, detail: `${command} exited with ${exitCode}` });
  }
});

/**
 * Keep setup on the invoking user's profile even when sudo changes HOME.
 * Scient's compatibility home is authoritative; ambient T3 state is not.
 */
export const resolveBrowserSetupBaseDir = Effect.fn("browserSetup.baseDir")(function* (
  explicit: Option.Option<string>,
) {
  const env = yield* HostProcess.Environment;
  const raw =
    Option.getOrUndefined(explicit.pipe(Option.filter((value) => value.trim().length > 0))) ??
    (env.SCIENT_NEXT_HOME?.trim() || undefined) ??
    (SCIENT_DESKTOP_IDENTITY.safetyEnvelopeEnabled
      ? undefined
      : env.T3CODE_HOME?.trim() || undefined);
  if (raw !== undefined) return yield* resolveBaseDir(raw);
  if (env.SUDO_USER === undefined) {
    if ((yield* HostProcess.UserId) === 0) {
      return yield* new BrowserSetupStepError({
        step: "resolve the invoking user's profile",
        detail:
          "Root setup requires --base-dir or SCIENT_NEXT_HOME; no invoking user is available.",
      });
    }
    return yield* resolveBaseDir(undefined);
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const entry = yield* spawner
    .string(
      ChildProcess.make("getent", ["passwd", env.SUDO_USER], { stdin: "ignore", stderr: "ignore" }),
    )
    .pipe(Effect.orElseSucceed(() => ""));
  const home = entry.trim().split(":")[5];
  if (!home) {
    return yield* new BrowserSetupStepError({
      step: "resolve the invoking user's profile",
      detail: `Could not find the home directory for ${env.SUDO_USER}; pass --base-dir explicitly.`,
    });
  }
  return yield* resolveBaseDir(undefined).pipe(
    Effect.provideService(HostProcess.HomeDirectory, home),
  );
});

const aptOffers = Effect.fn("browserSetup.aptOffers")(function* (name: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const policy = yield* spawner
    .string(ChildProcess.make("apt-cache", ["policy", name], { stdin: "ignore", stderr: "ignore" }))
    .pipe(Effect.orElseSucceed(() => ""));
  const candidate = /Candidate:\s*(\S+)/.exec(policy)?.[1];
  return candidate !== undefined && candidate !== "(none)";
});

/** The installed browser in this profile, if any, to check its libraries. */
const installedBrowser = Effect.fn("browserSetup.installedBrowser")(function* (baseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(baseDir, "tools", "chrome-headless-shell");
  for (const platform of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
    for (const version of yield* fs
      .readDirectory(path.join(root, platform))
      .pipe(Effect.orElseSucceed(() => []))) {
      const executable = path.join(root, platform, version, "chrome-headless-shell");
      if (yield* fs.exists(executable).pipe(Effect.orElseSucceed(() => false))) {
        return Option.some(executable);
      }
    }
  }
  return Option.none<string>();
});

/**
 * Chrome starts without fonts, but pages then render no text. Without
 * fontconfig there is no `fc-match` at all, which counts as no font.
 */
const fontAvailable = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const font = yield* spawner
    .string(
      ChildProcess.make("fc-match", ["--format=%{file}", "sans-serif"], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => ""),
    );
  return font.trim() !== "";
}).pipe(Effect.withSpan("browserSetup.fontAvailable"));

const FONT_PACKAGES = ["fontconfig", "fonts-liberation"];

const browserSetupCommand = Command.make("setup", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Set up this Linux host for Scient's browser: allow Chrome's sandbox and install its libraries and fonts.",
  ),
  Command.withHandler(({ baseDir }) =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "linux") {
        return yield* Console.log("Nothing to set up: Scient's browser runs as is on this system.");
      }
      const fs = yield* FileSystem.FileSystem;
      const isRoot = (yield* HostProcess.UserId) === 0;
      const profile = yield* resolveBrowserSetupBaseDir(baseDir);
      const setupCommand = yield* resolveRootCliCommand([
        ...PreviewBrowserHost.SETUP_ARGUMENTS,
        "--base-dir",
        profile,
      ]);
      // Root, unless sudo came from another user, is likely the server's own account.
      const env = yield* HostProcess.Environment;
      const rootWarning =
        isRoot && (env.SUDO_USER ?? "root") === "root" && !PreviewBrowserHost.sandboxDisabled(env)
          ? new PreviewBrowserHost.PreviewBrowserRootError().message
          : undefined;

      const needsProfile = yield* PreviewBrowserHost.sandboxBlocked;
      const browser = yield* installedBrowser(profile);
      const missing = Option.isSome(browser)
        ? yield* PreviewBrowserHost.missingLibraries(browser.value)
        : [];
      const needsFonts = !(yield* fontAvailable);
      const hasApt = yield* fs.exists("/usr/bin/apt-get").pipe(Effect.orElseSucceed(() => false));

      if (!needsProfile && missing.length === 0 && !needsFonts) {
        return yield* Console.log(
          rootWarning ??
            (Option.isSome(browser)
              ? "This host is ready for Scient's browser."
              : "Chrome's sandbox is allowed here. Scient's browser installs on first use; if it then reports missing libraries, run this again."),
        );
      }

      if (!isRoot) {
        if (needsProfile) {
          yield* Console.log(
            `This host blocks the sandbox Scient's browser runs in. Setup installs an AppArmor profile at ${PreviewBrowserHost.APPARMOR_PROFILE_PATH} that allows it.`,
          );
        }
        if (missing.length > 0) {
          yield* Console.log(
            `Scient's browser is missing ${missing.join(", ")}; setup installs them.`,
          );
        }
        if (needsFonts) {
          yield* Console.log(
            "Scient's browser needs fontconfig and system fonts; setup installs them.",
          );
        }
        return yield* Console.log(`\nThis needs root. Run:\n\n  ${setupCommand}\n`);
      }

      if (needsProfile) {
        yield* fs
          .writeFileString(
            PreviewBrowserHost.APPARMOR_PROFILE_PATH,
            PreviewBrowserHost.APPARMOR_PROFILE,
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new BrowserSetupStepError({
                  step: `write ${PreviewBrowserHost.APPARMOR_PROFILE_PATH}`,
                  detail: cause.message,
                }),
            ),
          );
        yield* runStep("load the AppArmor profile", "apparmor_parser", [
          "-r",
          PreviewBrowserHost.APPARMOR_PROFILE_PATH,
        ]);
        yield* Console.log("Allowed Chrome's sandbox for Scient's browser.");
      }

      if ((missing.length > 0 || needsFonts) && !hasApt) {
        if (missing.length > 0) {
          yield* Console.log(
            `Scient's browser is missing ${missing.join(", ")}. Install them with your package manager, then run this again.`,
          );
        }
        if (needsFonts) {
          yield* Console.log(
            "Scient's browser needs fontconfig and system fonts. Install them with your package manager, then run this again.",
          );
        }
        return;
      }
      if (missing.length > 0 || needsFonts) {
        yield* runStep("refresh the package lists", "apt-get", ["update"]);
      }

      if (missing.length > 0) {
        const packages = yield* Effect.forEach(PreviewBrowserHost.DEBIAN_PACKAGES, (names) =>
          Effect.findFirst(names, aptOffers).pipe(Effect.map(Option.getOrElse(() => names[0]!))),
        );
        yield* runStep("install the browser's libraries", "apt-get", [
          "install",
          "-y",
          "--no-install-recommends",
          ...packages,
        ]);
        yield* Console.log("Installed the browser's libraries.");
      }

      if (needsFonts) {
        yield* runStep("install the browser's fonts", "apt-get", [
          "install",
          "-y",
          "--no-install-recommends",
          ...FONT_PACKAGES,
        ]);
        if (!(yield* fontAvailable)) {
          return yield* Console.log(
            "Font packages are installed, but Fontconfig still finds no system font. Check its configuration and run setup again.",
          );
        }
        yield* Console.log(
          "Installed the browser's fonts. Restart the Scient server if browser tabs were already open.",
        );
      }

      yield* Console.log(rootWarning ?? "This host is ready for Scient's browser.");
    }),
  ),
);

export const browserCommand = Command.make("browser").pipe(
  Command.withDescription("Manage Scient's headless browser on this host."),
  Command.withSubcommands([browserSetupCommand]),
);
