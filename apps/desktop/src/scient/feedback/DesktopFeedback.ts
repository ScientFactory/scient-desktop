// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalJsonInEffect:off -- small files this process owns, read and written whole with wall-clock stamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  FEEDBACK_ATTACHMENT_MAX_BYTES,
  FEEDBACK_CLIENT_ID_HEADER,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  FEEDBACK_STATUS_MAX_IDS,
  FeedbackReport,
  FeedbackStatusResponse,
  type FeedbackAppDetails,
  type FeedbackAttachmentKind,
  type FeedbackFixedNotice,
  type FeedbackPreparation,
  type FeedbackReportId,
  type FeedbackScreenshot,
  type FeedbackSubmitRequest,
  type FeedbackSubmitResult,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { installFeedbackIpc } from "./ipc.ts";
import { scientAnalyticsMetadata } from "../../backend/scientAnalyticsMetadata.ts";
import {
  excerpt,
  feedbackEndpoint,
  redactLogText,
  rendererCrashesSince,
  retryDelayMs,
  runsFixedVersion,
  tailLines,
  traceFailuresSince,
} from "./feedbackLogic.ts";

const DAY_MS = 86_400_000;
const OUTBOX_MAX_REPORTS = 30;
const OUTBOX_MAX_AGE_MS = 30 * DAY_MS;
const STATUS_MAX_AGE_MS = 180 * DAY_MS;
const SENT_MAX_ENTRIES = 100;
const UPLOAD_TIMEOUT_MS = 20_000;
const SCREENSHOT_LONG_EDGE = 2048;
const SERVER_LOG_TAIL_BYTES = 64 * 1024;
const TRACE_TAIL_BYTES = 4 * 1024 * 1024;
const LOG_FAILURES = 40;
const LOG_CAUSE_CHARS = 600;

const PART_FILES: Record<FeedbackAttachmentKind, string> = {
  screenshot: "screenshot.jpg",
  logs: "logs.txt",
  conversation: "conversation.md",
};

const encodeReport = Schema.encodeSync(Schema.fromJsonString(FeedbackReport));
const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(FeedbackReport));
const decodeStatus = Schema.decodeUnknownSync(FeedbackStatusResponse);

interface OutboxMeta {
  readonly attempts: number;
  readonly nextAttemptAt: number;
  /** Set when saved; older reports are dropped after 30 days. */
  readonly createdAt?: number;
}

interface SentEntry {
  readonly id: FeedbackReportId;
  readonly sentAt: number;
  readonly excerpt: string;
  readonly fixedIn?: string;
  readonly note?: string | null;
  /** True once the fix notice was handed to a window. */
  readonly noticeShown?: boolean;
}

interface ClientIdentity {
  readonly clientId: string;
  readonly token: string;
}

type UploadOutcome = "sent" | "retry" | "rejected";

export class DesktopFeedback extends Context.Service<
  DesktopFeedback,
  {
    readonly prepare: Effect.Effect<FeedbackPreparation>;
    readonly captureScreenshot: (senderId: number) => Effect.Effect<FeedbackScreenshot | null>;
    readonly readRecentLogs: Effect.Effect<string>;
    readonly submit: (request: FeedbackSubmitRequest) => Effect.Effect<FeedbackSubmitResult>;
    readonly takeFixedNotices: Effect.Effect<ReadonlyArray<FeedbackFixedNotice>>;
  }
>()("@t3tools/desktop/scient/feedback/DesktopFeedback") {}

const buildChannel = (value: string): FeedbackAppDetails["channel"] =>
  value === "stable" || value === "beta" || value === "nightly" || value === "development"
    ? value
    : "unknown";

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};

/** Write to a sibling and rename, so a crash never leaves half a file. */
const writeFileAtomic = (file: string, contents: string | Uint8Array) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, contents, { mode: 0o600 });
  NodeFS.renameSync(temporary, file);
};

const readText = (file: string) => {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** The last `bytes` of a file, or "" when it can't be read. */
const readTail = (file: string, bytes: number) => {
  let descriptor: number | undefined;
  try {
    descriptor = NodeFS.openSync(file, "r");
    const size = NodeFS.fstatSync(descriptor).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    NodeFS.readSync(descriptor, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) NodeFS.closeSync(descriptor);
  }
};

const modifiedWithin = (file: string, ms: number) => {
  try {
    return Date.now() - NodeFS.statSync(file).mtimeMs <= ms;
  } catch {
    return false;
  }
};

export const layer = Layer.effect(
  DesktopFeedback,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const root = NodePath.join(environment.stateDir, "feedback");
    const outbox = NodePath.join(root, "outbox");
    const sentFile = NodePath.join(root, "sent.json");
    const settingsFile = NodePath.join(root, "settings.json");
    const clientFile = NodePath.join(root, "client.json");
    const endpoint = feedbackEndpoint({
      isPackaged: environment.isPackaged,
      isDevelopment: environment.isDevelopment,
      testEndpoint: yield* Config.String("SCIENT_FEEDBACK_TEST_ENDPOINT").pipe(
        Config.withDefault(""),
      ),
    });
    const channel = buildChannel(
      scientAnalyticsMetadata({
        appVersion: environment.appVersion,
        isDevelopment: environment.isDevelopment,
        isPackaged: environment.isPackaged,
      }).SCIENT_ANALYTICS_BUILD_CHANNEL,
    );
    const lock = yield* Semaphore.make(1);

    const identity = (): ClientIdentity => {
      const saved = readJson<Partial<ClientIdentity>>(clientFile, {});
      if (typeof saved.clientId === "string" && typeof saved.token === "string") {
        return { clientId: saved.clientId, token: saved.token };
      }
      const created = {
        clientId: NodeCrypto.randomBytes(32).toString("base64url"),
        token: NodeCrypto.randomBytes(32).toString("base64url"),
      };
      writeFileAtomic(clientFile, JSON.stringify(created));
      return created;
    };

    const rendererHistory = () =>
      [
        NodePath.join(environment.logDir, "renderer-history.ndjson.1"),
        NodePath.join(environment.logDir, "renderer-history.ndjson"),
      ]
        .map(readText)
        .join("\n");

    const serverTrace = () =>
      [
        readTail(NodePath.join(environment.logDir, "server.trace.ndjson.1"), TRACE_TAIL_BYTES / 2),
        readTail(NodePath.join(environment.logDir, "server.trace.ndjson"), TRACE_TAIL_BYTES),
      ].join("\n");

    const details = (): FeedbackAppDetails => {
      const platform = environment.platform;
      return {
        version: environment.appVersion.slice(0, 64),
        channel,
        platform:
          platform === "darwin" || platform === "win32" || platform === "linux"
            ? platform
            : "other",
        osVersion: process.getSystemVersion().slice(0, 64),
        arch: environment.processArch.slice(0, 16),
        locale: Electron.app.getLocale().slice(0, 35) || "unknown",
        rendererCrashes24h: Math.min(
          rendererCrashesSince(rendererHistory(), Date.now() - DAY_MS).length,
          1000,
        ),
        recentFailures: traceFailuresSince(serverTrace(), Date.now() - DAY_MS)
          .slice(0, 5)
          .map((failure) => ({
            name: failure.name.slice(0, 120),
            at: new Date(failure.endedAtMs).toISOString(),
            traceId: failure.traceId.slice(0, 64),
          })),
      };
    };

    const readSent = () => readJson<Array<SentEntry>>(sentFile, []);
    const writeSent = (entries: ReadonlyArray<SentEntry>) =>
      writeFileAtomic(sentFile, JSON.stringify(entries.slice(-SENT_MAX_ENTRIES)));

    const upload = (directory: string): Effect.Effect<UploadOutcome> =>
      Effect.promise(async (): Promise<UploadOutcome> => {
        if (endpoint === null) return "retry";
        const reportText = NodeFS.readFileSync(NodePath.join(directory, "report.json"), "utf8");
        const report = decodeReport(reportText);
        const form = new FormData();
        form.set("report", reportText);
        for (const attachment of report.attachments) {
          const bytes = NodeFS.readFileSync(NodePath.join(directory, PART_FILES[attachment.kind]));
          form.set(attachment.kind, new Blob([new Uint8Array(bytes)]), PART_FILES[attachment.kind]);
        }
        // Serialized first so the request carries a content-length, which the service requires.
        const encoded = new Response(form);
        const body = new Uint8Array(await encoded.arrayBuffer());
        const { clientId, token } = identity();
        try {
          const response = await Electron.net.fetch(`${endpoint}/v1/reports`, {
            method: "POST",
            body,
            headers: {
              "content-type": encoded.headers.get("content-type") ?? "",
              authorization: `Bearer ${token}`,
              [FEEDBACK_CLIENT_ID_HEADER]: clientId,
            },
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          });
          if (response.ok) return "sent";
          return response.status === 429 || response.status >= 500 ? "retry" : "rejected";
        } catch {
          return "retry";
        }
      }).pipe(Effect.catchDefect(() => Effect.succeed<UploadOutcome>("rejected")));

    const settle = (directory: string, outcome: UploadOutcome) =>
      Effect.sync(() => {
        const id = NodePath.basename(directory) as FeedbackReportId;
        if (outcome === "sent") {
          const meta = readJson<{ readonly excerpt?: string }>(
            NodePath.join(directory, "meta.json"),
            {},
          );
          writeSent([...readSent(), { id, sentAt: Date.now(), excerpt: meta.excerpt ?? "" }]);
          NodeFS.rmSync(directory, { recursive: true, force: true });
          return;
        }
        if (outcome === "rejected") {
          NodeFS.mkdirSync(NodePath.join(root, "rejected"), { recursive: true });
          NodeFS.renameSync(directory, NodePath.join(root, "rejected", id));
          return;
        }
        const metaFile = NodePath.join(directory, "meta.json");
        const meta = readJson<OutboxMeta & { readonly excerpt?: string }>(metaFile, {
          attempts: 0,
          nextAttemptAt: 0,
        });
        const attempts = meta.attempts + 1;
        writeFileAtomic(
          metaFile,
          JSON.stringify({ ...meta, attempts, nextAttemptAt: Date.now() + retryDelayMs(attempts) }),
        );
      });

    const pending = () => {
      let names: Array<string> = [];
      try {
        names = NodeFS.readdirSync(outbox).filter((name) => !name.startsWith("."));
      } catch {
        return [];
      }
      const now = Date.now();
      const entries: Array<{ readonly directory: string; readonly meta: OutboxMeta }> = [];
      for (const name of names) {
        const directory = NodePath.join(outbox, name);
        const meta = readJson<OutboxMeta>(NodePath.join(directory, "meta.json"), {
          attempts: 0,
          nextAttemptAt: 0,
        });
        if (now - (meta.createdAt ?? now) > OUTBOX_MAX_AGE_MS) {
          NodeFS.rmSync(directory, { recursive: true, force: true });
          continue;
        }
        entries.push({ directory, meta });
      }
      return entries;
    };

    /** Uploads every queued report that is due, or all of them when `everyone` is set. */
    const flush = (everyone: boolean) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (endpoint === null) return;
          const now = Date.now();
          for (const { directory, meta } of pending()) {
            if (!everyone && meta.nextAttemptAt > now) continue;
            yield* settle(directory, yield* upload(directory));
          }
        }),
      );

    const checkStatus = Effect.promise(async () => {
      if (endpoint === null) return;
      const cutoff = Date.now() - STATUS_MAX_AGE_MS;
      const ids = readSent()
        .filter((entry) => entry.sentAt >= cutoff && entry.noticeShown !== true)
        .map((entry) => entry.id);
      const { clientId, token } = identity();
      const fixed = new Map<string, { readonly fixedIn: string; readonly note: string | null }>();
      for (let start = 0; start < ids.length; start += FEEDBACK_STATUS_MAX_IDS) {
        const batch = ids.slice(start, start + FEEDBACK_STATUS_MAX_IDS);
        const response = await Electron.net.fetch(
          `${endpoint}/v1/reports/status?ids=${batch.join(",")}`,
          {
            headers: { authorization: `Bearer ${token}`, [FEEDBACK_CLIENT_ID_HEADER]: clientId },
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          },
        );
        if (!response.ok) break;
        for (const report of decodeStatus(await response.json()).reports) {
          if (report.status === "fixed" && report.fixedIn !== null) {
            fixed.set(report.id, { fixedIn: report.fixedIn, note: report.note });
          }
        }
      }
      if (fixed.size === 0) return;
      writeSent(
        readSent().map((entry) => {
          const status = fixed.get(entry.id);
          return status === undefined ? entry : { ...entry, ...status };
        }),
      );
    }).pipe(Effect.catchDefect(() => Effect.void));

    let wasOnline = true;
    yield* Effect.suspend(() => {
      const online = Electron.net.isOnline();
      const cameBack = online && !wasOnline;
      wasOnline = online;
      return online ? flush(cameBack) : Effect.void;
    }).pipe(
      Effect.catchDefect(() => Effect.void),
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.forkScoped,
    );
    yield* checkStatus.pipe(
      Effect.delay("30 seconds"),
      Effect.repeat(Schedule.spaced("6 hours")),
      Effect.forkScoped,
    );

    const writeOutbox = (request: FeedbackSubmitRequest) =>
      Effect.sync(() => {
        const id = NodeCrypto.randomUUID() as FeedbackReportId;
        const parts: Array<{
          readonly kind: FeedbackAttachmentKind;
          readonly bytes: Uint8Array;
        }> = [];
        const text = (value: string | null) =>
          value === null || value.length === 0 ? null : new TextEncoder().encode(value);
        const screenshot = request.screenshot;
        const logs = text(request.logs);
        const conversation = text(request.conversation);
        if (screenshot !== null) parts.push({ kind: "screenshot", bytes: screenshot });
        if (logs !== null) parts.push({ kind: "logs", bytes: logs });
        if (conversation !== null) parts.push({ kind: "conversation", bytes: conversation });
        const tooLarge = parts.find(
          (part) => part.bytes.length > FEEDBACK_ATTACHMENT_MAX_BYTES[part.kind],
        );
        if (tooLarge !== undefined) {
          return {
            _tag: "invalid",
            message: `The ${tooLarge.kind} is too large to send.`,
          } as const;
        }
        const email = request.contactEmail?.trim() ?? "";
        const report = {
          schemaVersion: 1 as const,
          id,
          createdAt: new Date().toISOString(),
          message: request.message,
          source: request.source,
          screen: request.screen,
          ...(email ? { contactEmail: email } : {}),
          app: request.details,
          ...(request.error === null ? {} : { error: request.error }),
          attachments: parts.map((part) => ({ kind: part.kind, bytes: part.bytes.length })),
        };
        let reportText: string;
        try {
          reportText = encodeReport(report);
        } catch {
          return { _tag: "invalid", message: "This report can't be sent as it is." } as const;
        }
        const queued = pending();
        if (queued.length >= OUTBOX_MAX_REPORTS) {
          return {
            _tag: "invalid",
            message: "Too many reports are waiting to be sent. Try again when you're online.",
          } as const;
        }
        const staging = NodePath.join(outbox, `.${id}`);
        NodeFS.mkdirSync(staging, { recursive: true, mode: 0o700 });
        NodeFS.writeFileSync(NodePath.join(staging, "report.json"), reportText, { mode: 0o600 });
        for (const part of parts) {
          NodeFS.writeFileSync(NodePath.join(staging, PART_FILES[part.kind]), part.bytes, {
            mode: 0o600,
          });
        }
        NodeFS.writeFileSync(
          NodePath.join(staging, "meta.json"),
          JSON.stringify({
            attempts: 0,
            nextAttemptAt: 0,
            createdAt: Date.now(),
            excerpt: excerpt(request.message, request.error?.message ?? "Problem report"),
          }),
          { mode: 0o600 },
        );
        NodeFS.renameSync(staging, NodePath.join(outbox, id));
        if (email) {
          try {
            writeFileAtomic(settingsFile, JSON.stringify({ lastContactEmail: email }));
          } catch {
            // Remembering the address is a convenience; the report is already saved.
          }
        }
        return { _tag: "saved", id, directory: NodePath.join(outbox, id) } as const;
      });

    const service = DesktopFeedback.of({
      prepare: Effect.sync(() => ({
        details: details(),
        lastContactEmail:
          readJson<{ readonly lastContactEmail?: string }>(settingsFile, {}).lastContactEmail ??
          null,
        canSend: endpoint !== null,
        pendingReports: pending().length,
      })),

      captureScreenshot: Effect.fn("DesktopFeedback.captureScreenshot")(function* (senderId) {
        return yield* Effect.promise(async () => {
          const contents = Electron.webContents.fromId(senderId);
          if (!contents || contents.isDestroyed()) return null;
          let image = await contents.capturePage();
          const { width, height } = image.getSize();
          if (width === 0 || height === 0) return null;
          const scale = Math.min(1, SCREENSHOT_LONG_EDGE / Math.max(width, height));
          if (scale < 1)
            image = image.resize({ width: Math.round(width * scale), quality: "best" });
          for (const quality of [85, 70, 55]) {
            const jpeg = image.toJPEG(quality);
            if (jpeg.length <= FEEDBACK_SCREENSHOT_MAX_BYTES) {
              const size = image.getSize();
              return { jpeg: new Uint8Array(jpeg), width: size.width, height: size.height };
            }
          }
          const smaller = image.resize({ width: Math.round(image.getSize().width / 2) });
          const jpeg = smaller.toJPEG(70);
          const size = smaller.getSize();
          return jpeg.length <= FEEDBACK_SCREENSHOT_MAX_BYTES
            ? { jpeg: new Uint8Array(jpeg), width: size.width, height: size.height }
            : null;
        }).pipe(Effect.catchDefect(() => Effect.succeed(null)));
      }),

      readRecentLogs: Effect.sync(() => {
        const since = Date.now() - DAY_MS;
        const crashes = rendererCrashesSince(rendererHistory(), since);
        const failures = traceFailuresSince(serverTrace(), since).slice(0, LOG_FAILURES);
        const serverLogFile = NodePath.join(environment.logDir, "server-child.log");
        const serverLog = modifiedWithin(serverLogFile, DAY_MS)
          ? tailLines(readTail(serverLogFile, SERVER_LOG_TAIL_BYTES * 2), SERVER_LOG_TAIL_BYTES)
          : "";
        const text = [
          `Scient ${environment.appVersion} logs, collected ${new Date().toISOString()}`,
          "",
          "== Window crashes in the last 24 hours ==",
          crashes.length === 0 ? "None." : crashes.join("\n"),
          "",
          "== Failed operations in the last 24 hours, newest first ==",
          failures.length === 0
            ? "None."
            : failures
                .map(
                  (failure) =>
                    `${new Date(failure.endedAtMs).toISOString()} ${failure.name} trace ${failure.traceId}\n  ${failure.cause.slice(0, LOG_CAUSE_CHARS).replaceAll("\n", "\n  ")}`,
                )
                .join("\n"),
          "",
          "== Server output saved after its last stop ==",
          serverLog.trim() || "None in the last 24 hours.",
          "",
        ].join("\n");
        return tailLines(
          redactLogText(text, environment.homeDirectory),
          FEEDBACK_ATTACHMENT_MAX_BYTES.logs,
        );
      }),

      submit: Effect.fn("DesktopFeedback.submit")(function* (request) {
        const saved = yield* writeOutbox(request).pipe(
          Effect.catchDefect(() =>
            Effect.succeed({
              _tag: "invalid",
              message: "Scient couldn't save the report on this computer.",
            } as const),
          ),
        );
        if (saved._tag === "invalid") {
          return { _tag: "failed", message: saved.message } satisfies FeedbackSubmitResult;
        }
        if (endpoint === null) return { _tag: "kept-locally", id: saved.id } as const;
        const outcome = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const result = yield* upload(saved.directory);
            yield* settle(saved.directory, result).pipe(Effect.catchDefect(() => Effect.void));
            return result;
          }),
        );
        if (outcome === "sent") return { _tag: "sent", id: saved.id } as const;
        if (outcome === "retry") return { _tag: "queued", id: saved.id } as const;
        return {
          _tag: "failed",
          message: "The Scient feedback service refused this report.",
        } as const;
      }),

      takeFixedNotices: Effect.sync(() => {
        const sent = readSent();
        const notices: Array<FeedbackFixedNotice> = [];
        const updated = sent.map((entry) => {
          if (
            entry.noticeShown === true ||
            entry.fixedIn === undefined ||
            !runsFixedVersion(environment.appVersion, entry.fixedIn)
          ) {
            return entry;
          }
          notices.push({
            id: entry.id,
            excerpt: entry.excerpt,
            fixedIn: entry.fixedIn,
            note: entry.note ?? null,
          });
          return { ...entry, noticeShown: true };
        });
        if (notices.length > 0) writeSent(updated);
        return notices;
      }).pipe(Effect.catchDefect(() => Effect.succeed([]))),
    });
    yield* installFeedbackIpc(service);
    return service;
  }),
);
