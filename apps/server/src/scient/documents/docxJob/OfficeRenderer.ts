/**
 * Runs the pinned LibreOffice on staged copies in a private job folder with an environment built
 * from nothing, a throwaway profile, a deadline and owned-tree kill. This is a process boundary,
 * not an OS sandbox: soffice still runs as the user and could read what the user can read, which
 * is why inputs that reference anything outside the package are refused before staging.
 */
// @effect-diagnostics nodeBuiltinImport:off -- The worker is a native child with owned streams.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { windowsSystem32Path } from "@t3tools/shared/windowsSystem";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const OUTPUT_LOG_BYTES = 64 * 1024;
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const DEAD_PROXY = "http://127.0.0.1:9";

export class OfficeRenderError extends Schema.TaggedError<OfficeRenderError>()(
  "OfficeRenderError",
  {
    reason: Schema.Literals([
      "unsafe-environment",
      "spawn-failed",
      "timeout",
      "failed",
      "missing-output",
      "too-large",
      "staging-failed",
      "unavailable",
    ]),
    exitCode: Schema.NullOr(Schema.Number),
  },
) {
  override get message(): string {
    return `The document renderer stopped: ${this.reason}.`;
  }
}

const isOfficeRenderError = Schema.is(OfficeRenderError);

export interface OfficeStagedFile {
  /** A plain file name inside the job folder, such as `candidate.docx`. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

export class OfficeRenderer extends Context.Service<
  OfficeRenderer,
  {
    /** Each staged Word file rendered to PDF, keyed by its staged name. */
    readonly render: (
      files: ReadonlyArray<OfficeStagedFile>,
    ) => Effect.Effect<ReadonlyMap<string, Uint8Array>, OfficeRenderError>;
  }
>()("t3/scient/documents/docxJob/OfficeRenderer") {}

interface OfficeStaging {
  readonly root: string;
  readonly profile: string;
  readonly home: string;
  readonly tmp: string;
  readonly input: string;
  readonly output: string;
}

const INJECTION = /^(?:LD_|DYLD_|_RLD|LIBPATH$|SHLIB_PATH$)/u;

/** Names that would load code into soffice, such as the LD_PRELOAD socket shim; none may pass. */
export const libraryInjectionKeys = (env: Readonly<Record<string, string>>) =>
  Object.keys(env).filter((key) => INJECTION.test(key.toUpperCase()));

/** The only environment the worker gets; nothing is inherited from Scient's process. */
export function officeEnvironment(input: {
  readonly staging: OfficeStaging;
  readonly platform: NodeJS.Platform;
  readonly hostEnvironment: NodeJS.ProcessEnv;
}): Record<string, string> {
  const { staging } = input;
  const env: Record<string, string> = {
    HOME: staging.home,
    TMPDIR: staging.tmp,
    TMP: staging.tmp,
    TEMP: staging.tmp,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    http_proxy: DEAD_PROXY,
    https_proxy: DEAD_PROXY,
    HTTP_PROXY: DEAD_PROXY,
    HTTPS_PROXY: DEAD_PROXY,
    ALL_PROXY: DEAD_PROXY,
    NO_PROXY: "",
    XDG_CONFIG_HOME: staging.home,
    XDG_CACHE_HOME: staging.tmp,
    XDG_DATA_HOME: staging.home,
    XDG_RUNTIME_DIR: staging.tmp,
  };
  if (input.platform === "win32") {
    const systemRoot =
      input.hostEnvironment.SYSTEMROOT ?? input.hostEnvironment.SystemRoot ?? "C:\\Windows";
    env.SYSTEMROOT = systemRoot;
    env.PATH = `${systemRoot}\\System32`;
    env.USERPROFILE = staging.home;
    env.APPDATA = staging.home;
    env.LOCALAPPDATA = staging.home;
  } else {
    env.PATH = "/usr/bin:/bin";
  }
  return env;
}

export const officeArguments = (staging: OfficeStaging, inputs: ReadonlyArray<string>) => [
  `-env:UserInstallation=${NodeURL.pathToFileURL(staging.profile).href}`,
  "--headless",
  "--invisible",
  "--norestore",
  "--nolockcheck",
  "--nologo",
  "--nodefault",
  "--convert-to",
  "pdf:writer_pdf_Export",
  "--outdir",
  staging.output,
  ...inputs,
];

const makeStaging = Effect.fn("OfficeRenderer.makeStaging")(function* (stagingRoot: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(stagingRoot, { recursive: true, mode: 0o700 });
  const root = yield* Effect.acquireRelease(
    fileSystem.makeTempDirectory({ directory: stagingRoot, prefix: "job-" }),
    (directory) =>
      fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignoreCause()),
  );
  yield* fileSystem.chmod(root, 0o700);
  const staging: OfficeStaging = {
    root,
    profile: path.join(root, "profile"),
    home: path.join(root, "home"),
    tmp: path.join(root, "tmp"),
    input: path.join(root, "in"),
    output: path.join(root, "out"),
  };
  yield* Effect.forEach(
    [staging.profile, staging.home, staging.tmp, staging.input, staging.output],
    (directory) => fileSystem.makeDirectory(directory, { mode: 0o700 }),
    { discard: true },
  );
  return staging;
});

const runOffice = (input: {
  readonly soffice: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly timeout: Duration.Duration;
}) => {
  let stop: (() => Promise<void>) | undefined;
  const fail = (reason: OfficeRenderError["reason"], exitCode: number | null = null) =>
    new OfficeRenderError({ reason, exitCode });
  const run = Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        const child = NodeChildProcess.spawn(input.soffice, [...input.args], {
          cwd: input.cwd,
          env: input.env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: input.platform !== "win32",
          windowsHide: true,
        });
        let closed = false;
        let logged = 0;
        const stdout: Buffer[] = [];
        const closedPromise = new Promise<void>((settle) => child.once("close", () => settle()));
        const kill = () => {
          if (closed || child.pid === undefined) return;
          if (input.platform === "win32") {
            NodeChildProcess.spawnSync(
              windowsSystem32Path(input.hostEnvironment, "taskkill.exe"),
              ["/PID", String(child.pid), "/T", "/F"],
              { windowsHide: true, timeout: 5_000 },
            );
          } else {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
          child.stdout.destroy();
          child.stderr.destroy();
        };
        stop = async () => {
          kill();
          await closedPromise;
        };
        const drain = (chunk: Buffer) => {
          logged += chunk.byteLength;
          if (logged > OUTPUT_LOG_BYTES) kill();
        };
        child.stdout.on("data", (chunk: Buffer) => {
          if (logged + chunk.byteLength <= OUTPUT_LOG_BYTES) stdout.push(chunk);
          drain(chunk);
        });
        child.stderr.on("data", drain);
        child.stdout.on("error", () => {});
        child.stderr.on("error", () => {});
        signal.addEventListener("abort", kill, { once: true });
        let spawnError = false;
        child.on("error", () => {
          spawnError = true;
        });
        child.on("close", (code) => {
          closed = true;
          signal.removeEventListener("abort", kill);
          if (spawnError) reject(fail("spawn-failed"));
          else if (code !== 0) reject(fail("failed", code));
          else resolve(Buffer.concat(stdout).toString("utf8"));
        });
      }),
    catch: (cause) => (isOfficeRenderError(cause) ? cause : fail("spawn-failed")),
  });
  return Effect.acquireUseRelease(
    Effect.void,
    () =>
      run.pipe(
        Effect.timeoutOption(input.timeout),
        Effect.flatMap((done) => Effect.fromOption(done, () => fail("timeout"))),
      ),
    () => Effect.promise(() => stop?.() ?? Promise.resolve()),
  );
};

const STAGED_NAME = /^[a-z][a-z0-9-]{0,63}\.docx$/u;

const unsafeLaunch = (
  soffice: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
) =>
  libraryInjectionKeys(env).length > 0 ||
  [soffice, ...args, ...Object.values(env)].some((value) =>
    /lo_socket_shim|soffice\.py/iu.test(value),
  );

/** What `soffice --version` prints, run the same way as a job. */
export const probeOfficeVersion = Effect.fn("OfficeRenderer.probeVersion")(function* (options: {
  readonly soffice: string;
  readonly stagingRoot: string;
  readonly platform: NodeJS.Platform;
  readonly hostEnvironment: NodeJS.ProcessEnv;
}) {
  const staging = yield* makeStaging(options.stagingRoot).pipe(
    Effect.mapError(() => new OfficeRenderError({ reason: "staging-failed", exitCode: null })),
  );
  const env = officeEnvironment({ staging, ...options });
  const args = [
    `-env:UserInstallation=${NodeURL.pathToFileURL(staging.profile).href}`,
    "--version",
  ];
  if (unsafeLaunch(options.soffice, args, env))
    return yield* new OfficeRenderError({ reason: "unsafe-environment", exitCode: null });
  return yield* runOffice({
    soffice: options.soffice,
    args,
    env,
    cwd: staging.tmp,
    platform: options.platform,
    hostEnvironment: options.hostEnvironment,
    timeout: Duration.seconds(60),
  });
}, Effect.scoped);

/** A renderer bound to one soffice executable; jobs run one at a time per server. */
export const makeOfficeRenderer = Effect.fn("OfficeRenderer.make")(function* (options: {
  readonly soffice: string;
  readonly stagingRoot: string;
  readonly platform: NodeJS.Platform;
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly timeout?: Duration.Input;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const permit = yield* Semaphore.make(1);
  const timeout = Duration.fromInputUnsafe(options.timeout ?? Duration.minutes(2));
  const render = Effect.fn("OfficeRenderer.render")(function* (
    files: ReadonlyArray<OfficeStagedFile>,
  ) {
    const staging = yield* makeStaging(options.stagingRoot).pipe(
      Effect.mapError(() => new OfficeRenderError({ reason: "staging-failed", exitCode: null })),
    );
    if (files.some((file) => !STAGED_NAME.test(file.name)))
      return yield* new OfficeRenderError({ reason: "staging-failed", exitCode: null });
    yield* Effect.forEach(
      files,
      (file) =>
        Effect.tryPromise({
          try: () =>
            NodeFS.promises.writeFile(path.join(staging.input, file.name), file.bytes, {
              flag: "wx",
              mode: 0o600,
            }),
          catch: () => new OfficeRenderError({ reason: "staging-failed", exitCode: null }),
        }),
      { discard: true },
    ).pipe(
      Effect.mapError(() => new OfficeRenderError({ reason: "staging-failed", exitCode: null })),
    );
    const env = officeEnvironment({ staging, ...options });
    const args = officeArguments(
      staging,
      files.map((file) => path.join(staging.input, file.name)),
    );
    if (unsafeLaunch(options.soffice, args, env))
      return yield* new OfficeRenderError({ reason: "unsafe-environment", exitCode: null });
    yield* runOffice({
      soffice: options.soffice,
      args,
      env,
      cwd: staging.tmp,
      platform: options.platform,
      hostEnvironment: options.hostEnvironment,
      timeout,
    });
    const rendered = new Map<string, Uint8Array>();
    for (const file of files) {
      const pdf = path.join(staging.output, file.name.replace(/\.docx$/u, ".pdf"));
      const info = yield* fileSystem
        .stat(pdf)
        .pipe(
          Effect.mapError(() => new OfficeRenderError({ reason: "missing-output", exitCode: 0 })),
        );
      if (info.type !== "File")
        return yield* new OfficeRenderError({ reason: "missing-output", exitCode: 0 });
      if (Number(info.size) > MAX_PDF_BYTES)
        return yield* new OfficeRenderError({ reason: "too-large", exitCode: 0 });
      rendered.set(
        file.name,
        yield* fileSystem
          .readFile(pdf)
          .pipe(
            Effect.mapError(() => new OfficeRenderError({ reason: "missing-output", exitCode: 0 })),
          ),
      );
    }
    return rendered as ReadonlyMap<string, Uint8Array>;
  }, Effect.scoped);
  return OfficeRenderer.of({
    render: Effect.fn("OfficeRenderer.queue")(function* (files) {
      return yield* permit
        .withPermits(1)(render(files))
        .pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
    }),
  });
});
