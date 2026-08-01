// Production CSS is part of the behavior under test because row height depends on it.
import "../index.css";

import {
  AutomationId,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EDIT_RESEND_PARENT_BUSY_ERROR_CLASS,
  type AutomationCreateInput,
  type AutomationDefinition,
  EventId,
  MessageId,
  type NativeApi,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
  type OrchestrationThreadActivity,
  type ProjectId,
  type ServerConfig,
  ThreadId,
  TurnId,
  type WsWelcomePayload,
  WS_METHODS,
  OrchestrationSessionStatus,
} from "@synara/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { WORKTREE_BRANCH_PREFIX } from "@synara/shared/git";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page, userEvent } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CURRENT_APP_SETTINGS_VERSION } from "../appSettings";
import { type ComposerImageAttachment, useComposerDraftStore } from "../composerDraftStore";
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getScrollContainerDistanceFromBottom,
} from "../chat-scroll";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
  removeInlineTerminalContextPlaceholder,
} from "../lib/terminalContext";
import { isMacPlatform } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useProviderConnectionDialogStore } from "../providerConnectionDialogStore";
import { resetHomeChatProjectPrewarmStateForTests } from "../lib/chatProjects";
import {
  draftNavigationSlotKey,
  runDraftNavigationOnce,
  waitForDraftNavigationIdle,
} from "../lib/stagedDraftNavigation";
import { resetStudioProjectPrewarmStateForTests } from "../lib/studioProjects";
import {
  finishProjectOperation,
  hasActiveProjectOperations,
  isProjectRemovalReserved,
  releaseProjectRemoval,
  reserveProjectRemoval,
  resetProjectRemovalCoordinationForTests,
  tryBeginProjectOperation,
} from "../lib/projectRemovalCoordination";
import { getSidechatCreator } from "../lib/sidechatCreatorRegistry";
import { newThreadNavigationRequestKey } from "../lib/threadBootstrap";
import { promoteThreadCreate } from "../lib/threadCreatePromotion";
import { splitViewPaneScopeId } from "../lib/chatPaneScope";
import { getRouter } from "../router";
import {
  resolveSplitViewPaneIdForThread,
  resolveSplitViewThreadIds,
  useSplitViewStore,
} from "../splitViewStore";
import { resetAppStoreForTests, useStore } from "../store";
import {
  createShellSnapshotFromReadModel,
  createTestEnvironmentDescriptor,
  flattenEffectRpcRequestPayload,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
} from "../test/effectRpcWebSocketMock";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useOptimisticUserMessageStore } from "../optimisticUserMessageStore";
import { useUserMessageEditDraftStore } from "../userMessageEditDraftStore";
import { transientAlertManager } from "../notifications/transientAlert";
import { useTerminalStateStore } from "../terminalStateStore";
import { resetRetainedThreadDetailSubscriptionsForTests } from "../threadDetailSubscriptionRetention";
import { resetWsNativeApiForTest } from "../wsNativeApi";
import { resetChatViewDispatchGatesForTests } from "./ChatView";
import { estimateTimelineMessageHeight } from "./timelineHeight";
import type { ChatMessage } from "../types";

const THREAD_ID = "thread-browser-test" as ThreadId;
const OTHER_THREAD_ID = "thread-browser-test-other" as ThreadId;
const THREAD_TITLE = "Browser test thread";
const UUID_ROUTE_RE = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID = "project-1" as ProjectId;
const OTHER_PROJECT_ID = "project-2" as ProjectId;
const HOME_PROJECT_ID = "project-home" as ProjectId;
const STUDIO_PROJECT_ID = "project-studio" as ProjectId;
const STUDIO_DRAFT_THREAD_ID = "thread-studio-draft" as ThreadId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='300'></svg>";
let attachmentResponseDelayMs = 0;

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
  gitBranchByCwd: Record<string, string>;
}

let fixture: TestFixture;
const wsRequests: WsRequestEnvelope["body"][] = [];
const wsLink = ws.link(/ws(s)?:\/\/.*/);

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
  textTolerancePx: number;
  attachmentTolerancePx: number;
}

const DEFAULT_VIEWPORT: ViewportSpec = {
  name: "desktop",
  width: 960,
  height: 1_100,
  textTolerancePx: 44,
  attachmentTolerancePx: 56,
};
const TEXT_VIEWPORT_MATRIX = [
  DEFAULT_VIEWPORT,
  { name: "tablet", width: 720, height: 1_024, textTolerancePx: 44, attachmentTolerancePx: 56 },
  { name: "mobile", width: 430, height: 932, textTolerancePx: 56, attachmentTolerancePx: 56 },
  { name: "narrow", width: 320, height: 700, textTolerancePx: 84, attachmentTolerancePx: 56 },
] as const satisfies readonly ViewportSpec[];
const ATTACHMENT_VIEWPORT_MATRIX = [
  DEFAULT_VIEWPORT,
  { name: "mobile", width: 430, height: 932, textTolerancePx: 56, attachmentTolerancePx: 56 },
  { name: "narrow", width: 320, height: 700, textTolerancePx: 84, attachmentTolerancePx: 56 },
] as const satisfies readonly ViewportSpec[];

interface UserRowMeasurement {
  measuredRowHeightPx: number;
  timelineWidthMeasuredPx: number;
  renderedInVirtualizedRegion: boolean;
}

interface MountedChatView {
  [Symbol.asyncDispose]: () => Promise<void>;
  cleanup: () => Promise<void>;
  measureLayout: () => Promise<ChatLayoutMeasurement>;
  measureUserRow: (targetMessageId: MessageId) => Promise<UserRowMeasurement>;
  setViewport: (viewport: ViewportSpec) => Promise<void>;
  router: ReturnType<typeof getRouter>;
}

interface ChatLayoutMeasurement {
  hostHeightPx: number;
  composerBottomPx: number;
  scrollClientHeightPx: number;
  scrollHeightPx: number;
  distanceFromBottomPx: number;
}

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createBaseServerConfig(): ServerConfig {
  return {
    cwd: "/repo/project",
    worktreesDir: "/repo/.codex/worktrees",
    keybindingsConfigPath: "/repo/project/.synara-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: NOW_ISO,
      },
    ],
    availableEditors: [],
  };
}

function createUserMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: options.id,
    role: "user" as const,
    text: options.text,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    turnId: null,
    streaming: false,
    source: "native" as const,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createAssistantMessage(options: { id: MessageId; text: string; offsetSeconds: number }) {
  return {
    id: options.id,
    role: "assistant" as const,
    text: options.text,
    turnId: null,
    streaming: false,
    source: "native" as const,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createTerminalContext(input: {
  id: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: THREAD_ID,
    terminalId: `terminal-${input.id}`,
    terminalLabel: input.terminalLabel,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    text: input.text,
    createdAt: NOW_ISO,
  };
}

function createComposerImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "queued-image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 8;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified: BASE_TIME_MS,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

function installFakeMicrophoneCapture(): {
  emitSamples: () => void;
  restore: () => void;
} {
  const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const audioContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const trackStop = vi.fn();
  const processor = {
    onaudioprocess: null as
      | ((event: {
          inputBuffer: {
            numberOfChannels: number;
            length: number;
            getChannelData: (channel: number) => Float32Array;
          };
        }) => void)
      | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const gain = {
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  class FakeAudioContext {
    readonly sampleRate = 48_000;
    readonly destination = {};

    resume = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    createMediaStreamSource = vi.fn(() => source);
    createScriptProcessor = vi.fn(() => processor);
    createGain = vi.fn(() => gain);
  }

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: trackStop }],
      })),
    },
  });
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });

  return {
    emitSamples: () => {
      const samples = new Float32Array(4_096).fill(0.25);
      processor.onaudioprocess?.({
        inputBuffer: {
          numberOfChannels: 1,
          length: samples.length,
          getChannelData: () => samples,
        },
      });
    },
    restore: () => {
      if (mediaDevicesDescriptor) {
        Object.defineProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "mediaDevices");
      }
      if (audioContextDescriptor) {
        Object.defineProperty(globalThis, "AudioContext", audioContextDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "AudioContext");
      }
    },
  };
}

function appendActiveThreadActivity(activity: OrchestrationThreadActivity): void {
  const snapshot: OrchestrationReadModel = {
    ...fixture.snapshot,
    snapshotSequence: fixture.snapshot.snapshotSequence + 1,
    threads: fixture.snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            activities: [...thread.activities, activity],
            updatedAt: activity.createdAt,
          }
        : thread,
    ),
    updatedAt: activity.createdAt,
  };
  fixture = { ...fixture, snapshot };
  useStore.getState().syncServerReadModel(snapshot);
}

function configureSuccessfulVoiceTranscription(transcript: string): (api: NativeApi) => NativeApi {
  return (api) => ({
    ...api,
    server: {
      ...api.server,
      transcribeVoice: vi.fn(async () => ({
        text: transcript,
        engine: "local" as const,
      })),
      cancelVoiceTranscription: vi.fn(async () => undefined),
    },
  });
}

function createSnapshotForTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachmentCount?: number;
  sessionStatus?: OrchestrationSessionStatus;
}): OrchestrationReadModel {
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];

  for (let index = 0; index < 22; index += 1) {
    const isTarget = index === 3;
    const userId = `msg-user-${index}` as MessageId;
    const assistantId = `msg-assistant-${index}` as MessageId;
    const attachments =
      isTarget && (options.targetAttachmentCount ?? 0) > 0
        ? Array.from({ length: options.targetAttachmentCount ?? 0 }, (_, attachmentIndex) => ({
            type: "image" as const,
            id: `attachment-${attachmentIndex + 1}`,
            name: `attachment-${attachmentIndex + 1}.png`,
            mimeType: "image/png",
            sizeBytes: 128,
          }))
        : undefined;

    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        ...(attachments ? { attachments } : {}),
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }

  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        kind: "project",
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: THREAD_TITLE,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: options.sessionStatus ?? "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function createSnapshotWithStoppedUnansweredPrompt(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-stopped-unanswered-filler" as MessageId,
    targetText: "earlier prompt",
  });
  const requestedAt = "2026-08-01T08:00:00.000Z";
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            messages: [
              ...thread.messages,
              {
                id: "msg-user-stopped-unanswered" as MessageId,
                role: "user" as const,
                text: "old stopped prompt",
                turnId: null,
                streaming: false,
                source: "native" as const,
                createdAt: requestedAt,
                updatedAt: requestedAt,
              },
            ],
            latestTurn: {
              turnId: "turn-stopped-unanswered" as TurnId,
              requestMessageId: "msg-user-stopped-unanswered" as MessageId,
              state: "interrupted" as const,
              requestedAt,
              startedAt: requestedAt,
              completedAt: "2026-08-01T08:00:01.000Z",
              assistantMessageId: null,
            },
            session: {
              ...thread.session!,
              status: "stopped" as const,
              activeTurnId: null,
              updatedAt: "2026-08-01T08:00:01.000Z",
            },
          }
        : thread,
    ),
  };
}

function createSnapshotWithLongAssistantResponse(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-assistant-overflow-target" as MessageId,
    targetText: "start",
  });

  const threads = [...snapshot.threads];
  const threadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
  if (threadIndex < 0) {
    return snapshot;
  }

  const thread = threads[threadIndex]!;
  const messages = [...thread.messages];
  const messageIndex = messages.findIndex(
    (message, index) => message.role === "assistant" && index === 7,
  );
  if (messageIndex < 0) {
    return snapshot;
  }

  const message = messages[messageIndex]!;
  messages[messageIndex] = {
    ...message,
    text: Array.from(
      { length: 240 },
      (_, lineIndex) =>
        `${lineIndex + 1}. keep the viewport stable while this response keeps growing`,
    ).join("\n"),
  };
  threads[threadIndex] = {
    ...thread,
    messages,
  };

  return {
    ...snapshot,
    threads,
  };
}

function createSnapshotWithBottomAttachments(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-bottom-attachments" as MessageId,
    targetText: "bottom attachments",
  });

  const threads = [...snapshot.threads];
  const threadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
  if (threadIndex < 0) {
    return snapshot;
  }

  const thread = threads[threadIndex]!;
  const messages = [...thread.messages];
  let lastUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserMessageIndex = index;
      break;
    }
  }
  if (lastUserMessageIndex < 0) {
    return snapshot;
  }

  const lastUserMessage = messages[lastUserMessageIndex]!;
  messages[lastUserMessageIndex] = {
    ...lastUserMessage,
    text: "final user message with delayed attachments",
    attachments: Array.from({ length: 3 }, (_, attachmentIndex) => ({
      type: "image" as const,
      id: `bottom-attachment-${attachmentIndex + 1}`,
      name: `bottom-attachment-${attachmentIndex + 1}.png`,
      mimeType: "image/png",
      sizeBytes: 128,
    })),
  };
  threads[threadIndex] = {
    ...thread,
    messages,
  };

  return {
    ...snapshot,
    threads,
  };
}

function buildFixture(snapshot: OrchestrationReadModel): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    gitBranchByCwd: {},
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function getThreadDetailFromFixtureSnapshot(
  threadId: ThreadId,
): OrchestrationReadModel["threads"][number] {
  const thread = fixture.snapshot.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    throw new Error(`Missing thread fixture for ${threadId}`);
  }
  return thread;
}

function findThreadDetailFromFixtureSnapshot(
  threadId: ThreadId,
): OrchestrationReadModel["threads"][number] | null {
  return fixture.snapshot.threads.find((entry) => entry.id === threadId) ?? null;
}

function addThreadToSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: [
      ...snapshot.threads,
      {
        id: threadId,
        projectId: PROJECT_ID,
        title: "New thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}

function createAutomationDefinitionFromCreateRequest(
  body: WsRequestEnvelope["body"],
): AutomationDefinition {
  const input = body as unknown as AutomationCreateInput;
  const definition: AutomationDefinition = {
    id: AutomationId.makeUnsafe(`automation-${wsRequests.length}`),
    projectId: input.projectId,
    sourceThreadId: input.sourceThreadId ?? null,
    name: input.name,
    prompt: input.prompt,
    schedule: input.schedule,
    enabled: input.enabled ?? true,
    nextRunAt: null,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode ?? "approval-required",
    interactionMode: input.interactionMode ?? "default",
    worktreeMode: input.worktreeMode ?? "auto",
    mode: input.mode ?? "standalone",
    targetThreadId: input.targetThreadId ?? null,
    maxIterations: input.maxIterations ?? null,
    stopOnError: input.stopOnError ?? true,
    completionPolicy: input.completionPolicy ?? { type: "none" },
    completionPolicyVersion: 1,
    completionPolicyUpdatedAt: NOW_ISO,
    minimumIntervalSeconds: input.minimumIntervalSeconds ?? 60,
    maxRuntimeSeconds: input.maxRuntimeSeconds ?? 3_600,
    retryPolicy: input.retryPolicy ?? { type: "none" },
    misfirePolicy: input.misfirePolicy ?? "coalesce",
    acknowledgedRisks: input.acknowledgedRisks ?? [],
    iterationCount: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    archivedAt: null,
  };
  return input.providerOptions === undefined
    ? definition
    : { ...definition, providerOptions: input.providerOptions };
}

function createDraftOnlySnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-draft-target" as MessageId,
    targetText: "draft thread",
  });
  return {
    ...snapshot,
    threads: [],
  };
}

function withOpenProjectPickerFixtures(
  snapshot: OrchestrationReadModel,
  otherProjectTitle = "Other Project",
): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: OTHER_PROJECT_ID,
        kind: "project",
        title: otherProjectTitle,
        workspaceRoot: "/repo/other",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

function withHomeChatProject(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: HOME_PROJECT_ID,
        kind: "chat",
        title: "Home",
        workspaceRoot: "/Users/tester",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

function withStudioProject(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: STUDIO_PROJECT_ID,
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/Users/tester/Documents/Synara/Studio",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

function withProjectScripts(
  snapshot: OrchestrationReadModel,
  scripts: OrchestrationReadModel["projects"][number]["scripts"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, scripts: Array.from(scripts) } : project,
    ),
  };
}

function createSnapshotWithLongProposedPlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-target" as MessageId,
    targetText: "plan thread",
  });
  const planMarkdown = [
    "# Ship plan mode follow-up",
    "",
    "- Step 1: capture the thread-open trace",
    "- Step 2: identify the main-thread bottleneck",
    "- Step 3: keep collapsed cards cheap",
    "- Step 4: render the full markdown only on demand",
    "- Step 5: preserve export and save actions",
    "- Step 6: add regression coverage",
    "- Step 7: verify route transitions stay responsive",
    "- Step 8: confirm no server-side work changed",
    "- Step 9: confirm short plans still render normally",
    "- Step 10: confirm long plans stay collapsed by default",
    "- Step 11: confirm preview text is still useful",
    "- Step 12: confirm plan follow-up flow still works",
    "- Step 13: confirm timeline virtualization still behaves",
    "- Step 14: confirm theme styling still looks correct",
    "- Step 15: confirm save dialog behavior is unchanged",
    "- Step 16: confirm download behavior is unchanged",
    "- Step 17: confirm code fences do not parse until expand",
    "- Step 18: confirm preview truncation ends cleanly",
    "- Step 19: confirm markdown links still open in editor after expand",
    "- Step 20: confirm deep hidden detail only appears after expand",
    "",
    "```ts",
    "export const hiddenPlanImplementationDetail = 'deep hidden detail only after expand';",
    "```",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            proposedPlans: [
              {
                id: "plan-browser-test",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_000),
                updatedAt: isoAt(1_001),
              },
            ],
            updatedAt: isoAt(1_001),
          })
        : thread,
    ),
  };
}

function createSnapshotWithActiveInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-inline-plan-target" as MessageId,
    targetText: "inline plan thread",
    sessionStatus: "running",
  });
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: "running",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: null,
              assistantMessageId: null,
            },
            activities: [
              {
                id: EventId.makeUnsafe("activity-inline-plan"),
                createdAt: isoAt(1_002),
                kind: "turn.tasks.updated",
                summary: "Tasks updated",
                tone: "info",
                turnId: activeTurnId,
                payload: {
                  tasks: [
                    {
                      task: "Inspecting ChatView boundaries",
                      status: "inProgress",
                    },
                    {
                      task: "Patch the shared checklist receiver",
                      status: "pending",
                    },
                    {
                      task: "Run final validation",
                      status: "completed",
                    },
                  ],
                },
              },
              {
                id: EventId.makeUnsafe("activity-inline-background-task"),
                createdAt: isoAt(1_003),
                kind: "task.started",
                summary: "Background agent started",
                tone: "info",
                turnId: activeTurnId,
                payload: {
                  taskId: "task-inline-background-agent",
                  taskType: "subagent",
                },
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "running",
                  activeTurnId,
                  updatedAt: isoAt(1_003),
                }
              : null,
            updatedAt: isoAt(1_003),
          }
        : thread,
    ),
  };
}

function createSnapshotWithSettledInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotWithActiveInlinePlan();
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: "completed",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: isoAt(1_004),
              assistantMessageId: MessageId.makeUnsafe("msg-assistant-inline-plan-complete"),
            },
            messages: [
              ...thread.messages,
              {
                turnId: activeTurnId,
                id: MessageId.makeUnsafe("msg-assistant-inline-plan-complete"),
                role: "assistant",
                text: "Finished the investigation.",
                createdAt: isoAt(1_004),
                updatedAt: isoAt(1_004),
                completedAt: isoAt(1_004),
                streaming: false,
                source: "native",
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "ready",
                  activeTurnId: null,
                  updatedAt: isoAt(1_004),
                }
              : null,
            updatedAt: isoAt(1_004),
          }
        : thread,
    ),
  };
}

function createSnapshotWithSettledCompletedInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotWithSettledInlinePlan();

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            activities: thread.activities.map((activity) =>
              activity.kind === "turn.tasks.updated"
                ? {
                    ...activity,
                    payload: {
                      tasks: [
                        { task: "Inspecting ChatView boundaries", status: "completed" },
                        { task: "Patch the shared checklist receiver", status: "completed" },
                        { task: "Run final validation", status: "completed" },
                      ],
                    },
                  }
                : activity,
            ),
          }
        : thread,
    ),
  };
}

// A plan-mode thread whose latest turn has settled and that still has an
// actionable (unimplemented) proposed plan. This is exactly the state where the
// live composer shows the plan-follow-up prompt, so it's the setup that used to
// misroute an auto-dispatched queued *chat* turn into the plan-follow-up path.
function createSnapshotWithSettledPlanAwaitingFollowUp(): OrchestrationReadModel {
  const snapshot = createSnapshotWithSettledInlinePlan();
  const planMarkdown = [
    "# Proposed plan",
    "",
    "- Step 1: capture the failing state",
    "- Step 2: apply the fix",
    "- Step 3: add regression coverage",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            interactionMode: "plan",
            hasActionableProposedPlan: true,
            proposedPlans: [
              {
                id: "plan-awaiting-follow-up",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_005),
                updatedAt: isoAt(1_005),
              },
            ],
            updatedAt: isoAt(1_005),
          }
        : thread,
    ),
  };
}

function createSnapshotWithInlineToolOverflow(options: {
  active: boolean;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-inline-tools-target" as MessageId,
    targetText: "inline tools thread",
    sessionStatus: options.active ? "running" : "ready",
  });
  const activeTurnId = TurnId.makeUnsafe("turn-inline-tools");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: options.active ? "running" : "completed",
              requestedAt: isoAt(1_100),
              startedAt: isoAt(1_101),
              completedAt: options.active ? null : isoAt(1_108),
              assistantMessageId: MessageId.makeUnsafe("msg-assistant-inline-tools"),
            },
            activities: Array.from({ length: 6 }, (_, index) => ({
              id: EventId.makeUnsafe(`activity-inline-tool-${index + 1}`),
              createdAt: isoAt(1_102 + index),
              kind: "tool.completed" as const,
              summary: `tool ${index + 1}`,
              tone: "tool" as const,
              turnId: activeTurnId,
              payload: {
                itemType: "dynamic_tool_call",
                toolName: `tool-${index + 1}`,
              },
            })),
            messages: [
              ...thread.messages,
              {
                turnId: activeTurnId,
                id: MessageId.makeUnsafe("msg-assistant-inline-tools"),
                role: "assistant",
                text: "Wrapped up the inline tool review.",
                createdAt: isoAt(1_109),
                updatedAt: isoAt(1_109),
                completedAt: options.active ? undefined : isoAt(1_109),
                streaming: false,
                source: "native",
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: options.active ? "running" : "ready",
                  activeTurnId: options.active ? activeTurnId : null,
                  updatedAt: options.active ? isoAt(1_107) : isoAt(1_108),
                }
              : null,
            updatedAt: options.active ? isoAt(1_107) : isoAt(1_109),
          }
        : thread,
    ),
  };
}

function recordProjectCreateCommand(command: unknown): boolean {
  if (
    !command ||
    typeof command !== "object" ||
    !("type" in command) ||
    command.type !== "project.create" ||
    !("projectId" in command) ||
    !("workspaceRoot" in command) ||
    !("title" in command)
  ) {
    return false;
  }

  const projectId = command.projectId as ProjectId;
  fixture = {
    ...fixture,
    snapshot: {
      ...fixture.snapshot,
      snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      projects: [
        ...fixture.snapshot.projects.filter((project) => project.id !== projectId),
        {
          id: projectId,
          kind:
            "kind" in command && (command.kind === "chat" || command.kind === "studio")
              ? command.kind
              : "project",
          title: String(command.title),
          workspaceRoot: String(command.workspaceRoot),
          defaultModelSelection:
            "defaultModelSelection" in command &&
            command.defaultModelSelection &&
            typeof command.defaultModelSelection === "object"
              ? (command.defaultModelSelection as OrchestrationReadModel["projects"][number]["defaultModelSelection"])
              : {
                  provider: "codex" as const,
                  model: "gpt-5",
                },
          scripts: [],
          createdAt:
            "createdAt" in command && typeof command.createdAt === "string"
              ? command.createdAt
              : NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
      ],
      updatedAt: NOW_ISO,
    },
  };
  return true;
}

function recordThreadForkCreateCommand(command: unknown): boolean {
  if (
    !command ||
    typeof command !== "object" ||
    !("type" in command) ||
    command.type !== "thread.fork.create" ||
    !("threadId" in command) ||
    !("sourceThreadId" in command) ||
    !("importedMessages" in command) ||
    !Array.isArray(command.importedMessages)
  ) {
    return false;
  }

  const sourceThread = fixture.snapshot.threads.find(
    (thread) => thread.id === command.sourceThreadId,
  );
  if (!sourceThread) {
    return false;
  }

  const createdAt =
    "createdAt" in command && typeof command.createdAt === "string" ? command.createdAt : NOW_ISO;
  const importedMessages = command.importedMessages.map((message) => {
    const imported = message as {
      messageId: MessageId;
      role: "user" | "assistant";
      text: string;
      attachments?: OrchestrationReadModel["threads"][number]["messages"][number]["attachments"];
      createdAt: string;
      updatedAt: string;
    };
    return {
      id: imported.messageId,
      role: imported.role,
      text: imported.text,
      ...(imported.attachments ? { attachments: imported.attachments } : {}),
      turnId: null,
      streaming: false,
      source: "fork-import" as const,
      createdAt: imported.createdAt,
      updatedAt: imported.updatedAt,
    };
  });
  const forkedThread: OrchestrationReadModel["threads"][number] = {
    ...sourceThread,
    id: command.threadId as ThreadId,
    title: `${sourceThread.title} (2)`,
    modelSelection:
      "modelSelection" in command &&
      command.modelSelection &&
      typeof command.modelSelection === "object"
        ? (command.modelSelection as typeof sourceThread.modelSelection)
        : sourceThread.modelSelection,
    runtimeMode:
      "runtimeMode" in command &&
      (command.runtimeMode === "approval-required" || command.runtimeMode === "full-access")
        ? command.runtimeMode
        : sourceThread.runtimeMode,
    interactionMode:
      "interactionMode" in command &&
      (command.interactionMode === "default" || command.interactionMode === "plan")
        ? command.interactionMode
        : sourceThread.interactionMode,
    envMode:
      "envMode" in command && (command.envMode === "local" || command.envMode === "worktree")
        ? command.envMode
        : sourceThread.envMode,
    branch: "branch" in command && typeof command.branch === "string" ? command.branch : null,
    worktreePath:
      "worktreePath" in command && typeof command.worktreePath === "string"
        ? command.worktreePath
        : null,
    associatedWorktreePath:
      "associatedWorktreePath" in command && typeof command.associatedWorktreePath === "string"
        ? command.associatedWorktreePath
        : null,
    associatedWorktreeBranch:
      "associatedWorktreeBranch" in command && typeof command.associatedWorktreeBranch === "string"
        ? command.associatedWorktreeBranch
        : null,
    associatedWorktreeRef:
      "associatedWorktreeRef" in command && typeof command.associatedWorktreeRef === "string"
        ? command.associatedWorktreeRef
        : null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: sourceThread.id,
    forkSourceMessageId:
      "sourceMessageId" in command && typeof command.sourceMessageId === "string"
        ? MessageId.makeUnsafe(command.sourceMessageId)
        : null,
    forkTitleBase: sourceThread.title,
    forkTitleOrdinal: 2,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    latestTurn: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    deletedAt: null,
    handoff: null,
    messages: importedMessages,
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
  };

  fixture = {
    ...fixture,
    snapshot: {
      ...fixture.snapshot,
      snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      threads: [
        ...fixture.snapshot.threads.filter((thread) => thread.id !== forkedThread.id),
        forkedThread,
      ],
      updatedAt: createdAt,
    },
  };
  return true;
}

function findRecordedThreadForkCreateCommand(): Record<string, unknown> | null {
  const request = wsRequests.find(
    (entry) =>
      entry._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
      typeof entry.command === "object" &&
      entry.command !== null &&
      "type" in entry.command &&
      entry.command.type === "thread.fork.create",
  );
  return (request?.command as Record<string, unknown> | undefined) ?? null;
}

function resolveWsRpc(body: WsRequestEnvelope["body"]): unknown {
  const tag = body._tag;
  if (tag === ORCHESTRATION_WS_METHODS.getShellSnapshot) {
    return createShellSnapshotFromReadModel(fixture.snapshot);
  }
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    if (recordProjectCreateCommand(body.command)) {
      return { sequence: fixture.snapshot.snapshotSequence };
    }
    if (recordThreadForkCreateCommand(body.command)) {
      return { sequence: fixture.snapshot.snapshotSequence };
    }
    return { sequence: fixture.snapshot.snapshotSequence + 1 };
  }
  if (tag === WS_METHODS.automationCreate) {
    return createAutomationDefinitionFromCreateRequest(body);
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.serverGetEnvironment) {
    return createTestEnvironmentDescriptor();
  }
  if (tag === WS_METHODS.gitListBranches) {
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const branchName = cwd ? (fixture.gitBranchByCwd[cwd] ?? "main") : "main";
    return {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: branchName,
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const branchName = cwd ? (fixture.gitBranchByCwd[cwd] ?? "main") : "main";
    return {
      branch: branchName,
      hasWorkingTreeChanges: false,
      workingTree: {
        files: [],
        insertions: 0,
        deletions: 0,
      },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.gitCreateWorktree) {
    const requestedBranch =
      typeof body.newBranch === "string"
        ? body.newBranch
        : typeof body.branch === "string"
          ? body.branch
          : "main";
    return {
      worktree: {
        path: `/repo/.codex/worktrees/project/${requestedBranch.replaceAll("/", "-")}`,
        branch: requestedBranch,
      },
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  if (tag === WS_METHODS.terminalOpen) {
    return {
      threadId: typeof body.threadId === "string" ? body.threadId : THREAD_ID,
      terminalId: typeof body.terminalId === "string" ? body.terminalId : "default",
      cwd: typeof body.cwd === "string" ? body.cwd : "/repo/project",
      status: "running",
      pid: 123,
      history: "",
      outputEpoch: "epoch-1",
      outputSequence: 0,
      exitCode: null,
      exitSignal: null,
      updatedAt: NOW_ISO,
    };
  }
  if (tag === WS_METHODS.shellOpenInEditor || tag === WS_METHODS.terminalWrite) {
    return null;
  }
  return {};
}

function installDeterministicActionNativeApi(
  configure?: (api: NativeApi) => NativeApi,
): () => void {
  const previousNativeApi = window.nativeApi;
  const wsNativeApi = readNativeApi();
  if (!wsNativeApi) {
    throw new Error("Expected browser native API fixture.");
  }

  const deterministicApi: NativeApi = {
    ...wsNativeApi,
    shell: {
      ...wsNativeApi.shell,
      openInEditor: async (
        cwd: Parameters<typeof wsNativeApi.shell.openInEditor>[0],
        editor: Parameters<typeof wsNativeApi.shell.openInEditor>[1],
      ) => {
        wsRequests.push({
          _tag: WS_METHODS.shellOpenInEditor,
          cwd,
          editor,
        });
      },
    },
    git: {
      ...wsNativeApi.git,
      createWorktree: async (input: Parameters<typeof wsNativeApi.git.createWorktree>[0]) => {
        const request: WsRequestEnvelope["body"] = {
          _tag: WS_METHODS.gitCreateWorktree,
          ...input,
        };
        wsRequests.push(request);
        return resolveWsRpc(request) as Awaited<ReturnType<typeof wsNativeApi.git.createWorktree>>;
      },
    },
    terminal: {
      ...wsNativeApi.terminal,
      open: async (input: Parameters<typeof wsNativeApi.terminal.open>[0]) => {
        const request: WsRequestEnvelope["body"] = {
          _tag: WS_METHODS.terminalOpen,
          ...input,
        };
        wsRequests.push(request);
        return resolveWsRpc(request) as Awaited<ReturnType<typeof wsNativeApi.terminal.open>>;
      },
      write: async (input: Parameters<typeof wsNativeApi.terminal.write>[0]) => {
        wsRequests.push({
          _tag: WS_METHODS.terminalWrite,
          ...input,
        });
      },
    },
    orchestration: {
      ...wsNativeApi.orchestration,
      dispatchCommand: async (
        command: Parameters<typeof wsNativeApi.orchestration.dispatchCommand>[0],
      ) => {
        wsRequests.push({
          _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
          command,
        });
        const recordedFork = recordThreadForkCreateCommand(command);
        return {
          sequence: recordedFork
            ? fixture.snapshot.snapshotSequence
            : fixture.snapshot.snapshotSequence + 1,
        };
      },
    },
    automation: {
      ...wsNativeApi.automation,
      create: async (input: Parameters<typeof wsNativeApi.automation.create>[0]) => {
        const request: WsRequestEnvelope["body"] = {
          _tag: WS_METHODS.automationCreate,
          ...input,
        };
        wsRequests.push(request);
        return resolveWsRpc(request) as Awaited<ReturnType<typeof wsNativeApi.automation.create>>;
      },
    },
  };

  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: configure ? configure(deterministicApi) : deterministicApi,
  });

  return () => {
    if (previousNativeApi) {
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: previousNativeApi,
      });
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
  };
}

function toRecordedWsRequestBody(request: {
  readonly tag: string;
  readonly payload: unknown;
}): WsRequestEnvelope["body"] {
  if (request.tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    return {
      _tag: request.tag,
      command: request.payload,
    };
  }
  return flattenEffectRpcRequestPayload(request.tag, request.payload);
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      const parsed = readEffectRpcClientMessage(client, rawData);
      if (parsed.kind !== "request") return;

      const requestBody = toRecordedWsRequestBody(parsed.request);
      const method = requestBody._tag;
      wsRequests.push(requestBody);

      if (method === WS_METHODS.subscribeServerLifecycle) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "welcome",
          payload: fixture.welcome,
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerConfig) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "snapshot",
          config: fixture.serverConfig,
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: createShellSnapshotFromReadModel(fixture.snapshot),
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread && "threadId" in requestBody) {
        const threadId = requestBody.threadId as ThreadId;
        const thread = findThreadDetailFromFixtureSnapshot(threadId);
        if (!thread) {
          return;
        }
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: fixture.snapshot.snapshotSequence,
            thread,
          },
        });
        return;
      }
      if (
        method === WS_METHODS.subscribeServerProviderStatuses ||
        method === WS_METHODS.subscribeServerSettings ||
        method === WS_METHODS.subscribeTerminalEvents ||
        method === WS_METHODS.subscribeOrchestrationDomainEvents ||
        method === WS_METHODS.subscribeProjectDevServerEvents ||
        method === WS_METHODS.subscribeAutomationEvents
      ) {
        // Keep unasserted streaming subscriptions open. Completing them with a
        // unary `{}` response is a protocol error and correctly triggers the
        // connection supervisor's recovery path.
        return;
      }
      sendEffectRpcExit(client, parsed.request.id, resolveWsRpc(requestBody));
    });
  }),
  http.get("*/attachments/:attachmentId", async () => {
    if (attachmentResponseDelayMs > 0) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(() => resolve(), attachmentResponseDelayMs);
      });
    }
    return HttpResponse.text(ATTACHMENT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    });
  }),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

function suppressExpectedRuntimeDisposal(event: PromiseRejectionEvent): void {
  // This file deliberately replaces the browser API singleton between mounted
  // app roots. Effect reports cancellation of the old test-only runtime as an
  // unhandled defect even though WsTransport.dispose handles its promises.
  if (event.reason === "ManagedRuntime disposed") event.preventDefault();
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function setViewport(viewport: ViewportSpec): Promise<void> {
  await page.viewport(viewport.width, viewport.height);
  await waitForLayout();
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );
}

async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
  timeout = 8_000,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    {
      timeout,
      interval: 16,
    },
  );
  if (!element) {
    throw new Error(errorMessage);
  }
  return element;
}

async function waitForURL(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = "";
  await vi.waitFor(
    () => {
      pathname = router.state.location.pathname;
      expect(predicate(pathname), errorMessage).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  return pathname;
}

async function waitForComposerEditor(timeout = 8_000): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[contenteditable="true"]'),
    "Unable to find composer editor.",
    timeout,
  );
}

async function waitForSendButton(): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    "Unable to find send button.",
  );
}

function readDispatchedCommand(request: WsRequestEnvelope["body"]): Record<string, unknown> | null {
  if (
    request._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand ||
    typeof request.command !== "object" ||
    request.command === null
  ) {
    return null;
  }
  return request.command as Record<string, unknown>;
}

function hasDispatchedCommandType(type: string): boolean {
  return wsRequests.some((request) => readDispatchedCommand(request)?.type === type);
}

async function waitForEnvironmentModeButton(label: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === label,
      ) ?? null,
    `Unable to find ${label} environment button.`,
  );
}

async function clickProjectRemoveAction(projectName = "Project"): Promise<void> {
  const projectButton = await waitForElement(
    () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === projectName,
      ) ?? null,
    `Unable to find the ${projectName} sidebar row.`,
  );
  projectButton.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 24,
    }),
  );
  const removeItem = await waitForElement(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        (item) => item.textContent?.trim() === "Remove",
      ) ?? null,
    "Unable to find the Remove project action.",
  );
  removeItem.click();
}

async function waitForServerConfigToApply(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(wsRequests.some((request) => request._tag === WS_METHODS.serverGetConfig)).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  await waitForLayout();
}

function dispatchComposerPickerShortcut(target: EventTarget, key: "m" | "e"): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function dispatchModelCycleShortcut(target: EventTarget, key: "[" | "]"): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key === "]" ? "BracketRight" : "BracketLeft",
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

async function dispatchModelCycleShortcutWhenReady(
  target: EventTarget,
  key: "[" | "]",
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(dispatchModelCycleShortcut(target, key).defaultPrevented).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

function dispatchConfiguredShortcut(
  target: EventTarget,
  input: { key: string; shiftKey?: boolean; altKey?: boolean },
): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: input.key,
      shiftKey: input.shiftKey ?? false,
      altKey: input.altKey ?? false,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function dispatchComposerFocusToggleShortcut(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "l",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

// The composer model/effort shortcuts both drop into the same combined picker,
// rendered as a Base UI menu popup. Provider and effort detail live in lazily
// mounted submenus, so the reliable signal that the surface opened is the popup
// mounting with the active model label (the fixture pins the thread to gpt-5).
async function waitForComposerPickerSurfaceOpen(): Promise<void> {
  await vi.waitFor(() => {
    const popup = document.querySelector('[data-slot="menu-popup"]');
    expect(popup).not.toBeNull();
    expect(popup?.textContent ?? "").toContain("GPT-5");
  });
}

async function dispatchChatNewShortcut(): Promise<void> {
  await dispatchThreadShortcut("o");
}

async function dispatchTerminalThreadShortcut(): Promise<void> {
  await dispatchThreadShortcut("t");
}

async function dispatchThreadShortcut(key: string): Promise<void> {
  const useMetaForMod = isMacPlatform(navigator.platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
  await waitForLayout();
}

async function triggerChatNewShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  return triggerThreadShortcutUntilPath(router, dispatchChatNewShortcut, predicate, errorMessage);
}

async function triggerTerminalThreadShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  return triggerThreadShortcutUntilPath(
    router,
    dispatchTerminalThreadShortcut,
    predicate,
    errorMessage,
  );
}

async function triggerThreadShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  dispatchShortcut: () => Promise<void>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  await dispatchShortcut();
  return waitForURL(router, predicate, errorMessage);
}

async function waitForNewThreadShortcutLabel(): Promise<void> {
  const newThreadButton = page.getByTestId("new-thread-button");
  await expect.element(newThreadButton).toBeInTheDocument();
  await waitForLayout();
}

async function waitForImagesToLoad(scope: ParentNode): Promise<void> {
  const images = Array.from(scope.querySelectorAll("img"));
  if (images.length === 0) {
    return;
  }
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await waitForLayout();
}

async function measureUserRow(options: {
  host: HTMLElement;
  targetMessageId: MessageId;
}): Promise<UserRowMeasurement> {
  const { host, targetMessageId } = options;
  const rowSelector = `[data-message-id="${targetMessageId}"][data-message-role="user"]`;

  const scrollContainer = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
    "Unable to find ChatView message scroll container.",
    20_000,
  );

  let row: HTMLElement | null = null;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      row = host.querySelector<HTMLElement>(rowSelector);
      expect(row, "Unable to locate targeted user message row.").toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );

  await waitForImagesToLoad(row!);
  scrollContainer.scrollTop = 0;
  scrollContainer.dispatchEvent(new Event("scroll"));
  await nextFrame();

  let timelineWidthMeasuredPx = 0;
  let measuredRowHeightPx = 0;
  let renderedInVirtualizedRegion = false;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await nextFrame();
      const measuredRow = host.querySelector<HTMLElement>(rowSelector);
      expect(measuredRow, "Unable to measure targeted user row height.").toBeTruthy();
      timelineWidthMeasuredPx = measuredRow!.getBoundingClientRect().width;
      measuredRowHeightPx = measuredRow!.getBoundingClientRect().height;
      renderedInVirtualizedRegion = measuredRow!.closest("[data-index]") instanceof HTMLElement;
      expect(timelineWidthMeasuredPx, "Unable to measure timeline width.").toBeGreaterThan(0);
      expect(measuredRowHeightPx, "Unable to measure targeted user row height.").toBeGreaterThan(0);
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );

  return { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion };
}

async function measureChatLayout(host: HTMLElement): Promise<ChatLayoutMeasurement> {
  const scrollContainer = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
    "Unable to find ChatView message scroll container.",
  );
  const composerForm = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-composer-form='true']"),
    "Unable to find chat composer form.",
  );

  await waitForLayout();

  const hostHeightPx = host.getBoundingClientRect().height;
  const composerBottomPx = composerForm.getBoundingClientRect().bottom;
  return {
    hostHeightPx,
    composerBottomPx,
    scrollClientHeightPx: scrollContainer.clientHeight,
    scrollHeightPx: scrollContainer.scrollHeight,
    distanceFromBottomPx: getScrollContainerDistanceFromBottom(scrollContainer),
  };
}

async function mountChatView(options: {
  viewport: ViewportSpec;
  snapshot: OrchestrationReadModel;
  configureFixture?: (fixture: TestFixture) => void;
  configureNativeApi?: (api: NativeApi) => NativeApi;
  initialEntry?: string;
}): Promise<MountedChatView> {
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  // ChatView browser tests exercise UI behavior, while EventRouter owns the
  // transport-level contract. Record mutating native actions synchronously so
  // a slow Linux WebSocket round trip cannot outlive unmount and dispose the
  // next test's Effect runtime.
  const restoreNativeApi = installDeterministicActionNativeApi(options.configureNativeApi);
  await setViewport(options.viewport);
  await waitForProductionStyles();

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const router = getRouter(
    createMemoryHistory({
      initialEntries: [options.initialEntry ?? `/${THREAD_ID}`],
    }),
  );

  const screen = await render(<RouterProvider router={router} />, {
    container: host,
  });

  await waitForLayout();

  const cleanup = async () => {
    await screen.unmount();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
    restoreNativeApi();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    measureLayout: async () => measureChatLayout(host),
    measureUserRow: async (targetMessageId: MessageId) => measureUserRow({ host, targetMessageId }),
    setViewport: async (viewport: ViewportSpec) => {
      await setViewport(viewport);
      await waitForProductionStyles();
    },
    router,
  };
}

async function measureUserRowAtViewport(options: {
  snapshot: OrchestrationReadModel;
  targetMessageId: MessageId;
  viewport: ViewportSpec;
}): Promise<UserRowMeasurement> {
  const mounted = await mountChatView({
    viewport: options.viewport,
    snapshot: options.snapshot,
  });

  try {
    return await mounted.measureUserRow(options.targetMessageId);
  } finally {
    await mounted.cleanup();
  }
}

describe("ChatView timeline estimator parity (full app)", () => {
  beforeAll(async () => {
    window.addEventListener("unhandledrejection", suppressExpectedRuntimeDisposal);
    fixture = buildFixture(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap" as MessageId,
        targetText: "bootstrap",
      }),
    );
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await worker.stop();
    window.removeEventListener("unhandledrejection", suppressExpectedRuntimeDisposal);
  });

  beforeEach(async () => {
    resetWsNativeApiForTest();
    resetRetainedThreadDetailSubscriptionsForTests();
    await resetHomeChatProjectPrewarmStateForTests();
    await resetStudioProjectPrewarmStateForTests();
    resetProjectRemovalCoordinationForTests();
    resetChatViewDispatchGatesForTests();
    await setViewport(DEFAULT_VIEWPORT);
    attachmentResponseDelayMs = 0;
    localStorage.clear();
    document.body.innerHTML = "";
    wsRequests.length = 0;
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    // Full reset (not just `projects`/`threads`): tests that dispatch a real `project.delete`
    // tombstone ids in `deletedProjectIdsById` and seed the normalized projection
    // (`threadIds`/`threadShellById`); leaving those behind makes the next test's project route
    // resolve to "deleted" so its thread data never loads.
    resetAppStoreForTests();
    useTemporaryThreadStore.setState({
      temporaryThreadIds: {},
    });
    useOptimisticUserMessageStore.getState().clearAll();
    useUserMessageEditDraftStore.getState().clearAll();
    useTerminalStateStore.setState({
      terminalStateByThreadId: {},
    });
    useSplitViewStore.setState({
      splitViewsById: {},
      splitViewIdBySourceThreadId: {},
    });
  });

  afterEach(async () => {
    useOptimisticUserMessageStore.getState().clearAll();
    useUserMessageEditDraftStore.getState().clearAll();
    await resetHomeChatProjectPrewarmStateForTests();
    await resetStudioProjectPrewarmStateForTests();
    resetRetainedThreadDetailSubscriptionsForTests();
    resetProjectRemovalCoordinationForTests();
    resetChatViewDispatchGatesForTests();
    resetWsNativeApiForTest();
    document.body.innerHTML = "";
  });

  it("keeps unavailable provider setup out of an empty chat until the user tries to send", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-empty-provider-health" as MessageId,
      targetText: "This message is removed to create an empty thread",
    });
    const emptyThreadSnapshot: OrchestrationReadModel = {
      ...snapshot,
      threads: snapshot.threads.map((thread) => ({
        ...thread,
        latestTurn: null,
        messages: [],
      })),
    };

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: emptyThreadSnapshot,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            {
              provider: "codex",
              status: "error",
              available: false,
              authStatus: "unauthenticated",
              message: "Codex is not installed.",
              checkedAt: NOW_ISO,
            },
          ],
        };
      },
    });

    try {
      await waitForComposerEditor(20_000);
      expect(document.body.textContent).not.toContain("Codex provider status");
      expect(document.body.textContent).not.toContain("Codex is not installed.");

      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Help me connect Codex");
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false));
      sendButton.click();

      await vi.waitFor(() => {
        expect(useProviderConnectionDialogStore.getState()).toMatchObject({
          isOpen: true,
          provider: "codex",
          source: "send",
        });
      });
    } finally {
      useProviderConnectionDialogStore.getState().setOpen(false);
      await mounted.cleanup();
    }
  });

  it("still shows provider health when an existing conversation loses its provider", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-provider-health" as MessageId,
        targetText: "Keep this existing conversation visible",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            {
              provider: "codex",
              status: "error",
              available: false,
              authStatus: "unauthenticated",
              message: "Codex is not installed.",
              checkedAt: NOW_ISO,
            },
          ],
        };
      },
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-slot='alert-title']")).find(
            (element) => element.textContent === "Codex provider status",
          ) ?? null,
        "Unable to find provider health for the existing conversation.",
        20_000,
      );
      expect(document.body.textContent).toContain("Codex is not installed.");
    } finally {
      await mounted.cleanup();
    }
  });

  it("dispatches a bounded fork command from the message action and navigates to the new task", async () => {
    const sourceMessageId = MessageId.makeUnsafe("msg-user-message-fork-source");
    const sourceSnapshot = createSnapshotForTargetUser({
      targetMessageId: sourceMessageId,
      targetText: "Fork exactly here",
    });
    const sourceThread = sourceSnapshot.threads[0]!;
    const sourceMessageIndex = sourceThread.messages.findIndex(
      (message) => message.id === sourceMessageId,
    );
    const snapshot: OrchestrationReadModel = {
      ...sourceSnapshot,
      threads: [
        {
          ...sourceThread,
          messages: sourceThread.messages.slice(sourceMessageIndex, sourceMessageIndex + 2),
        },
      ],
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      const sourceRow = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            `[data-message-id="${sourceMessageId}"][data-message-role="user"]`,
          ),
        "Unable to find source message for the fork action.",
        20_000,
      );
      await userEvent.hover(sourceRow);
      const forkButton = sourceRow.querySelector<HTMLButtonElement>(
        'button[aria-label="Fork conversation from this message"]',
      );
      expect(forkButton).not.toBeNull();
      forkButton?.click();
      forkButton?.click();

      await vi.waitFor(
        () => {
          expect(findRecordedThreadForkCreateCommand()).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
      const forkCommand = findRecordedThreadForkCreateCommand();
      if (!forkCommand) {
        throw new Error("Expected a recorded thread fork command.");
      }

      expect(forkCommand).toMatchObject({
        type: "thread.fork.create",
        sourceThreadId: THREAD_ID,
        sourceMessageId,
        projectId: PROJECT_ID,
        envMode: "local",
        branch: "main",
      });
      expect(forkCommand?.importedMessages).toEqual([
        expect.objectContaining({
          role: "user",
          text: "Fork exactly here",
        }),
      ]);
      expect(
        wsRequests.filter(
          (entry) =>
            entry._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            typeof entry.command === "object" &&
            entry.command !== null &&
            "type" in entry.command &&
            entry.command.type === "thread.fork.create",
        ),
      ).toHaveLength(1);

      const forkThreadId = forkCommand?.threadId;
      expect(typeof forkThreadId).toBe("string");
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${forkThreadId}`);
          expect(
            useStore.getState().threads.find((thread) => thread.id === forkThreadId)?.title,
          ).toBe(`${THREAD_TITLE} (2)`);
        },
        { timeout: 8_000, interval: 16 },
      );

      const provenance = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-fork-provenance="true"]'),
        "Unable to find fork provenance after navigating to the forked conversation.",
      );
      expect(provenance.dataset.forkSourceThreadId).toBe(THREAD_ID);
      expect(provenance.dataset.forkSourceMessageId).toBe(sourceMessageId);
      expect(provenance.textContent).toContain(`Forked from a message in ${THREAD_TITLE}`);
      const sourceLink = provenance.querySelector<HTMLButtonElement>(
        `button[aria-label="Open source conversation: ${THREAD_TITLE}"]`,
      );
      expect(sourceLink).not.toBeNull();
      sourceLink?.click();
      await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`));
    } finally {
      await mounted.cleanup();
    }
  });

  it("blocks direct fork, review, and registered Side creators during project removal", async () => {
    const sourceMessageId = MessageId.makeUnsafe("msg-user-project-removal-direct-creators");
    const sourceSnapshot = createSnapshotForTargetUser({
      targetMessageId: sourceMessageId,
      targetText: "Keep project mutation entry points closed",
    });
    const sourceThread = sourceSnapshot.threads[0]!;
    const sourceMessageIndex = sourceThread.messages.findIndex(
      (message) => message.id === sourceMessageId,
    );
    const snapshot: OrchestrationReadModel = {
      ...sourceSnapshot,
      threads: [
        {
          ...sourceThread,
          messages: sourceThread.messages.slice(sourceMessageIndex, sourceMessageIndex + 2),
        },
      ],
    };
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "/review");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });
    let reservation: ReturnType<typeof reserveProjectRemoval> = null;

    try {
      await userEvent.click(await waitForSendButton());
      await expect
        .element(page.getByText("Review Uncommitted Changes", { exact: true }))
        .toBeVisible();
      await vi.waitFor(() => expect(hasActiveProjectOperations(PROJECT_ID)).toBe(false));
      const requestStart = wsRequests.length;
      reservation = reserveProjectRemoval(PROJECT_ID);
      expect(reservation).not.toBeNull();

      await page.getByText("Review Uncommitted Changes", { exact: true }).click();
      await expect.element(page.getByText("Project removal in progress")).toBeInTheDocument();

      const sourceRow = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            `[data-message-id="${sourceMessageId}"][data-message-role="user"]`,
          ),
        "Unable to find the source message for the removal-time fork action.",
      );
      await userEvent.hover(sourceRow);
      sourceRow
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Fork conversation from this message"]',
        )
        ?.click();

      const createSidechat = getSidechatCreator(THREAD_ID);
      expect(createSidechat).toBeDefined();
      await expect(createSidechat?.()).resolves.toBe(false);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

      expect(
        wsRequests
          .slice(requestStart)
          .map(readDispatchedCommand)
          .some(
            (command) =>
              command?.type === "thread.fork.create" || command?.type === "thread.create",
          ),
      ).toBe(false);
      expect(hasActiveProjectOperations(PROJECT_ID)).toBe(false);
    } finally {
      if (reservation) releaseProjectRemoval(reservation);
      await mounted.cleanup();
    }
  });

  it("blocks a registered Side creator during removal even while a concurrent lease is held", async () => {
    // Regression guard for the removed `projectOperationAlreadyHeld` bypass. A creator used to
    // skip the removal turnstile whenever *any* project-operation lease was already active for
    // the project, which let it race a concurrent removal and orphan the thread it created.
    // Every creator now re-acquires its own lease through `tryBeginProjectOperation`, which
    // refuses once removal is reserved — regardless of other in-flight leases.
    const sourceSnapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("msg-user-held-lease-removal-bypass"),
      targetText: "A concurrent lease must not bypass the removal turnstile",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: sourceSnapshot,
    });
    let concurrentLease: ReturnType<typeof tryBeginProjectOperation> = null;
    let reservation: ReturnType<typeof reserveProjectRemoval> = null;

    try {
      await vi.waitFor(() => expect(getSidechatCreator(THREAD_ID)).toBeDefined());
      await vi.waitFor(() => expect(hasActiveProjectOperations(PROJECT_ID)).toBe(false));

      // A concurrent project operation is already holding a lease at the moment removal begins;
      // acquiring it before the reservation mirrors the real race the bypass exposed.
      concurrentLease = tryBeginProjectOperation(PROJECT_ID);
      expect(concurrentLease).not.toBeNull();

      reservation = reserveProjectRemoval(PROJECT_ID);
      expect(reservation).not.toBeNull();

      const requestStart = wsRequests.length;
      const createSidechat = getSidechatCreator(THREAD_ID);
      expect(createSidechat).toBeDefined();
      // The held lease must not let the creator through: it refuses and dispatches nothing.
      await expect(createSidechat?.()).resolves.toBe(false);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

      // Assert the refusal came from the removal turnstile, not the creator's "Side is
      // unavailable" early guard — otherwise this test would pass even with the bypass restored.
      const feedback = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-composer-local-feedback="true"]'),
        "A removal-blocked Side creator should surface inline composer feedback.",
      );
      expect(feedback.textContent).toContain("Project removal in progress");

      expect(
        wsRequests
          .slice(requestStart)
          .map(readDispatchedCommand)
          .some(
            (command) =>
              command?.type === "thread.fork.create" || command?.type === "thread.create",
          ),
      ).toBe(false);
      // The refused creator neither acquired nor released a lease; the concurrent lease we hold
      // remains the sole active operation, so the count is unchanged (still active, not drained).
      expect(hasActiveProjectOperations(PROJECT_ID)).toBe(true);
    } finally {
      if (concurrentLease) finishProjectOperation(concurrentLease);
      if (reservation) releaseProjectRemoval(reservation);
      await mounted.cleanup();
    }
  });

  it("keeps the Side command when admitted Side creation fails", async () => {
    const sidePrompt = "/side";
    useComposerDraftStore.getState().setPrompt(THREAD_ID, sidePrompt);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-side-admission-failure" as MessageId,
        targetText: "Side failure source",
      }),
      configureNativeApi: (api) => ({
        ...api,
        orchestration: {
          ...api.orchestration,
          dispatchCommand: vi.fn(async (command) => {
            if (command.type === "thread.fork.create") {
              throw new Error("deterministic Side creation failure");
            }
            return api.orchestration.dispatchCommand(command);
          }),
        },
      }),
    });

    try {
      // The composer hydrates the `/side` draft asynchronously after mount; wait for it so the
      // send actually carries the slash command rather than an empty prompt.
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(() => expect(composerEditor.textContent ?? "").toContain("/side"));
      await userEvent.click(await waitForSendButton());
      // A failed Side creation surfaces through the inline composer feedback affordance
      // (`data-composer-local-feedback`), not the global toast stack.
      const feedback = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-composer-local-feedback="true"]'),
        "Side creation failure should be reported without consuming its prompt.",
      );
      expect(feedback.textContent).toContain("Could not start Side");
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(sidePrompt);
      await vi.waitFor(() => expect(hasActiveProjectOperations(PROJECT_ID)).toBe(false));
      expect(hasDispatchedCommandType("thread.turn.start")).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("intercepts Claude /fork in the app instead of sending it to the provider", async () => {
    const sourceSnapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("msg-user-claude-fork-slash-source"),
      targetText: "Claude fork slash source",
    });
    const claudeSnapshot: OrchestrationReadModel = {
      ...sourceSnapshot,
      threads: sourceSnapshot.threads.map((thread) => ({
        ...thread,
        modelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
        session: thread.session
          ? {
              ...thread.session,
              providerName: "claudeAgent",
            }
          : null,
      })),
    };

    useComposerDraftStore.getState().setPrompt(THREAD_ID, "/fork");
    const forkMounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: claudeSnapshot,
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(() => expect(composerEditor.textContent ?? "").toContain("/fork"));
      wsRequests.length = 0;
      await userEvent.click(await waitForSendButton());

      await expect.element(page.getByText("Fork Into New Worktree", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Fork Into Local", { exact: true })).toBeVisible();
      expect(hasDispatchedCommandType("thread.turn.start")).toBe(false);
    } finally {
      await forkMounted.cleanup();
    }
  });

  it("forks from an assistant row that first rendered while streaming", async () => {
    const targetUserMessageId = MessageId.makeUnsafe("msg-user-message-fork-settling-source");
    const sourceSnapshot = createSnapshotForTargetUser({
      targetMessageId: targetUserMessageId,
      targetText: "Wait for the answer",
    });
    const sourceThread = sourceSnapshot.threads[0]!;
    const sourceMessageIndex = sourceThread.messages.findIndex(
      (message) => message.id === targetUserMessageId,
    );
    const settledMessages = sourceThread.messages.slice(sourceMessageIndex, sourceMessageIndex + 2);
    const assistantMessage = settledMessages[1]!;
    const activeTurnId = TurnId.makeUnsafe("turn-message-fork-settling");
    const streamingSnapshot: OrchestrationReadModel = {
      ...sourceSnapshot,
      threads: [
        {
          ...sourceThread,
          latestTurn: {
            turnId: activeTurnId,
            state: "running",
            requestedAt: isoAt(1_100),
            startedAt: isoAt(1_101),
            completedAt: null,
            assistantMessageId: assistantMessage.id,
          },
          messages: [
            settledMessages[0]!,
            {
              ...assistantMessage,
              turnId: activeTurnId,
              streaming: true,
            },
          ],
          session: sourceThread.session
            ? {
                ...sourceThread.session,
                status: "running",
                activeTurnId,
              }
            : null,
        },
      ],
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: streamingSnapshot,
    });

    try {
      const assistantRowSelector = `[data-message-id="${assistantMessage.id}"][data-message-role="assistant"]`;
      const assistantRow = await waitForElement(
        () => document.querySelector<HTMLElement>(assistantRowSelector),
        "Unable to find the streaming assistant message for the fork action.",
      );
      expect(
        assistantRow.querySelector('button[aria-label="Fork conversation from this message"]'),
      ).toBeNull();

      const settledSnapshot: OrchestrationReadModel = {
        ...streamingSnapshot,
        snapshotSequence: streamingSnapshot.snapshotSequence + 1,
        threads: [
          {
            ...streamingSnapshot.threads[0]!,
            latestTurn: {
              ...streamingSnapshot.threads[0]!.latestTurn!,
              state: "completed",
              completedAt: isoAt(1_108),
            },
            messages: [
              settledMessages[0]!,
              {
                ...assistantMessage,
                turnId: activeTurnId,
                // The provider lifecycle is settled, but a delayed transport snapshot can
                // briefly leave the raw message flag true. The terminal footer intentionally
                // treats lifecycle state as authoritative in this case.
                streaming: true,
              },
            ],
            session: sourceThread.session
              ? {
                  ...sourceThread.session,
                  status: "ready",
                  activeTurnId: null,
                }
              : null,
          },
        ],
        updatedAt: isoAt(1_109),
      };
      fixture = { ...fixture, snapshot: settledSnapshot };
      useStore.getState().syncServerReadModel(settledSnapshot);

      const forkButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            `${assistantRowSelector} button[aria-label="Fork conversation from this message"]`,
          ),
        "Unable to find the fork action after the assistant message settled.",
      );
      forkButton.click();

      await vi.waitFor(
        () => {
          expect(findRecordedThreadForkCreateCommand()).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
      const forkCommand = findRecordedThreadForkCreateCommand();
      if (!forkCommand) {
        throw new Error("Expected a recorded thread fork command.");
      }

      expect(forkCommand).toMatchObject({
        type: "thread.fork.create",
        sourceThreadId: THREAD_ID,
        sourceMessageId: assistantMessage.id,
      });
      expect(forkCommand?.importedMessages).toEqual([
        expect.objectContaining({ role: "user", text: "Wait for the answer" }),
        expect.objectContaining({ role: "assistant", text: assistantMessage.text }),
      ]);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(TEXT_VIEWPORT_MATRIX)(
    "[geometry:linux] keeps long user message estimate close at the $name viewport",
    async (viewport) => {
      const userText = "x".repeat(3_200);
      const targetMessageId = `msg-user-target-long-${viewport.name}` as MessageId;
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotForTargetUser({
          targetMessageId,
          targetText: userText,
        }),
      });

      try {
        const { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion } =
          await mounted.measureUserRow(targetMessageId);

        expect(renderedInVirtualizedRegion).toBe(true);

        const estimatedHeightPx = estimateTimelineMessageHeight(
          { role: "user", text: userText, attachments: [] },
          { timelineWidthPx: timelineWidthMeasuredPx },
        );

        expect(Math.abs(measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(
          viewport.textTolerancePx,
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("[geometry:linux] tracks wrapping parity while resizing an existing ChatView across the viewport matrix", async () => {
    const userText = "x".repeat(3_200);
    const targetMessageId = "msg-user-target-resize" as MessageId;
    const mounted = await mountChatView({
      viewport: TEXT_VIEWPORT_MATRIX[0],
      snapshot: createSnapshotForTargetUser({
        targetMessageId,
        targetText: userText,
      }),
    });

    try {
      const measurements: Array<
        UserRowMeasurement & { viewport: ViewportSpec; estimatedHeightPx: number }
      > = [];

      for (const viewport of TEXT_VIEWPORT_MATRIX) {
        await mounted.setViewport(viewport);
        const measurement = await mounted.measureUserRow(targetMessageId);
        const estimatedHeightPx = estimateTimelineMessageHeight(
          { role: "user", text: userText, attachments: [] },
          { timelineWidthPx: measurement.timelineWidthMeasuredPx },
        );

        expect(measurement.renderedInVirtualizedRegion).toBe(true);
        expect(Math.abs(measurement.measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(
          viewport.textTolerancePx,
        );
        measurements.push({ ...measurement, viewport, estimatedHeightPx });
      }

      expect(
        new Set(measurements.map((measurement) => Math.round(measurement.timelineWidthMeasuredPx)))
          .size,
      ).toBeGreaterThanOrEqual(3);

      const byMeasuredWidth = measurements.toSorted(
        (left, right) => left.timelineWidthMeasuredPx - right.timelineWidthMeasuredPx,
      );
      const narrowest = byMeasuredWidth[0]!;
      const widest = byMeasuredWidth.at(-1)!;
      expect(narrowest.timelineWidthMeasuredPx).toBeLessThan(widest.timelineWidthMeasuredPx);
      // Both widths exceed the shared 12-line limit, so resizing must not make
      // the virtualized estimate grow beyond the visible collapsed row.
      expect(narrowest.estimatedHeightPx).toBe(widest.estimatedHeightPx);
      expect(
        Math.abs(narrowest.measuredRowHeightPx - widest.measuredRowHeightPx),
      ).toBeLessThanOrEqual(8);
    } finally {
      await mounted.cleanup();
    }
  });

  it("[geometry:linux] tracks additional rendered wrapping when ChatView width narrows between desktop and mobile viewports", async () => {
    // Short enough to remain below the 12-line collapse at both widths, while
    // still wrapping onto materially more lines on mobile.
    const userText = "x".repeat(320);
    const targetMessageId = "msg-user-target-wrap" as MessageId;
    const snapshot = createSnapshotForTargetUser({
      targetMessageId,
      targetText: userText,
    });
    const desktopMeasurement = await measureUserRowAtViewport({
      viewport: { ...TEXT_VIEWPORT_MATRIX[0], width: 1_400 },
      snapshot,
      targetMessageId,
    });
    const mobileMeasurement = await measureUserRowAtViewport({
      viewport: TEXT_VIEWPORT_MATRIX[2],
      snapshot,
      targetMessageId,
    });

    const estimatedDesktopPx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: desktopMeasurement.timelineWidthMeasuredPx },
    );
    const estimatedMobilePx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: mobileMeasurement.timelineWidthMeasuredPx },
    );

    const measuredDeltaPx =
      mobileMeasurement.measuredRowHeightPx - desktopMeasurement.measuredRowHeightPx;
    const estimatedDeltaPx = estimatedMobilePx - estimatedDesktopPx;
    expect(measuredDeltaPx).toBeGreaterThan(0);
    expect(estimatedDeltaPx).toBeGreaterThan(0);
    const ratio = estimatedDeltaPx / measuredDeltaPx;
    expect(ratio).toBeGreaterThan(0.65);
    expect(ratio).toBeLessThan(1.35);
  });

  it("[geometry:linux] collapses header actions into overflow before they can overlap the thread title", async () => {
    const longTitle =
      'remove "ago" from the sidebar while the diff panel stays open on smaller viewports';
    const headerOverflowSnapshot = (() => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-header-overflow-target" as MessageId,
        targetText: "header overflow",
      });

      return withProjectScripts(
        {
          ...snapshot,
          threads: snapshot.threads.map((thread) =>
            thread.id === THREAD_ID ? Object.assign({}, thread, { title: longTitle }) : thread,
          ),
        },
        [
          {
            id: "dev-server",
            name: "Dev",
            command: "bun run dev",
            icon: "play",
            runOnWorktreeCreate: false,
          },
        ],
      );
    })();
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 540 },
      snapshot: headerOverflowSnapshot,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      await vi.waitFor(
        () => {
          const title = document.querySelector<HTMLElement>(`h2[title='${longTitle}']`);
          const overflowButton = document.querySelector<HTMLButtonElement>(
            'button[aria-label="Toggle environment panel"]',
          );

          expect(title, "Unable to find the chat header title.").toBeTruthy();
          expect(overflowButton, "Unable to find the header overflow trigger.").toBeTruthy();

          const titleRight = title!.getBoundingClientRect().right;
          const actionsLeft = overflowButton!.getBoundingClientRect().left;
          expect(titleRight).toBeLessThanOrEqual(actionsLeft + 1);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the active thread title", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-thread-tooltip-target" as MessageId,
        targetText: "thread tooltip target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(THREAD_TITLE);
        },
        { timeout: 20_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("[geometry:linux] keeps the composer visible while a long assistant response forces a viewport relayout", async () => {
    const mounted = await mountChatView({
      viewport: TEXT_VIEWPORT_MATRIX[0],
      snapshot: createSnapshotWithLongAssistantResponse(),
    });

    try {
      const desktopLayout = await mounted.measureLayout();
      expect(desktopLayout.scrollClientHeightPx).toBeGreaterThan(0);
      expect(desktopLayout.scrollHeightPx).toBeGreaterThan(desktopLayout.scrollClientHeightPx);
      expect(desktopLayout.composerBottomPx).toBeLessThanOrEqual(desktopLayout.hostHeightPx + 1);

      await mounted.setViewport(TEXT_VIEWPORT_MATRIX[2]);
      const mobileLayout = await mounted.measureLayout();
      expect(mobileLayout.scrollClientHeightPx).toBeGreaterThan(0);
      expect(mobileLayout.scrollHeightPx).toBeGreaterThan(mobileLayout.scrollClientHeightPx);
      expect(mobileLayout.composerBottomPx).toBeLessThanOrEqual(mobileLayout.hostHeightPx + 1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("[geometry:linux] keeps the transcript-to-composer gap constant when a task card joins the composer stack", async () => {
    // Regression guard for the oversized gap between the transcript tail and the
    // composer when a stacked panel (active task list) is showing. The composer
    // is a flex sibling below the transcript, so the flex layout already reserves
    // the stack height once; the in-list bottom spacer must stay at its constant
    // baseline (MessagesTimeline BOTTOM_CONTENT_INSET_PX) instead of also growing
    // with the chrome. If it double-counts, the gap above the composer stack
    // grows by ~the chrome height when the task card appears.
    //
    // We anchor on the bottom spacer's top (the true end of transcript content,
    // after any live-turn activity indicator) rather than the last message row,
    // so a running turn's working indicator does not confound the measurement.
    // Mirrors MessagesTimeline BOTTOM_CONTENT_INSET_PX (the fixed tail spacer).
    const TRANSCRIPT_BOTTOM_SPACER_PX = 64;
    const measureComposerGap = async (
      mounted: Awaited<ReturnType<typeof mountChatView>>,
      { expectTaskCard }: { expectTaskCard: boolean },
    ): Promise<number> => {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      // The fixture overflows the viewport, so scrolling to the end pins the tail
      // spacer against the viewport bottom where the gap is well defined.
      const layout = await mounted.measureLayout();
      expect(layout.scrollHeightPx).toBeGreaterThan(layout.scrollClientHeightPx);

      let gapPx = 0;
      await vi.waitFor(
        async () => {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
          scrollContainer.dispatchEvent(new Event("scroll"));
          await waitForLayout();
          expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeLessThanOrEqual(
            AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
          );

          const taskCard = document.querySelector<HTMLElement>(
            '[data-testid="active-task-list-card"]',
          );
          if (expectTaskCard) {
            expect(taskCard, "Expected the active task list card to be present.").not.toBeNull();
          } else {
            expect(taskCard, "Expected no active task list card.").toBeNull();
          }

          const composerStack = document.querySelector<HTMLElement>(
            '[data-chat-composer-stack="true"]',
          );
          expect(composerStack, "Unable to find composer stack wrapper.").not.toBeNull();
          const bottomSpacer = document.querySelector<HTMLElement>(
            '[data-testid="transcript-bottom-spacer"]',
          );
          expect(bottomSpacer, "Unable to find transcript bottom spacer.").not.toBeNull();

          const transcriptContentBottom = bottomSpacer!.getBoundingClientRect().top;
          const composerStackTop = composerStack!.getBoundingClientRect().top;
          gapPx = composerStackTop - transcriptContentBottom;
          // The composer stack sits just below the transcript tail, never a
          // screenful away.
          expect(gapPx).toBeGreaterThan(0);
          expect(gapPx).toBeLessThan(TRANSCRIPT_BOTTOM_SPACER_PX);
        },
        { timeout: 8_000, interval: 16 },
      );
      return gapPx;
    };

    const active = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithActiveInlinePlan(),
    });
    let gapWithTaskCard = 0;
    try {
      gapWithTaskCard = await measureComposerGap(active, { expectTaskCard: true });
    } finally {
      await active.cleanup();
    }

    const settled = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSettledInlinePlan(),
    });
    let gapWithoutTaskCard = 0;
    try {
      gapWithoutTaskCard = await measureComposerGap(settled, { expectTaskCard: false });
    } finally {
      await settled.cleanup();
    }

    // The stacked task card must not widen the transcript-to-composer gap.
    expect(Math.abs(gapWithTaskCard - gapWithoutTaskCard)).toBeLessThanOrEqual(3);
  });

  it("stays pinned to the bottom after delayed attachment loads expand the timeline", async () => {
    attachmentResponseDelayMs = 160;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithBottomAttachments(),
    });

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll("img").length).toBeGreaterThanOrEqual(3);
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForImagesToLoad(document.body);
      await vi.waitFor(
        async () => {
          const layout = await mounted.measureLayout();
          expect(layout.scrollHeightPx).toBeGreaterThan(layout.scrollClientHeightPx);
          expect(layout.distanceFromBottomPx).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      attachmentResponseDelayMs = 0;
      await mounted.cleanup();
    }
  });

  it("smoothly re-sticks to the bottom after sending an optimistic user message", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-send-bottom-stick" as MessageId,
        targetText: "bottom stick target",
      }),
    });
    let patchedScrollContainer: HTMLElement | null = null;
    let originalScrollTo: HTMLElement["scrollTo"] | null = null;

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      await vi.waitFor(
        () => {
          expect(scrollContainer.scrollHeight - scrollContainer.clientHeight).toBeGreaterThan(
            AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
      await userEvent.wheel(scrollContainer, {
        delta: { y: -scrollContainer.scrollHeight },
      });
      await vi.waitFor(
        () => {
          expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(
            AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      const scrollToCalls: ScrollToOptions[] = [];
      patchedScrollContainer = scrollContainer;
      originalScrollTo = scrollContainer.scrollTo;
      scrollContainer.scrollTo = ((options?: ScrollToOptions | number, y?: number) => {
        const normalized: ScrollToOptions =
          typeof options === "object" && options !== null
            ? options
            : {
                ...(typeof options === "number" ? { left: options } : {}),
                ...(typeof y === "number" ? { top: y } : {}),
              };
        scrollToCalls.push(normalized);
        if (typeof normalized.left === "number") {
          scrollContainer.scrollLeft = normalized.left;
        }
        if (typeof normalized.top === "number") {
          scrollContainer.scrollTop = normalized.top;
        }
        scrollContainer.dispatchEvent(new Event("scroll"));
      }) as typeof scrollContainer.scrollTo;

      const prompt = "keep me pinned after send";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await userEvent.click(sendButton);

      await vi.waitFor(
        async () => {
          expect(document.body.textContent).toContain(prompt);
          expect(document.activeElement).toBe(await waitForComposerEditor());
          expect(scrollToCalls.some((call) => call.behavior === "smooth")).toBe(true);
          const layout = await mounted.measureLayout();
          expect(layout.scrollHeightPx).toBeGreaterThan(layout.scrollClientHeightPx);
          expect(layout.distanceFromBottomPx).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
        },
        { timeout: 8_000, interval: 16 },
      );
      scrollContainer.scrollTo = originalScrollTo;
    } finally {
      if (patchedScrollContainer && originalScrollTo) {
        patchedScrollContainer.scrollTo = originalScrollTo;
      }
      await mounted.cleanup();
    }
  });

  it("sends unmarked automation questions as normal chat messages", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-automation-question" as MessageId,
        targetText: "automation question target",
      }),
    });

    try {
      const prompt = "how do automations work every day?";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain(prompt);
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await userEvent.click(sendButton);

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find((request) => {
            const command = readDispatchedCommand(request);
            return command?.type === "thread.turn.start";
          });
          expect(turnStartRequest).toBeTruthy();
        },
        { timeout: 20_000, interval: 16 },
      );

      expect(wsRequests.some((request) => request._tag === WS_METHODS.automationCreate)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates composer automations as heartbeat runs on the current chat", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-current-chat-automation" as MessageId,
        targetText: "current chat automation target",
      }),
    });

    try {
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_ID, "/automation say hi every 15 seconds 3 times total");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("say hi every 15 seconds");
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await userEvent.click(sendButton);

      await vi.waitFor(
        () => {
          const automationCreateRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.automationCreate,
          );
          expect(automationCreateRequest).toMatchObject({
            _tag: WS_METHODS.automationCreate,
            mode: "heartbeat",
            targetThreadId: THREAD_ID,
            sourceThreadId: THREAD_ID,
            worktreeMode: "auto",
            maxIterations: 3,
            prompt: "say hi",
            schedule: { type: "interval", everySeconds: 15 },
          });
        },
        { timeout: 20_000, interval: 16 },
      );
      await waitForLayout();

      expect(hasDispatchedCommandType("thread.create")).toBe(false);
      expect(hasDispatchedCommandType("thread.turn.start")).toBe(false);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.gitCreateWorktree)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates polite composer automation requests as heartbeat runs", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-polite-chat-automation" as MessageId,
        targetText: "polite current chat automation target",
      }),
    });

    try {
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_ID, "could you say hi every 15 seconds for 3 times");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("could you say hi");
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const automationCreateRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.automationCreate,
          );
          expect(automationCreateRequest).toMatchObject({
            _tag: WS_METHODS.automationCreate,
            mode: "heartbeat",
            targetThreadId: THREAD_ID,
            sourceThreadId: THREAD_ID,
            worktreeMode: "auto",
            maxIterations: 3,
            prompt: "say hi",
            schedule: { type: "interval", everySeconds: 15 },
          });
        },
        { timeout: 20_000, interval: 16 },
      );
      await waitForLayout();

      expect(hasDispatchedCommandType("thread.create")).toBe(false);
      expect(hasDispatchedCommandType("thread.turn.start")).toBe(false);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.gitCreateWorktree)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("promotes draft chats before creating composer heartbeat automations", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: "feature/draft-automation",
          worktreePath: "/repo/worktrees/draft-automation",
          envMode: "worktree",
          workspaceOrigin: "intentional",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: "gpt-5.4",
      options: {
        reasoningEffort: "low",
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_ID, "/automation say hi every 15 seconds for 3 times");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("say hi every 15 seconds");
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await sendButton.click();

      await vi.waitFor(
        () => {
          const createThreadIndex = wsRequests.findIndex((request) => {
            const command = readDispatchedCommand(request);
            return command?.type === "thread.create" && command.threadId === THREAD_ID;
          });
          const automationCreateIndex = wsRequests.findIndex(
            (request) => request._tag === WS_METHODS.automationCreate,
          );
          expect(createThreadIndex).toBeGreaterThanOrEqual(0);
          expect(automationCreateIndex).toBeGreaterThan(createThreadIndex);

          const createThreadCommand = readDispatchedCommand(wsRequests[createThreadIndex]!);
          expect(createThreadCommand).toMatchObject({
            type: "thread.create",
            threadId: THREAD_ID,
            envMode: "worktree",
            branch: "feature/draft-automation",
            worktreePath: "/repo/worktrees/draft-automation",
            associatedWorktreePath: "/repo/worktrees/draft-automation",
            associatedWorktreeBranch: "feature/draft-automation",
            associatedWorktreeRef: "feature/draft-automation",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
              options: {
                reasoningEffort: "low",
              },
            },
            runtimeMode: "full-access",
            interactionMode: "default",
          });

          expect(wsRequests[automationCreateIndex]).toMatchObject({
            _tag: WS_METHODS.automationCreate,
            mode: "heartbeat",
            targetThreadId: THREAD_ID,
            sourceThreadId: THREAD_ID,
            worktreeMode: "auto",
            maxIterations: 3,
            prompt: "say hi",
            schedule: { type: "interval", everySeconds: 15 },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();

      expect(hasDispatchedCommandType("thread.turn.start")).toBe(false);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.gitCreateWorktree)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not promote draft chats until a reviewed automation is submitted", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
          workspaceOrigin: "default",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "/automation say hi every 15 seconds");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("say hi every 15 seconds");
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await sendButton.click();

      await expect.element(page.getByText("Fast recurring loop")).toBeInTheDocument();
      expect(hasDispatchedCommandType("thread.create")).toBe(false);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.automationCreate)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(ATTACHMENT_VIEWPORT_MATRIX)(
    "[geometry:linux] keeps user attachment estimate close at the $name viewport",
    async (viewport) => {
      const targetMessageId = `msg-user-target-attachments-${viewport.name}` as MessageId;
      const userText = "message with image attachments";
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotForTargetUser({
          targetMessageId,
          targetText: userText,
          targetAttachmentCount: 3,
        }),
      });

      try {
        const { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion } =
          await mounted.measureUserRow(targetMessageId);

        expect(renderedInVirtualizedRegion).toBe(true);

        const estimatedHeightPx = estimateTimelineMessageHeight(
          {
            role: "user",
            text: userText,
            attachments: [{ id: "attachment-1" }, { id: "attachment-2" }, { id: "attachment-3" }],
          },
          { timelineWidthPx: timelineWidthMeasuredPx },
        );

        expect(Math.abs(measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(
          viewport.attachmentTolerancePx,
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("opens the project cwd for draft threads without a worktree path", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
          workspaceOrigin: "default",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      const openInVsCodeTrigger = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
            (button) => button.textContent?.trim() === "Open in VS Code",
          ) ?? null,
        "Unable to find Open in VS Code environment row.",
      );
      openInVsCodeTrigger.click();

      const vscodeOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')).find(
            (item) => item.textContent?.trim() === "VS Code",
          ) ?? null,
        "Unable to find VS Code editor option.",
      );
      vscodeOption.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows branch tools on a fresh top-level thread before any messages", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID),
    });

    try {
      await expect.element(page.getByText("What should we do in")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Local" })).toBeInTheDocument();
      expect(document.body.textContent).toContain("main");
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from local draft threads at the project cwd", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
          workspaceOrigin: "default",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_400 },
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "lint",
          name: "Lint",
          command: "bun run lint",
          icon: "lint",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      const runButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.title === "Run Lint",
          ) as HTMLButtonElement | null,
        "Unable to find Run Lint button.",
      );
      runButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) =>
              request._tag === WS_METHODS.terminalOpen && request.cwd === "/repo/project",
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/project",
            env: {
              SYNARA_PROJECT_ROOT: "/repo/project",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const writeRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalWrite,
          );
          expect(writeRequest).toMatchObject({
            _tag: WS_METHODS.terminalWrite,
            threadId: THREAD_ID,
            data: "bun run lint\r",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from worktree draft threads at the worktree cwd", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: "feature/draft",
          worktreePath: "/repo/worktrees/feature-draft",
          envMode: "worktree",
          workspaceOrigin: "intentional",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_400 },
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "test",
          name: "Test",
          command: "bun run test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      const runButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.title === "Run Test",
          ) as HTMLButtonElement | null,
        "Unable to find Run Test button.",
      );
      runButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) =>
              request._tag === WS_METHODS.terminalOpen &&
              request.cwd === "/repo/worktrees/feature-draft",
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/worktrees/feature-draft",
            env: {
              SYNARA_PROJECT_ROOT: "/repo/project",
              SYNARA_WORKTREE_PATH: "/repo/worktrees/feature-draft",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles plan mode with Shift+Tab only while the composer is focused", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as MessageId,
        targetText: "hotkey target",
      }),
    });

    try {
      const readInteractionMode = () =>
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode ?? "default";
      expect(readInteractionMode()).toBe("default");

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();

      expect(readInteractionMode()).toBe("default");

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        () => {
          expect(readInteractionMode()).toBe("plan");
          const planButton = Array.from(
            document.querySelectorAll<HTMLButtonElement>("button"),
          ).find((button) => button.textContent?.trim() === "Plan");
          expect(planButton?.title).toContain("return to normal build mode");
        },
        { timeout: 8_000, interval: 16 },
      );

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        () => {
          expect(readInteractionMode()).toBe("default");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles composer focus with Cmd+L", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-composer-focus-shortcut" as MessageId,
        targetText: "composer focus shortcut",
      }),
    });
    const focusTarget = document.createElement("button");
    focusTarget.type = "button";
    focusTarget.textContent = "Focus sink";
    document.body.appendChild(focusTarget);

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      focusTarget.focus();
      expect(document.activeElement).toBe(focusTarget);

      const focusEvent = dispatchComposerFocusToggleShortcut();
      expect(focusEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(composerEditor);
      });

      const blurEvent = dispatchComposerFocusToggleShortcut();
      expect(blurEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(document.activeElement).not.toBe(composerEditor);
      });
    } finally {
      focusTarget.remove();
      await mounted.cleanup();
    }
  });

  it("opens the composer model picker surface", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-picker-shortcut" as MessageId,
        targetText: "model picker shortcut",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      composerEditor.focus();
      dispatchComposerPickerShortcut(composerEditor, "m");

      await waitForComposerPickerSurfaceOpen();
    } finally {
      await mounted.cleanup();
    }
  });

  it("cycles the active provider model without opening the picker", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-cycle-shortcut" as MessageId,
        targetText: "model cycle shortcut",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();

      await dispatchModelCycleShortcutWhenReady(composerEditor, "]");
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
            .codex,
        ).toMatchObject({ provider: "codex", model: "gpt-5.6-sol" });
      });
      expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();

      await dispatchModelCycleShortcutWhenReady(composerEditor, "[");
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
            .codex,
        ).toMatchObject({ provider: "codex", model: "gpt-5.2" });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the composer model picker with configured keybinding labels loaded", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-picker-configured-shortcut" as MessageId,
        targetText: "configured model picker shortcut",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "modelPicker.toggle",
              shortcut: {
                key: "m",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: true,
                modKey: true,
              },
            },
          ],
        };
      },
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      composerEditor.focus();
      dispatchConfiguredShortcut(composerEditor, { key: "m", altKey: true });

      await waitForComposerPickerSurfaceOpen();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the composer effort picker surface", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-effort-picker-shortcut" as MessageId,
        targetText: "effort picker shortcut",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      composerEditor.focus();
      dispatchComposerPickerShortcut(composerEditor, "e");

      await waitForComposerPickerSurfaceOpen();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps removed terminal context pills removed when a new one is added", async () => {
    const removedLabel = "Terminal 1 lines 1-2";
    const addedLabel = "Terminal 2 lines 9-10";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-removed",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "bun i\nno changes",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-pill-backspace" as MessageId,
        targetText: "terminal pill backspace target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const store = useComposerDraftStore.getState();
      const currentPrompt = store.draftsByThreadId[THREAD_ID]?.prompt ?? "";
      const nextPrompt = removeInlineTerminalContextPlaceholder(currentPrompt, 0);
      store.setPrompt(THREAD_ID, nextPrompt.prompt);
      store.removeTerminalContext(THREAD_ID, "ctx-removed");

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().addTerminalContext(
        THREAD_ID,
        createTerminalContext({
          id: "ctx-added",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
          text: "git status\nOn branch main",
        }),
      );

      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
          expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-added"]);
          expect(document.body.textContent).toContain(addedLabel);
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("disables send when the composer only contains an expired terminal pill", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-expired-only",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-disabled" as MessageId,
        targetText: "expired pill disabled target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("warns when sending text while omitting expired terminal pills", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-expired-send-warning",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );
    useComposerDraftStore
      .getState()
      .setPrompt(THREAD_ID, `yoo${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}waddup`);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-warning" as MessageId,
        targetText: "expired pill warning target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Expired terminal context omitted from message",
          );
          expect(document.body.textContent).not.toContain(expiredLabel);
          expect(document.body.textContent).toContain("yoowaddup");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a pointer cursor for the running stop button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stop-button-cursor" as MessageId,
        targetText: "stop button cursor target",
        sessionStatus: "running",
      }),
    });

    try {
      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );

      expect(getComputedStyle(stopButton).cursor).toBe("pointer");
      expect(document.querySelector('button[aria-label="Record voice note"]')).not.toBeNull();
      expect(document.querySelector('button[aria-label="Queue follow-up"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps slash-command validation feedback inside the composer controls", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "/review unsupported-target");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-local-slash-feedback" as MessageId,
        targetText: "local slash feedback target",
      }),
    });

    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();

      const feedback = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-composer-local-feedback="true"]'),
        "Unable to find composer-local slash feedback.",
      );
      expect(feedback.textContent).toContain("Invalid /review command");
      expect(feedback.closest('[data-chat-composer-footer="true"]')).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a queued follow-up row while a turn is running", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "queue this follow-up");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-running-queue-button" as MessageId,
        targetText: "running queue button target",
        sessionStatus: "running",
      }),
    });

    try {
      const queueButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Queue follow-up"]'),
        "Unable to find the running-turn queue button.",
      );
      expect(queueButton.title).toContain("Enter");
      expect(queueButton.title).toContain("Cmd/Ctrl+Enter");
      expect(document.querySelector('button[aria-label="Stop generation"]')).toBeNull();
      expect(document.querySelector('button[aria-label="Record voice note"]')).not.toBeNull();
      await mounted.setViewport(TEXT_VIEWPORT_MATRIX[3]);
      expect(document.querySelector('button[aria-label="Queue follow-up"]')).not.toBeNull();
      expect(document.querySelector('button[aria-label="Record voice note"]')).not.toBeNull();
      document.querySelector<HTMLButtonElement>('button[aria-label="Queue follow-up"]')?.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("queue this follow-up");
          expect(document.body.textContent).toContain("Steer");
        },
        { timeout: 8_000, interval: 16 },
      );

      const queuedRow = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="queued-follow-up-row"]'),
        "Unable to find queued follow-up row.",
      );
      expect(queuedRow).not.toBeNull();

      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );
      expect(stopButton).not.toBeNull();
      expect(document.querySelector('button[aria-label="Record voice note"]')).not.toBeNull();
      expect(hasDispatchedCommandType("thread.turn.interrupt")).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps active recorder controls usable when an approval arrives", async () => {
    const microphone = installFakeMicrophoneCapture();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-voice-approval-transition" as MessageId,
        targetText: "voice approval transition target",
        sessionStatus: "running",
      }),
      configureNativeApi: configureSuccessfulVoiceTranscription("approval-safe transcript"),
    });

    try {
      const recordButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Record voice note"]'),
        "Unable to find voice recording button.",
      );
      recordButton.click();
      await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Cancel voice recording"]'),
        "Voice recorder did not start.",
      );
      microphone.emitSamples();

      appendActiveThreadActivity({
        id: EventId.makeUnsafe("approval-during-voice"),
        createdAt: isoAt(1_200),
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        turnId: null,
        payload: {
          requestId: "approval-during-voice",
          requestKind: "command",
          detail: "bun run test",
        },
      });

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("bun run test");
          expect(
            document.querySelector<HTMLButtonElement>(
              'button[aria-label="Cancel voice recording"]',
            ),
          ).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      const insertButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Stop and insert voice note"]',
      );
      const sendButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Send voice note"]',
      );
      expect(insertButton?.disabled).toBe(false);
      expect(sendButton?.disabled).toBe(false);

      document
        .querySelector<HTMLButtonElement>('button[aria-label="Cancel voice recording"]')
        ?.click();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-chat-composer-footer="true"]')).toBeNull();
      });
    } finally {
      await mounted.cleanup();
      microphone.restore();
    }
  });

  it("queues voice Send instead of answering a question that arrives mid-recording", async () => {
    const microphone = installFakeMicrophoneCapture();
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "existing draft");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-voice-question-transition" as MessageId,
        targetText: "voice question transition target",
        sessionStatus: "running",
      }),
      configureNativeApi: configureSuccessfulVoiceTranscription("spoken follow-up"),
    });

    try {
      const recordButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Record voice note"]'),
        "Unable to find voice recording button.",
      );
      recordButton.click();
      await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Cancel voice recording"]'),
        "Voice recorder did not start.",
      );
      microphone.emitSamples();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));

      appendActiveThreadActivity({
        id: EventId.makeUnsafe("question-during-voice"),
        createdAt: isoAt(1_210),
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        turnId: null,
        payload: {
          requestId: "question-during-voice",
          questions: [
            {
              id: "release_choice",
              header: "Release",
              question: "Which release path should be used?",
              options: [
                {
                  label: "safe",
                  description: "Use the safe release path",
                },
              ],
            },
          ],
        },
      });

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Which release path should be used?");
          expect(
            document.querySelector<HTMLButtonElement>('button[aria-label="Send voice note"]'),
          ).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      document.querySelector<HTMLButtonElement>('button[aria-label="Send voice note"]')?.click();

      await vi.waitFor(
        () => {
          const queuedRow = document.querySelector<HTMLElement>(
            '[data-testid="queued-follow-up-row"]',
          );
          const queuedTurn =
            useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns[0];
          expect(queuedRow?.textContent).toContain("existing draft");
          expect(queuedTurn?.kind).toBe("chat");
          expect(queuedTurn?.kind === "chat" ? queuedTurn.prompt : null).toBe(
            "existing draft\nspoken follow-up",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            typeof request.command === "object" &&
            request.command !== null &&
            "type" in request.command &&
            request.command.type === "thread.user-input.respond",
        ),
      ).toBe(false);
      expect(document.body.textContent).toContain("Which release path should be used?");
    } finally {
      await mounted.cleanup();
      microphone.restore();
    }
  });

  it("keeps Cmd/Ctrl+Enter as the immediate steering shortcut while a turn is running", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "steer this follow-up now");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-running-steer-shortcut" as MessageId,
        targetText: "running steer shortcut target",
        sessionStatus: "running",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();
      const useMetaForMod = isMacPlatform(navigator.platform);
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: useMetaForMod,
          ctrlKey: !useMetaForMod,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        () => {
          const steeredTurn = wsRequests
            .map((request) => readDispatchedCommand(request))
            .find(
              (command) =>
                command?.type === "thread.turn.start" && command.dispatchMode === "steer",
            );
          expect(steeredTurn).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(document.querySelector('[data-testid="queued-follow-up-row"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps queued follow-ups when you switch threads and come back", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "queue survives thread switch");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-running-queue-switch" as MessageId,
          targetText: "running queue switch target",
          sessionStatus: "running",
        }),
        OTHER_THREAD_ID,
      ),
    });
    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();

      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
          expect(document.body.textContent).toContain("queue survives thread switch");
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForLayout();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
      });
      await waitForLayout();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
          expect(document.body.textContent).toContain("queue survives thread switch");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("editing a queued follow-up removes only that row and restores its images to the composer", async () => {
    const queuedImage = createComposerImage({
      id: "queued-image-1",
      previewUrl: "blob:queued-image-1",
      name: "queued-image.png",
    });
    const firstQueuedPrompt = "first queued prompt with image";
    const secondQueuedPrompt = "second queued prompt stays queued";

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-running-edit-queue" as MessageId,
        targetText: "running edit queue target",
        sessionStatus: "running",
      }),
    });

    try {
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-1",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: firstQueuedPrompt,
        prompt: firstQueuedPrompt,
        images: [queuedImage],
        files: [],
        assistantSelections: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-2",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: secondQueuedPrompt,
        prompt: secondQueuedPrompt,
        images: [],
        files: [],
        assistantSelections: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });

      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(2);
        },
        { timeout: 8_000, interval: 16 },
      );

      const actionButtons = document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Queued follow-up actions"]',
      );
      actionButtons[0]?.click();

      const editMenuItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')).find(
            (item) => item.textContent?.trim() === "Edit queued prompt",
          ) ?? null,
        "Unable to find edit queued prompt menu item.",
      );
      editMenuItem.click();

      await vi.waitFor(
        () => {
          const queuedRows = document.querySelectorAll<HTMLElement>(
            '[data-testid="queued-follow-up-row"]',
          );
          expect(queuedRows).toHaveLength(1);
          expect(queuedRows[0]?.textContent ?? "").toContain(secondQueuedPrompt);
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            firstQueuedPrompt,
          );
          expect(
            useComposerDraftStore
              .getState()
              .draftsByThreadId[THREAD_ID]?.images.map((image) => image.name),
          ).toEqual(["queued-image.png"]);
          // The restored image renders as a thumbnail chip whose filename lives in
          // its accessible label/title, not in text content.
          expect(document.querySelector('[aria-label="Preview queued-image.png"]')).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("auto-dispatches a queued turn without wiping the live composer draft", async () => {
    const queuedPrompt = "queued prompt that should auto-send";
    const draftBeingTyped = "draft the user is still typing";

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-auto-dispatch-target" as MessageId,
        targetText: "auto dispatch target",
        // Idle session so the auto-dispatch effect (gated on phase !== "running")
        // drains the queue, mirroring a turn that just finished.
        sessionStatus: "ready",
      }),
    });

    try {
      // The user is mid-draft in the composer while a turn-completion drain fires.
      useComposerDraftStore.getState().setPrompt(THREAD_ID, draftBeingTyped);
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-auto",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: queuedPrompt,
        prompt: queuedPrompt,
        images: [],
        files: [],
        assistantSelections: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              request.command.type === "thread.turn.start" &&
              "threadId" in request.command &&
              request.command.threadId === THREAD_ID &&
              "message" in request.command &&
              typeof request.command.message === "object" &&
              request.command.message !== null &&
              "text" in request.command.message &&
              typeof request.command.message.text === "string" &&
              request.command.message.text.includes(queuedPrompt),
          );
          expect(turnStartRequest).toBeTruthy();
          // Queue drained...
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
          // ...but the in-progress composer draft is left untouched.
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            draftBeingTyped,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("auto-dispatches a queued chat turn as a chat message even while a plan follow-up is pending", async () => {
    const queuedPrompt = "queued chat turn that must stay a chat message";
    const queuedImage = createComposerImage({
      id: "queued-plan-image-1",
      previewUrl: "blob:queued-plan-image-1",
      name: "queued-plan-image.png",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      // Plan mode, settled turn, actionable proposed plan -> the live composer is
      // showing the plan follow-up prompt at the moment the queue drains.
      snapshot: createSnapshotWithSettledPlanAwaitingFollowUp(),
    });

    try {
      // Make the live composer's interaction mode explicitly "plan" so the
      // plan-follow-up branch in onSend is live. The queued chat turn below
      // carries its own "default" mode and an image attachment, both of which the
      // misroute (onSubmitPlanFollowUp) would discard.
      useComposerDraftStore.getState().setInteractionMode(THREAD_ID, "plan");
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-plan-chat",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: queuedPrompt,
        prompt: queuedPrompt,
        images: [queuedImage],
        files: [],
        assistantSelections: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              request.command.type === "thread.turn.start" &&
              "threadId" in request.command &&
              request.command.threadId === THREAD_ID &&
              "message" in request.command &&
              typeof request.command.message === "object" &&
              request.command.message !== null &&
              "text" in request.command.message &&
              typeof request.command.message.text === "string" &&
              request.command.message.text.includes(queuedPrompt),
          );
          expect(turnStartRequest).toBeTruthy();
          const command = turnStartRequest!.command as {
            interactionMode?: unknown;
            message?: { attachments?: Array<{ type?: unknown; name?: unknown }> };
          };
          // Dispatched as a normal chat turn: it keeps the queued turn's own
          // "default" interaction mode rather than being coerced to "plan" by the
          // plan-follow-up path.
          expect(command.interactionMode).toBe("default");
          // ...and the queued image survives instead of being dropped to [].
          const attachments = command.message?.attachments ?? [];
          expect(attachments).toHaveLength(1);
          expect(attachments[0]?.type).toBe("image");
          expect(attachments[0]?.name).toBe("queued-plan-image.png");
          // Queue drained.
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the new thread selected after clicking the new-thread button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-thread-test" as MessageId,
        targetText: "new thread selection test",
      }),
    });

    try {
      // Wait for the sidebar to render with the project.
      const newThreadButton = page.getByLabelText("Create new thread in Project");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      // The route should change to a new draft thread ID.
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      // The composer editor should be present for the new draft thread.
      await waitForComposerEditor();

      // Simulate the snapshot sync arriving from the server after the draft
      // thread has been promoted to a server thread (thread.create + turn.start
      // succeeded). The snapshot now includes the new thread, and the sync
      // should clear the draft without disrupting the route.
      const { syncServerReadModel } = useStore.getState();
      syncServerReadModel(addThreadToSnapshot(fixture.snapshot, newThreadId));

      // Clear the draft now that the server thread exists (mirrors EventRouter behavior).
      useComposerDraftStore.getState().clearDraftThread(newThreadId);

      // The route should still be on the new thread — not redirected away.
      await waitForURL(
        mounted.router,
        (path) => path === newThreadPath,
        "New thread should remain selected after snapshot sync clears the draft.",
      );

      // The empty thread view and composer should still be visible.
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("lets an empty project draft switch to another open project", async () => {
    const longOtherProjectName =
      "Other Project With an Intentionally Long Name for Responsive Heading Coverage";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withOpenProjectPickerFixtures(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-switch-test" as MessageId,
          targetText: "project picker switch test",
        }),
        longOtherProjectName,
      ),
    });

    try {
      const newThreadButton = page.getByLabelText("Create new thread in Project");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      useComposerDraftStore.getState().setDraftThreadContext(newThreadId, {
        envMode: "worktree",
        branch: "feature/keep-out",
        worktreePath: "/repo/project/.worktrees/feature-keep-out",
      });
      useComposerDraftStore.getState().setProjectDraftThreadId(OTHER_PROJECT_ID, OTHER_THREAD_ID);
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "replace this other draft");

      const headingProjectTrigger = page.getByTestId("empty-landing-heading-project-trigger");
      await expect.element(headingProjectTrigger).toHaveTextContent("Project");
      expect(page.getByTestId("project-picker-trigger").elements()).toHaveLength(0);
      await headingProjectTrigger.click();

      await expect.element(page.getByText("New project")).toBeInTheDocument();
      await expect.element(page.getByText("Don't work in a project")).toBeInTheDocument();
      await expect.element(page.getByText(/Folders on this/)).not.toBeInTheDocument();

      const currentProjectOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')).find(
            (item) => item.textContent?.trim() === "project",
          ) ?? null,
        "Unable to find current project option.",
      );
      currentProjectOption.click();
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: PROJECT_ID,
            envMode: "worktree",
            branch: "feature/keep-out",
            worktreePath: "/repo/project/.worktrees/feature-keep-out",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await headingProjectTrigger.click();
      await page.getByText("other", { exact: true }).click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: PROJECT_ID,
            envMode: "worktree",
            branch: "feature/keep-out",
            worktreePath: "/repo/project/.worktrees/feature-keep-out",
          });
          expect(useComposerDraftStore.getState().getDraftThread(OTHER_THREAD_ID)).toMatchObject({
            projectId: OTHER_PROJECT_ID,
          });
          expect(useComposerDraftStore.getState().draftsByThreadId[OTHER_THREAD_ID]?.prompt).toBe(
            "replace this other draft",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
      const emptyLandingHeading = page.getByTestId("empty-landing-heading");
      await expect
        .element(emptyLandingHeading)
        .toHaveAccessibleName(`What should we do in ${longOtherProjectName}?`);
      await expect.element(headingProjectTrigger).toHaveTextContent(longOtherProjectName);
      await expect
        .element(headingProjectTrigger)
        .toHaveAccessibleName(`Change project from ${longOtherProjectName}`);

      await mounted.setViewport({ ...DEFAULT_VIEWPORT, width: 760, height: 700 });
      const headingProjectElement = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-testid="empty-landing-heading-project-trigger"]',
          ),
        "Unable to find responsive heading project trigger.",
      );
      const headingProjectCluster = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-testid="empty-landing-heading-project-cluster"]',
          ),
        "Unable to find responsive heading project cluster.",
      );
      const emptyLandingHeadingElement = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="empty-landing-heading"]'),
        "Unable to find responsive empty landing heading.",
      );
      expect(headingProjectElement.scrollWidth).toBeGreaterThan(headingProjectElement.clientWidth);
      expect(headingProjectCluster.getBoundingClientRect().width).toBeLessThanOrEqual(
        emptyLandingHeadingElement.getBoundingClientRect().width,
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);

      await headingProjectTrigger.click();
      await page.getByText("project", { exact: true }).click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: PROJECT_ID,
            envMode: "worktree",
            branch: "feature/keep-out",
            worktreePath: "/repo/project/.worktrees/feature-keep-out",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
      await expect
        .element(emptyLandingHeading)
        .toHaveAccessibleName("What should we do in Project?");
      await expect.element(headingProjectTrigger).toHaveTextContent("Project");
      await expect
        .element(headingProjectTrigger)
        .toHaveAccessibleName("Change project from Project");
    } finally {
      await mounted.cleanup();
    }
  });

  it("activates an occupied project draft through the owning split pane", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withOpenProjectPickerFixtures(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-split-ownership" as MessageId,
          targetText: "project picker split ownership",
        }),
      ),
    });

    try {
      await page.getByLabelText("Create new thread in Project").click();
      const sourcePath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a split source draft.",
      );
      const sourceThreadId = sourcePath.slice(1) as ThreadId;
      useComposerDraftStore.getState().setPrompt(sourceThreadId, "preserve split source draft");
      useComposerDraftStore.getState().setProjectDraftThreadId(OTHER_PROJECT_ID, OTHER_THREAD_ID);
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "preserve split target draft");

      const splitViewId = useSplitViewStore.getState().createFromDrop({
        sourceThreadId,
        ownerProjectId: PROJECT_ID,
        droppedThreadId: THREAD_ID,
        direction: "horizontal",
        side: "second",
      });
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: sourceThreadId },
        search: () => ({ splitViewId }),
      });
      await vi.waitFor(() => {
        expect(document.querySelectorAll("[data-split-chat-pane]")).toHaveLength(2);
        expect(mounted.router.state.location.pathname).toBe(sourcePath);
      });

      const splitSourceTrigger = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-split-chat-pane]"))
            .find(
              (pane) =>
                pane.querySelector('[data-testid="empty-landing-heading-project-trigger"]') !==
                null,
            )
            ?.querySelector<HTMLElement>('[data-testid="empty-landing-heading-project-trigger"]') ??
          null,
        "Unable to find the source project picker inside the split pane.",
      );
      splitSourceTrigger.click();
      await page.getByText("other", { exact: true }).click();
      await vi.waitFor(() => {
        const splitView = useSplitViewStore.getState().splitViewsById[splitViewId];
        expect(splitView).toBeDefined();
        expect(resolveSplitViewThreadIds(splitView!)).toEqual(
          expect.arrayContaining([THREAD_ID, OTHER_THREAD_ID]),
        );
        expect(resolveSplitViewThreadIds(splitView!)).not.toContain(sourceThreadId);
        expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
      });
      expect(useComposerDraftStore.getState().draftsByThreadId[sourceThreadId]?.prompt).toBe(
        "preserve split source draft",
      );
      expect(useComposerDraftStore.getState().draftsByThreadId[OTHER_THREAD_ID]?.prompt).toBe(
        "preserve split target draft",
      );
      await vi.waitFor(() => {
        expect(document.activeElement?.getAttribute("data-testid")).toBe("composer-editor");
      });

      const splitAfterReplacement = useSplitViewStore.getState().splitViewsById[splitViewId]!;
      const originalServerPaneId = resolveSplitViewPaneIdForThread(
        splitAfterReplacement,
        THREAD_ID,
      );
      expect(originalServerPaneId).not.toBeNull();
      useSplitViewStore
        .getState()
        .replacePaneThread(splitViewId, originalServerPaneId!, sourceThreadId);
      useSplitViewStore.getState().setFocusedPane(splitViewId, originalServerPaneId!);
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: sourceThreadId },
        search: () => ({ splitViewId }),
      });
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(sourcePath);
        expect(
          document.querySelector(
            `form[data-chat-pane-scope="${splitViewPaneScopeId(splitViewId, originalServerPaneId!)}"]`,
          ),
        ).not.toBeNull();
      });

      const existingTargetTrigger = await waitForElement(() => {
        const sourceComposerForm = document.querySelector<HTMLFormElement>(
          `form[data-chat-pane-scope="${splitViewPaneScopeId(splitViewId, originalServerPaneId!)}"]`,
        );
        return (
          sourceComposerForm
            ?.closest("[data-split-chat-pane]")
            ?.querySelector<HTMLElement>('[data-testid="empty-landing-heading-project-trigger"]') ??
          null
        );
      }, "Unable to find the source picker before focusing the existing target pane.");
      existingTargetTrigger.click();
      await page.getByText("other", { exact: true }).click();
      await vi.waitFor(() => {
        const splitView = useSplitViewStore.getState().splitViewsById[splitViewId];
        expect(splitView).toBeDefined();
        expect(resolveSplitViewThreadIds(splitView!).toSorted()).toEqual(
          [sourceThreadId, OTHER_THREAD_ID].toSorted(),
        );
        expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
        expect(splitView?.focusedPaneId).toBe(
          resolveSplitViewPaneIdForThread(splitView!, OTHER_THREAD_ID),
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("coalesces repeated Studio new-chat clicks and stays in Studio after navigation settles", async () => {
    // Studio is hidden by default; this Studio-specific regression test opts in explicitly.
    localStorage.setItem(
      "scient:app-settings:v1",
      JSON.stringify({
        appSettingsVersion: CURRENT_APP_SETTINGS_VERSION,
        showStudioSection: true,
      }),
    );

    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [STUDIO_DRAFT_THREAD_ID]: {
          projectId: STUDIO_PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
          workspaceOrigin: "intentional",
        },
      },
      projectDraftThreadIdByProjectId: {
        [STUDIO_PROJECT_ID]: STUDIO_DRAFT_THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      // Keep one non-Studio server thread in the snapshot. This matches the real failure: Studio
      // has no persisted chats, while the global missing-thread recovery sees known threads and
      // immediately redirects a transiently-cleared Studio draft to the home index.
      snapshot: withStudioProject(
        withHomeChatProject(
          createSnapshotForTargetUser({
            targetMessageId: "msg-user-studio-draft-regression" as MessageId,
            targetText: "projects-side thread",
          }),
        ),
      ),
      initialEntry: `/${STUDIO_DRAFT_THREAD_ID}`,
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
          studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
        };
      },
    });

    try {
      const newStudioChatButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="New studio chat"]'),
        "Unable to find the Studio new-chat action.",
      );
      newStudioChatButton.click();
      newStudioChatButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "A fresh Studio chat should navigate to a new draft UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: STUDIO_PROJECT_ID,
            entryPoint: "chat",
          });
          expect(
            useComposerDraftStore.getState().projectDraftThreadIdByProjectId[HOME_PROJECT_ID],
          ).toBeUndefined();
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
        },
        { timeout: 8_000, interval: 16 },
      );

      // A superseded navigation resolves the older navigate() promise before the newer route has
      // committed. Give route effects enough time to expose a late Home redirect, then assert the
      // stable final state and cleanup of the displaced Studio draft.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
      await vi.waitFor(
        () => {
          const state = useComposerDraftStore.getState();
          const studioDraftIds = Object.entries(state.draftThreadsByThreadId)
            .filter(([, draft]) => draft.projectId === STUDIO_PROJECT_ID)
            .map(([threadId]) => threadId);
          expect(mounted.router.state.status).toBe("idle");
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
          expect(state.getDraftThread(STUDIO_DRAFT_THREAD_ID)).toBeNull();
          expect(studioDraftIds).toEqual([newThreadId]);
          expect(state.projectDraftThreadIdByProjectId[STUDIO_PROJECT_ID]).toBe(newThreadId);
          expect(state.projectDraftThreadIdByProjectId[HOME_PROJECT_ID]).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("can detach an empty project draft back to a normal chat before first send", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withHomeChatProject(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-home-test" as MessageId,
          targetText: "project picker home test",
        }),
      ),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        };
      },
    });

    try {
      const newThreadButton = page.getByLabelText("Create new thread in Project");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      const projectPickerTrigger = page.getByTestId("empty-landing-heading-project-trigger");
      await expect.element(projectPickerTrigger).toBeInTheDocument();
      await projectPickerTrigger.click();
      await page.getByText("Don't work in a project").click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: HOME_PROJECT_ID,
            envMode: "local",
            branch: null,
            worktreePath: null,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect.element(page.getByTestId("workspace-picker-trigger")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps an unsent project draft when Home is being removed", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withHomeChatProject(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-home-removal" as MessageId,
          targetText: "project picker Home removal",
        }),
      ),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        };
      },
    });
    const reservation = reserveProjectRemoval(HOME_PROJECT_ID);
    expect(reservation).not.toBeNull();

    try {
      await page.getByLabelText("Create new thread in Project").click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      useComposerDraftStore.getState().setPrompt(newThreadId, "keep my unsent Home switch");

      await page.getByTestId("empty-landing-heading-project-trigger").click();
      await page.getByText("Don't work in a project").click();

      await expect
        .element(
          page.getByText(
            "That project is being removed. Your draft stayed in its current project.",
          ),
        )
        .toBeInTheDocument();
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
        projectId: PROJECT_ID,
      });
      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.prompt).toBe(
        "keep my unsent Home switch",
      );
      expect(hasActiveProjectOperations(HOME_PROJECT_ID)).toBe(false);
    } finally {
      if (reservation) releaseProjectRemoval(reservation);
      await mounted.cleanup();
    }
  });

  it("navigates to a promoting Home draft instead of replacing its recovery state", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withHomeChatProject(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-occupied-home" as MessageId,
          targetText: "project picker occupied home",
        }),
      ),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        };
      },
    });

    try {
      await page.getByLabelText("Create new thread in Project").click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new project draft UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      useComposerDraftStore.getState().setProjectDraftThreadId(HOME_PROJECT_ID, OTHER_THREAD_ID);
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "keep occupied Home draft");
      useComposerDraftStore.getState().markDraftThreadPromoting(OTHER_THREAD_ID);

      await page.getByTestId("empty-landing-heading-project-trigger").click();
      await page.getByText("Don't work in a project").click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: PROJECT_ID,
          });
          expect(useComposerDraftStore.getState().getDraftThread(OTHER_THREAD_ID)).toMatchObject({
            projectId: HOME_PROJECT_ID,
            promotedTo: OTHER_THREAD_ID,
          });
          expect(useComposerDraftStore.getState().draftsByThreadId[OTHER_THREAD_ID]?.prompt).toBe(
            "keep occupied Home draft",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("moves a home draft into an existing project from the home picker without carrying branch", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: HOME_PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
          workspaceOrigin: "intentional",
        },
      },
      projectDraftThreadIdByProjectId: {
        [HOME_PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withStudioProject(withHomeChatProject(createDraftOnlySnapshot())),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        };
        nextFixture.gitBranchByCwd = {
          "/Users/tester": "home-main",
          "/repo/project": "main",
        };
      },
    });

    try {
      const workspacePickerTrigger = page.getByTestId("workspace-picker-trigger");
      await expect.element(workspacePickerTrigger).toBeInTheDocument();
      const controlsBefore = document.querySelector<HTMLElement>(
        'form[data-chat-composer-form="true"] + .chat-composer-shell',
      );
      const composerBlockBefore = document.querySelector<HTMLElement>(
        '[data-empty-landing-composer-block="true"]',
      );
      expect(controlsBefore).not.toBeNull();
      expect(composerBlockBefore).not.toBeNull();
      const beforeRect = controlsBefore!.getBoundingClientRect();
      const composerBlockBeforeRect = composerBlockBefore!.getBoundingClientRect();
      await workspacePickerTrigger.click();
      const projectSearch = page.getByPlaceholder("Search projects");
      await projectSearch.fill("project");
      await vi.waitFor(() => {
        expect(document.querySelectorAll('[data-slot="combobox-item"]')).toHaveLength(1);
      });
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => {
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[placeholder="Search projects"]',
        );
        expect(document.activeElement).toBe(searchInput);
        expect(searchInput?.getAttribute("aria-activedescendant")).toBeTruthy();
        expect(
          document.querySelector<HTMLElement>('[data-slot="combobox-item"][data-highlighted]')
            ?.textContent,
        ).toContain("project");
      });
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="combobox-popup"]')).toBeNull();
      });

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(THREAD_ID)).toMatchObject({
            projectId: PROJECT_ID,
            envMode: "local",
            branch: null,
            worktreePath: null,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect
        .element(page.getByTestId("empty-landing-heading-project-trigger"))
        .toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Local" })).toBeInTheDocument();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const controlsAfter = document.querySelector<HTMLElement>(
        'form[data-chat-composer-form="true"] + .chat-composer-shell',
      );
      const composerBlockAfter = document.querySelector<HTMLElement>(
        '[data-empty-landing-composer-block="true"]',
      );
      expect(controlsAfter).not.toBeNull();
      expect(composerBlockAfter).not.toBeNull();
      const afterRect = controlsAfter!.getBoundingClientRect();
      const composerBlockAfterRect = composerBlockAfter!.getBoundingClientRect();
      // Guard against the empty-pane entry animation restarting with a vertical translate
      // when Home selection turns into a project draft.
      expect(
        Math.round(Math.abs(afterRect.height - beforeRect.height)),
        `Composer controls changed height ${beforeRect.height}px -> ${afterRect.height}px`,
      ).toBeLessThanOrEqual(1);
      expect(Math.round(Math.abs(afterRect.top - beforeRect.top))).toBeLessThanOrEqual(1);
      expect(
        Math.round(Math.abs(composerBlockAfterRect.top - composerBlockBeforeRect.top)),
      ).toBeLessThanOrEqual(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps an unsent draft in its source project when the picker target is being removed", async () => {
    const prompt = "keep this draft outside the project being removed";
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: HOME_PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
          workspaceOrigin: "intentional",
        },
      },
      projectDraftThreadIdByProjectId: { [HOME_PROJECT_ID]: THREAD_ID },
    });
    useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withStudioProject(withHomeChatProject(createDraftOnlySnapshot())),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        };
      },
      configureNativeApi: (api) => ({
        ...api,
        projects: {
          ...api.projects,
          // The workspace picker lists home-directory folders on open. Without a resolving mock the
          // load rejects, and its "Unable to load folders." error (plus the effect's `setErrorMessage(null)`
          // reset when it re-runs on reopen) would clobber the project-removal feedback this test asserts.
          // Return a non-project folder so `directoryEntries` stays populated and the reopen effect
          // short-circuits, mirroring a real home directory that has folders.
          listDirectories: vi.fn(async () => ({
            entries: [
              {
                path: "Reference",
                name: "Reference",
                kind: "directory" as const,
                hasChildren: false,
              },
            ],
          })),
        },
      }),
    });
    const reservation = reserveProjectRemoval(PROJECT_ID);
    expect(reservation).not.toBeNull();

    try {
      await page.getByTestId("workspace-picker-trigger").click();
      const projectSearch = page.getByPlaceholder("Search projects");
      await projectSearch.fill("project");
      // The base-ui combobox registers its highlight a tick after ArrowDown, so split the
      // keystrokes and wait for `aria-activedescendant`/`data-highlighted` before Enter — firing
      // them back-to-back lets Enter run before any item is highlighted, selecting nothing.
      await vi.waitFor(() => {
        expect(document.querySelectorAll('[data-slot="combobox-item"]')).toHaveLength(1);
      });
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => {
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[placeholder="Search projects"]',
        );
        expect(document.activeElement).toBe(searchInput);
        expect(searchInput?.getAttribute("aria-activedescendant")).toBeTruthy();
        expect(
          document.querySelector<HTMLElement>('[data-slot="combobox-item"][data-highlighted]')
            ?.textContent,
        ).toContain("project");
      });
      await userEvent.keyboard("{Enter}");

      await expect
        .element(
          page.getByText(
            "That project is being removed. Your draft stayed in its current project.",
          ),
        )
        .toBeInTheDocument();
      expect(useComposerDraftStore.getState().getDraftThread(THREAD_ID)).toMatchObject({
        projectId: HOME_PROJECT_ID,
      });
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(prompt);
      expect(useComposerDraftStore.getState().projectDraftThreadIdByProjectId[PROJECT_ID]).toBe(
        undefined,
      );
      expect(hasActiveProjectOperations(PROJECT_ID)).toBe(false);
    } finally {
      if (reservation) releaseProjectRemoval(reservation);
      await mounted.cleanup();
    }
  });

  it("keeps an unsent draft when the folder picker resolves to a project being removed", async () => {
    const pickFolder = vi.fn(async () => "/repo/other");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withOpenProjectPickerFixtures(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-folder-removal" as MessageId,
          targetText: "folder picker removal source",
        }),
      ),
      configureNativeApi: (api) => ({
        ...api,
        dialogs: { ...api.dialogs, pickFolder },
      }),
    });
    const reservation = reserveProjectRemoval(OTHER_PROJECT_ID);
    expect(reservation).not.toBeNull();

    try {
      await page.getByLabelText("Create new thread in Project").click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      useComposerDraftStore.getState().setPrompt(newThreadId, "keep folder-picker draft");

      await page.getByTestId("empty-landing-heading-project-trigger").click();
      await page.getByText("New project").click();
      await vi.waitFor(() => expect(pickFolder).toHaveBeenCalledTimes(1));

      await expect
        .element(
          page.getByText(
            "That project is being removed. Your draft stayed in its current project.",
          ),
        )
        .toBeInTheDocument();
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
        projectId: PROJECT_ID,
      });
      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.prompt).toBe(
        "keep folder-picker draft",
      );
      expect(
        useComposerDraftStore.getState().projectDraftThreadIdByProjectId[OTHER_PROJECT_ID],
      ).toBe(undefined);
      expect(hasActiveProjectOperations(OTHER_PROJECT_ID)).toBe(false);
    } finally {
      if (reservation) releaseProjectRemoval(reservation);
      await mounted.cleanup();
    }
  });

  it("keeps a container draft intact when its resolved target project is being removed", async () => {
    const prompt = "preserve this cross-project first send";
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: HOME_PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: "main",
          worktreePath: "/repo/project",
          envMode: "worktree",
          workspaceOrigin: "intentional",
        },
      },
      projectDraftThreadIdByProjectId: { [HOME_PROJECT_ID]: THREAD_ID },
    });
    useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
    const createWorktree = vi.fn<NativeApi["git"]["createWorktree"]>();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withHomeChatProject(createDraftOnlySnapshot()),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        };
      },
      configureNativeApi: (api) => ({
        ...api,
        git: { ...api.git, createWorktree },
      }),
    });
    const reservation = reserveProjectRemoval(PROJECT_ID);
    expect(reservation).not.toBeNull();
    const requestStart = wsRequests.length;

    try {
      await userEvent.click(await waitForSendButton());
      await expect
        .element(
          page.getByText(
            "The destination project is being removed. Your message and attachments were kept.",
          ),
        )
        .toBeInTheDocument();
      expect(useComposerDraftStore.getState().getDraftThread(THREAD_ID)).toMatchObject({
        projectId: HOME_PROJECT_ID,
        worktreePath: "/repo/project",
      });
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(prompt);
      expect(createWorktree).not.toHaveBeenCalled();
      expect(
        wsRequests
          .slice(requestStart)
          .map(readDispatchedCommand)
          .some((command) => command?.type === "thread.create"),
      ).toBe(false);
      await vi.waitFor(() => expect(hasActiveProjectOperations(HOME_PROJECT_ID)).toBe(false));
      expect(hasActiveProjectOperations(PROJECT_ID)).toBe(false);
    } finally {
      if (reservation) releaseProjectRemoval(reservation);
      await mounted.cleanup();
    }
  });

  it("creates and selects a new project from an empty project draft without navigating away", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-project-picker-new-test" as MessageId,
        targetText: "project picker new test",
      }),
    });
    const previousNativeApi = window.nativeApi;
    const wsNativeApi = readNativeApi();
    expect(wsNativeApi).toBeDefined();
    const pickFolder = vi.fn(async () => "/repo/new-project");
    let createdProjectId: ProjectId | null = null;
    const dispatchCommand = vi.fn(async (command: unknown) => {
      wsRequests.push({
        _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
        command,
      });
      if (recordProjectCreateCommand(command)) {
        if (command && typeof command === "object" && "projectId" in command) {
          createdProjectId = command.projectId as ProjectId;
        }
        return { sequence: fixture.snapshot.snapshotSequence };
      }
      return { sequence: fixture.snapshot.snapshotSequence + 1 };
    });
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...wsNativeApi,
        dialogs: {
          ...wsNativeApi?.dialogs,
          pickFolder,
        },
        orchestration: {
          ...wsNativeApi?.orchestration,
          dispatchCommand,
          getShellSnapshot: vi.fn(async () => createShellSnapshotFromReadModel(fixture.snapshot)),
        },
      },
    });
    try {
      const newThreadButton = page.getByLabelText("Create new thread in Project");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      const projectPickerTrigger = page.getByTestId("empty-landing-heading-project-trigger");
      await expect.element(projectPickerTrigger).toBeInTheDocument();
      await projectPickerTrigger.click();
      await page.getByText("New project").click();
      await vi.waitFor(() => {
        expect(pickFolder).toHaveBeenCalledTimes(1);
      });

      await vi.waitFor(
        () => {
          const projectCreateRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              "command" in request &&
              request.command &&
              typeof request.command === "object" &&
              "type" in request.command &&
              request.command.type === "project.create" &&
              "workspaceRoot" in request.command &&
              request.command.workspaceRoot === "/repo/new-project",
          );
          expect(projectCreateRequest).toBeDefined();
          expect(createdProjectId).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: createdProjectId,
            envMode: "local",
            branch: null,
            worktreePath: null,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
    } finally {
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
      await mounted.cleanup();
    }
  });

  it("does not let late project creation mutate a draft after same-ID promotion", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-project-picker-navigation-race" as MessageId,
        targetText: "project picker navigation race",
      }),
    });
    const previousNativeApi = window.nativeApi;
    const wsNativeApi = readNativeApi();
    expect(wsNativeApi).toBeDefined();
    const pickFolder = vi.fn(async () => "/repo/slow-navigation-project");
    let createdProjectId: ProjectId | null = null;
    let slowCreateSettled = false;
    let releaseSlowCreate!: () => void;
    const slowCreateGate = new Promise<void>((resolve) => {
      releaseSlowCreate = resolve;
    });
    const dispatchCommand = vi.fn(async (command: unknown) => {
      wsRequests.push({
        _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
        command,
      });
      if (recordProjectCreateCommand(command)) {
        if (command && typeof command === "object" && "projectId" in command) {
          createdProjectId = command.projectId as ProjectId;
        }
        await slowCreateGate;
        slowCreateSettled = true;
        return { sequence: fixture.snapshot.snapshotSequence };
      }
      return { sequence: fixture.snapshot.snapshotSequence + 1 };
    });
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...wsNativeApi,
        dialogs: { ...wsNativeApi?.dialogs, pickFolder },
        orchestration: {
          ...wsNativeApi?.orchestration,
          dispatchCommand,
          getShellSnapshot: vi.fn(async () => createShellSnapshotFromReadModel(fixture.snapshot)),
        },
      },
    });

    try {
      await page.getByLabelText("Create new thread in Project").click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await page.getByTestId("empty-landing-heading-project-trigger").click();
      await page.getByText("New project").click();
      await vi.waitFor(() => expect(createdProjectId).not.toBeNull());
      await expect.element(page.getByText("New project")).not.toBeInTheDocument();
      useComposerDraftStore.getState().setPrompt(newThreadId, "keep this in the chosen project");
      const sendRequestStart = wsRequests.length;
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      expect(
        wsRequests
          .slice(sendRequestStart)
          .some((request) => readDispatchedCommand(request)?.type === "thread.create"),
      ).toBe(false);
      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.prompt).toBe(
        "keep this in the chosen project",
      );
      useComposerDraftStore.getState().markDraftThreadPromoting(newThreadId);

      releaseSlowCreate();
      await vi.waitFor(() => {
        expect(slowCreateSettled).toBe(true);
      });
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
        projectId: PROJECT_ID,
        promotedTo: newThreadId,
      });
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)?.projectId).not.toBe(
        createdProjectId,
      );
    } finally {
      releaseSlowCreate();
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
      await mounted.cleanup();
    }
  });

  it("releases the send gate and rejects a late native picker after same-pane navigation", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withOpenProjectPickerFixtures(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-dialog-race" as MessageId,
          targetText: "project picker dialog race",
        }),
      ),
    });
    const previousNativeApi = window.nativeApi;
    const wsNativeApi = readNativeApi();
    expect(wsNativeApi).toBeDefined();
    let releasePickFolder!: () => void;
    const pickFolderGate = new Promise<void>((resolve) => {
      releasePickFolder = resolve;
    });
    const pickFolder = vi.fn(async () => {
      await pickFolderGate;
      return "/repo/stale-picker-project";
    });
    const dispatchCommand = vi.fn(async (command: unknown) => {
      wsRequests.push({
        _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
        command,
      });
      return { sequence: fixture.snapshot.snapshotSequence + 1 };
    });
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...wsNativeApi,
        dialogs: { ...wsNativeApi?.dialogs, pickFolder },
        orchestration: { ...wsNativeApi?.orchestration, dispatchCommand },
      },
    });
    const requestStart = wsRequests.length;

    try {
      await page.getByLabelText("Create new thread in Project").click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await page.getByTestId("empty-landing-heading-project-trigger").click();
      await page.getByText("New project").click();
      await vi.waitFor(() => expect(pickFolder).toHaveBeenCalledTimes(1));

      const destinationThreadId = "00000000-0000-4000-8000-000000000128" as ThreadId;
      useComposerDraftStore.getState().registerDraftThread(destinationThreadId, {
        projectId: OTHER_PROJECT_ID,
        createdAt: NOW_ISO,
      });
      useComposerDraftStore.getState().setModelSelection(destinationThreadId, {
        provider: "codex",
        model: "gpt-5",
      });
      useComposerDraftStore
        .getState()
        .setPrompt(destinationThreadId, "send while the previous picker is still pending");
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: destinationThreadId },
      });
      await waitForURL(
        mounted.router,
        (path) => path === `/${destinationThreadId}`,
        "The destination draft should be selected while the native picker is pending.",
      );

      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(() => {
        expect(composerEditor.textContent ?? "").toContain(
          "send while the previous picker is still pending",
        );
      });
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await sendButton.click();
      await vi.waitFor(
        () => {
          expect(
            wsRequests.some((request) => {
              const command = readDispatchedCommand(request);
              return command?.type === "thread.create" && command.threadId === destinationThreadId;
            }),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      releasePickFolder();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      expect(
        wsRequests
          .slice(requestStart)
          .some(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              "command" in request &&
              request.command &&
              typeof request.command === "object" &&
              "type" in request.command &&
              request.command.type === "project.create",
          ),
      ).toBe(false);
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
        projectId: PROJECT_ID,
      });
    } finally {
      releasePickFolder();
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
      await mounted.cleanup();
    }
  });

  it("does not move a draft while its first send is still in provider preflight", async () => {
    const unavailableProvider = {
      provider: "codex" as const,
      status: "error" as const,
      available: false,
      authStatus: "unauthenticated" as const,
      message: "Codex is temporarily unavailable.",
      checkedAt: NOW_ISO,
    };
    const availableProvider = {
      provider: "codex" as const,
      status: "ready" as const,
      available: true,
      authStatus: "authenticated" as const,
      checkedAt: NOW_ISO,
      runtime: {
        source: "system" as const,
        managedVersion: null,
        canInstall: false,
        canRepair: false,
        canRollback: false,
        canRemove: false,
        message: null,
      },
    };
    let resolveProviderRefresh!: (value: { providers: [typeof availableProvider] }) => void;
    const providerRefresh = new Promise<{ providers: [typeof availableProvider] }>((resolve) => {
      resolveProviderRefresh = resolve;
    });
    const refreshProviders = vi.fn<NativeApi["server"]["refreshProviders"]>(() => providerRefresh);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withOpenProjectPickerFixtures(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-send-race" as MessageId,
          targetText: "project picker send race",
        }),
      ),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [unavailableProvider],
        };
      },
      configureNativeApi: (api) => ({
        ...api,
        server: {
          ...api.server,
          refreshProviders,
        },
      }),
    });

    try {
      await waitForServerConfigToApply();
      await page.getByLabelText("Create new thread in Project").click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      await waitForDraftNavigationIdle(draftNavigationSlotKey());
      useComposerDraftStore.getState().setModelSelection(newThreadId, {
        provider: "codex",
        model: "gpt-5",
      });
      useComposerDraftStore
        .getState()
        .setPrompt(newThreadId, "keep this send in the original project");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(() => {
        expect(composerEditor.textContent ?? "").toContain(
          "keep this send in the original project",
        );
      });
      await page.getByTestId("empty-landing-heading-project-trigger").click();
      const otherProjectOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')).find(
            (item) => item.textContent?.trim() === "other",
          ) ?? null,
        "Unable to find the Other Project picker option.",
      );
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      // Start the send and choose the already-open project option in the same
      // task. This reproduces the rapid reverse-order race before React hides
      // the empty-draft landing for provider preflight.
      composerForm.requestSubmit();
      otherProjectOption.click();
      await vi.waitFor(() => expect(refreshProviders).toHaveBeenCalledOnce());
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
        projectId: PROJECT_ID,
      });

      resolveProviderRefresh({ providers: [availableProvider] });
      await vi.waitFor(
        () => {
          const createCommand = wsRequests
            .map(readDispatchedCommand)
            .find(
              (command) => command?.type === "thread.create" && command.threadId === newThreadId,
            );
          expect(createCommand).toMatchObject({
            projectId: PROJECT_ID,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      resolveProviderRefresh({ providers: [availableProvider] });
      await mounted.cleanup();
    }
  });

  it("rejects a raw workspace choice while that draft is still in provider preflight", async () => {
    const unavailableProvider = {
      provider: "codex" as const,
      status: "error" as const,
      available: false,
      authStatus: "unauthenticated" as const,
      message: "Codex is temporarily unavailable.",
      checkedAt: NOW_ISO,
    };
    const availableProvider = {
      provider: "codex" as const,
      status: "ready" as const,
      available: true,
      authStatus: "authenticated" as const,
      checkedAt: NOW_ISO,
      runtime: {
        source: "system" as const,
        managedVersion: null,
        canInstall: false,
        canRepair: false,
        canRollback: false,
        canRemove: false,
        message: null,
      },
    };
    let resolveProviderRefresh!: (value: { providers: [typeof availableProvider] }) => void;
    const providerRefresh = new Promise<{ providers: [typeof availableProvider] }>((resolve) => {
      resolveProviderRefresh = resolve;
    });
    const refreshProviders = vi.fn<NativeApi["server"]["refreshProviders"]>(() => providerRefresh);
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: HOME_PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
          workspaceOrigin: "intentional",
        },
      },
      projectDraftThreadIdByProjectId: { [HOME_PROJECT_ID]: THREAD_ID },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withHomeChatProject(createDraftOnlySnapshot()),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        };
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [unavailableProvider],
        };
      },
      configureNativeApi: (api) => ({
        ...api,
        projects: {
          ...api.projects,
          listDirectories: vi.fn(async () => ({
            entries: [
              {
                path: "Race Folder",
                name: "Race Folder",
                kind: "directory" as const,
                hasChildren: false,
              },
            ],
          })),
        },
        server: { ...api.server, refreshProviders },
      }),
    });
    try {
      await waitForServerConfigToApply();
      useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
        provider: "codex",
        model: "gpt-5",
      });
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "send from the original Home scope");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(() => {
        expect(composerEditor.textContent ?? "").toContain("send from the original Home scope");
      });

      const workspacePickerTrigger = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="workspace-picker-trigger"]'),
        "Unable to find the Home workspace picker before the send race.",
      );
      workspacePickerTrigger.click();
      const rawFolderOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')).find(
            (item) => item.textContent?.trim() === "Race Folder",
          ) ?? null,
        "Unable to find the raw workspace option.",
      );
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();
      rawFolderOption.click();

      await vi.waitFor(() => expect(refreshProviders).toHaveBeenCalledOnce());
      const pickerError = await waitForElement(
        () => document.querySelector<HTMLElement>('[role="alert"]'),
        "The rejected workspace mutation should reopen the picker with an error.",
      );
      expect(pickerError.textContent).toContain("Wait for the current message to finish preparing");
      expect(useComposerDraftStore.getState().getDraftThread(THREAD_ID)).toMatchObject({
        projectId: HOME_PROJECT_ID,
        envMode: "local",
        worktreePath: null,
      });

      resolveProviderRefresh({ providers: [availableProvider] });
      await vi.waitFor(
        () => {
          const createCommand = wsRequests
            .map(readDispatchedCommand)
            .find((command) => command?.type === "thread.create" && command.threadId === THREAD_ID);
          expect(createCommand).toMatchObject({
            envMode: "local",
            worktreePath: null,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      resolveProviderRefresh({ providers: [availableProvider] });
      await mounted.cleanup();
    }
  });

  it("lets the next same-pane draft change projects while the previous draft send is pending", async () => {
    const unavailableProvider = {
      provider: "codex" as const,
      status: "error" as const,
      available: false,
      authStatus: "unauthenticated" as const,
      message: "Codex is temporarily unavailable.",
      checkedAt: NOW_ISO,
    };
    const availableProvider = {
      provider: "codex" as const,
      status: "ready" as const,
      available: true,
      authStatus: "authenticated" as const,
      checkedAt: NOW_ISO,
      runtime: {
        source: "system" as const,
        managedVersion: null,
        canInstall: false,
        canRepair: false,
        canRollback: false,
        canRemove: false,
        message: null,
      },
    };
    let resolveProviderRefresh!: (value: { providers: [typeof availableProvider] }) => void;
    const providerRefresh = new Promise<{ providers: [typeof availableProvider] }>((resolve) => {
      resolveProviderRefresh = resolve;
    });
    const refreshProviders = vi.fn<NativeApi["server"]["refreshProviders"]>(() => providerRefresh);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withHomeChatProject(
        withOpenProjectPickerFixtures(
          createSnapshotForTargetUser({
            targetMessageId: "msg-user-project-picker-thread-owner-race" as MessageId,
            targetText: "project picker thread owner race",
          }),
        ),
      ),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        };
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [unavailableProvider],
        };
      },
      configureNativeApi: (api) => ({
        ...api,
        server: { ...api.server, refreshProviders },
      }),
    });

    try {
      await waitForServerConfigToApply();
      await page.getByLabelText("Create new thread in Project").click();
      const sourcePath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to the source draft.",
      );
      const sourceThreadId = sourcePath.slice(1) as ThreadId;
      useComposerDraftStore.getState().setModelSelection(sourceThreadId, {
        provider: "codex",
        model: "gpt-5",
      });
      useComposerDraftStore.getState().setPrompt(sourceThreadId, "send from source draft");
      useComposerDraftStore.getState().addImages(sourceThreadId, [
        createComposerImage({
          id: "source-preflight-image",
          previewUrl: "blob:source-preflight-image",
          name: "source-preflight-image.png",
        }),
      ]);
      const sourceComposer = await waitForComposerEditor();
      await vi.waitFor(() => {
        expect(sourceComposer.textContent ?? "").toContain("send from source draft");
      });
      const sourceForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find source composer form.",
      );
      sourceForm.requestSubmit();
      await vi.waitFor(() => expect(refreshProviders).toHaveBeenCalledOnce());

      const destinationThreadId = "00000000-0000-4000-8000-000000000129" as ThreadId;
      useComposerDraftStore
        .getState()
        .setProjectDraftThreadId(HOME_PROJECT_ID, destinationThreadId);
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: destinationThreadId },
      });
      await waitForURL(
        mounted.router,
        (path) => path === `/${destinationThreadId}`,
        "The destination draft should own the pane while the source send remains pending.",
      );

      await page.getByTestId("workspace-picker-trigger").click();
      await page.getByText("other", { exact: true }).click();
      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().getDraftThread(destinationThreadId)).toMatchObject({
          projectId: OTHER_PROJECT_ID,
          envMode: "local",
          worktreePath: null,
        });
      });
      expect(useComposerDraftStore.getState().getDraftThread(sourceThreadId)).toMatchObject({
        projectId: PROJECT_ID,
      });
      useComposerDraftStore
        .getState()
        .setPrompt(destinationThreadId, "destination remains independently sendable");

      resolveProviderRefresh({ providers: [availableProvider] });
      await vi.waitFor(
        () => {
          const createCommand = wsRequests
            .map(readDispatchedCommand)
            .find(
              (command) => command?.type === "thread.create" && command.threadId === sourceThreadId,
            );
          expect(createCommand).toMatchObject({ projectId: PROJECT_ID });
        },
        { timeout: 8_000, interval: 16 },
      );
      await vi.waitFor(() => {
        const destinationComposer = document.querySelector<HTMLElement>(
          '[data-testid="composer-editor"]',
        );
        expect(destinationComposer?.textContent ?? "").toContain(
          "destination remains independently sendable",
        );
        expect(document.body.textContent ?? "").not.toContain("send from source draft");
        expect(
          document.querySelector('[aria-label="Preview source-preflight-image.png"]'),
        ).toBeNull();
      });

      const destinationForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find the destination composer after the source preflight completed.",
      );
      destinationForm.requestSubmit();
      await vi.waitFor(
        () => {
          const destinationCreate = wsRequests
            .map(readDispatchedCommand)
            .find(
              (command) =>
                command?.type === "thread.create" && command.threadId === destinationThreadId,
            );
          expect(destinationCreate).toMatchObject({ projectId: OTHER_PROJECT_ID });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      resolveProviderRefresh({ providers: [availableProvider] });
      await mounted.cleanup();
    }
  });

  it("keeps optimistic prompts and previews owned by their source across same-pane navigation", async () => {
    const sourcePrompt = "source optimistic prompt must stay private";
    const destinationPrompt = "destination sends independently";
    const sourcePreviewUrl = "blob:source-owned-optimistic-image";
    let releaseSourceTurn!: () => void;
    const sourceTurnGate = new Promise<void>((resolve) => {
      releaseSourceTurn = resolve;
    });
    let sourceAcknowledgedMessage: ChatMessage | null = null;
    const getSourceAcknowledgedMessage = () => sourceAcknowledgedMessage;
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-optimistic-owner-source" as MessageId,
          targetText: "existing source message",
        }),
        OTHER_THREAD_ID,
      ),
      configureNativeApi: (api) => ({
        ...api,
        orchestration: {
          ...api.orchestration,
          dispatchCommand: vi.fn(async (command) => {
            if (command.type === "thread.turn.start" && command.threadId === THREAD_ID) {
              sourceAcknowledgedMessage = {
                id: command.message.messageId,
                role: "user",
                text: command.message.text,
                attachments: command.message.attachments,
                dispatchMode: command.dispatchMode,
                createdAt: command.createdAt,
                streaming: false,
                source: "native",
              };
              await sourceTurnGate;
            }
            return api.orchestration.dispatchCommand(command);
          }),
        },
      }),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, sourcePrompt);
      useComposerDraftStore.getState().addImages(THREAD_ID, [
        createComposerImage({
          id: "source-owned-optimistic-image",
          previewUrl: sourcePreviewUrl,
          name: "source-owned.png",
        }),
      ]);
      (
        await waitForElement(
          () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
          "Unable to find the source composer for optimistic ownership.",
        )
      ).requestSubmit();

      await vi.waitFor(() => {
        expect(getSourceAcknowledgedMessage()).not.toBeNull();
        expect(document.body.textContent ?? "").toContain(sourcePrompt);
        expect(document.querySelector(`img[src="${sourcePreviewUrl}"]`)).not.toBeNull();
      });

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForURL(
        mounted.router,
        (path) => path === `/${OTHER_THREAD_ID}`,
        "Destination thread should own the pane.",
      );
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain(sourcePrompt);
        expect(document.querySelector(`img[src="${sourcePreviewUrl}"]`)).toBeNull();
      });
      const destinationEditor = await waitForComposerEditor();
      destinationEditor.focus();
      await userEvent.keyboard("{ArrowUp}");
      expect(destinationEditor.textContent ?? "").not.toContain(sourcePrompt);

      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, destinationPrompt);
      await vi.waitFor(() => {
        expect(destinationEditor.textContent ?? "").toContain(destinationPrompt);
      });
      (
        await waitForElement(
          () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
          "Unable to find the destination composer.",
        )
      ).requestSubmit();
      await vi.waitFor(() => {
        expect(
          wsRequests
            .map(readDispatchedCommand)
            .some(
              (command) =>
                command?.type === "thread.turn.start" && command.threadId === OTHER_THREAD_ID,
            ),
        ).toBe(true);
      });

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
      });
      await waitForURL(
        mounted.router,
        (path) => path === `/${THREAD_ID}`,
        "Source thread should regain the pane.",
      );
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain(sourcePrompt);
        expect(document.body.textContent ?? "").not.toContain(destinationPrompt);
        expect(document.querySelector(`img[src="${sourcePreviewUrl}"]`)).not.toBeNull();
      });

      const acknowledgedMessage = getSourceAcknowledgedMessage();
      if (!acknowledgedMessage) {
        throw new Error("Source turn acknowledgement was not captured.");
      }

      const splitViewId = useSplitViewStore.getState().createFromDrop({
        sourceThreadId: THREAD_ID,
        ownerProjectId: PROJECT_ID,
        droppedThreadId: OTHER_THREAD_ID,
        direction: "horizontal",
        side: "second",
      });
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
        search: () => ({ splitViewId }),
      });
      await vi.waitFor(() => {
        expect(document.querySelectorAll("[data-split-chat-pane]")).toHaveLength(2);
        const sourceRows = document.querySelectorAll(
          `[data-message-id="${acknowledgedMessage.id}"]`,
        );
        expect(sourceRows).toHaveLength(1);
        const sourcePane = sourceRows[0]!.closest<HTMLElement>("[data-split-chat-pane]");
        expect(sourcePane?.textContent ?? "").toContain(sourcePrompt);
        expect(sourcePane?.querySelector(`img[src="${sourcePreviewUrl}"]`)).not.toBeNull();
        const destinationPane = Array.from(
          document.querySelectorAll<HTMLElement>("[data-split-chat-pane]"),
        ).find((pane) => pane !== sourcePane);
        expect(destinationPane).toBeDefined();
        expect(destinationPane?.textContent ?? "").not.toContain(sourcePrompt);
        expect(destinationPane?.querySelector(`img[src="${sourcePreviewUrl}"]`)).toBeNull();
        expect(revokeObjectUrl).not.toHaveBeenCalledWith(sourcePreviewUrl);
      });

      releaseSourceTurn();
      await vi.waitFor(() => {
        expect(
          wsRequests
            .map(readDispatchedCommand)
            .some(
              (command) => command?.type === "thread.turn.start" && command.threadId === THREAD_ID,
            ),
        ).toBe(true);
      });
      useStore.setState((state) => {
        const existingMessageIds = state.messageIdsByThreadId?.[THREAD_ID] ?? [];
        const existingMessagesById = state.messageByThreadId?.[THREAD_ID] ?? {};
        return {
          messageIdsByThreadId: {
            ...state.messageIdsByThreadId,
            [THREAD_ID]: [...existingMessageIds, acknowledgedMessage.id],
          },
          messageByThreadId: {
            ...state.messageByThreadId,
            [THREAD_ID]: {
              ...existingMessagesById,
              [acknowledgedMessage.id]: acknowledgedMessage,
            },
          },
        };
      });
      await vi.waitFor(
        () => {
          expect(
            document.querySelectorAll(`[data-message-id="${acknowledgedMessage.id}"]`),
          ).toHaveLength(1);
          expect(revokeObjectUrl).toHaveBeenCalledWith(sourcePreviewUrl);
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(revokeObjectUrl.mock.calls.filter(([url]) => url === sourcePreviewUrl)).toHaveLength(
        1,
      );
    } finally {
      releaseSourceTurn();
      revokeObjectUrl.mockRestore();
      await mounted.cleanup();
    }
  });

  it("removes a failed optimistic send without overwriting newer composer content", async () => {
    const failedPreviewUrl = "blob:failed-send-preview";
    const newerPreviewUrl = "blob:newer-composer-preview";
    let releaseTurnStart!: () => void;
    const turnStartGate = new Promise<void>((resolve) => {
      releaseTurnStart = resolve;
    });
    let turnStartHeld = false;
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-failed-optimistic-owner" as MessageId,
        targetText: "existing message",
      }),
      configureNativeApi: (api) => ({
        ...api,
        orchestration: {
          ...api.orchestration,
          dispatchCommand: vi.fn(async (command) => {
            if (command.type === "thread.turn.start" && command.threadId === THREAD_ID) {
              turnStartHeld = true;
              await turnStartGate;
              throw new Error("deterministic held pre-turn failure");
            }
            return api.orchestration.dispatchCommand(command);
          }),
        },
      }),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "failed outgoing prompt");
      useComposerDraftStore.getState().addImages(THREAD_ID, [
        createComposerImage({
          id: "failed-send-image",
          previewUrl: failedPreviewUrl,
          name: "failed-send.png",
        }),
      ]);
      (
        await waitForElement(
          () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
          "Unable to find the composer before the held failure.",
        )
      ).requestSubmit();

      await vi.waitFor(() => {
        expect(turnStartHeld).toBe(true);
        expect(useOptimisticUserMessageStore.getState().messagesByThreadId[THREAD_ID]).toHaveLength(
          1,
        );
      });
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "newer untouched prompt");
      useComposerDraftStore.getState().addImages(THREAD_ID, [
        createComposerImage({
          id: "newer-composer-image",
          previewUrl: newerPreviewUrl,
          name: "newer.png",
        }),
      ]);

      releaseTurnStart();
      await vi.waitFor(() => {
        expect(
          useOptimisticUserMessageStore.getState().messagesByThreadId[THREAD_ID],
        ).toBeUndefined();
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toMatchObject({
          prompt: "newer untouched prompt",
          images: [{ id: "newer-composer-image", previewUrl: newerPreviewUrl }],
        });
      });
      expect(revokeObjectUrl.mock.calls.filter(([url]) => url === failedPreviewUrl)).toHaveLength(
        1,
      );
      expect(revokeObjectUrl).not.toHaveBeenCalledWith(newerPreviewUrl);
    } finally {
      releaseTurnStart();
      revokeObjectUrl.mockRestore();
      await mounted.cleanup();
    }
  });

  it("keeps the same-thread send gate when provider preflight crosses a split remount", async () => {
    const unavailableProvider = {
      provider: "codex" as const,
      status: "error" as const,
      available: false,
      authStatus: "unauthenticated" as const,
      message: "Codex is temporarily unavailable.",
      checkedAt: NOW_ISO,
    };
    const availableProvider = {
      provider: "codex" as const,
      status: "ready" as const,
      available: true,
      authStatus: "authenticated" as const,
      checkedAt: NOW_ISO,
      runtime: {
        source: "system" as const,
        managedVersion: null,
        canInstall: false,
        canRepair: false,
        canRollback: false,
        canRemove: false,
        message: null,
      },
    };
    let resolveProviderRefresh!: (value: { providers: [typeof availableProvider] }) => void;
    const providerRefresh = new Promise<{ providers: [typeof availableProvider] }>((resolve) => {
      resolveProviderRefresh = resolve;
    });
    const refreshProviders = vi.fn<NativeApi["server"]["refreshProviders"]>(() => providerRefresh);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withOpenProjectPickerFixtures(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-split-preflight" as MessageId,
          targetText: "project picker split preflight",
        }),
      ),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [unavailableProvider],
        };
      },
      configureNativeApi: (api) => ({
        ...api,
        server: { ...api.server, refreshProviders },
      }),
    });

    try {
      await waitForServerConfigToApply();
      await page.getByLabelText("Create new thread in Project").click();
      const sourcePath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to the split-preflight source draft.",
      );
      const sourceThreadId = sourcePath.slice(1) as ThreadId;
      useComposerDraftStore.getState().setModelSelection(sourceThreadId, {
        provider: "codex",
        model: "gpt-5",
      });
      useComposerDraftStore
        .getState()
        .setPrompt(sourceThreadId, "one send must survive the split remount");
      const sourceForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find the source composer before splitting during preflight.",
      );
      sourceForm.requestSubmit();
      await vi.waitFor(() => expect(refreshProviders).toHaveBeenCalledOnce());

      const splitViewId = useSplitViewStore.getState().createFromThread({
        sourceThreadId,
        ownerProjectId: PROJECT_ID,
      });
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: sourceThreadId },
        search: () => ({ splitViewId }),
      });
      await vi.waitFor(() => {
        expect(document.querySelectorAll("[data-split-chat-pane]")).toHaveLength(2);
      });

      const remountedSourcePane = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-split-chat-pane]")).find(
            (pane) =>
              pane.querySelector('[data-testid="empty-landing-heading-project-trigger"]') !== null,
          ) ?? null,
        "Unable to find the remounted source pane.",
      );
      remountedSourcePane
        .querySelector<HTMLElement>('[data-testid="empty-landing-heading-project-trigger"]')!
        .click();
      await page.getByText("other", { exact: true }).click();
      await vi.waitFor(() => {
        expect(document.querySelector<HTMLElement>('[role="alert"]')?.textContent ?? "").toContain(
          "Wait for the current message to finish preparing",
        );
      });
      expect(useComposerDraftStore.getState().getDraftThread(sourceThreadId)).toMatchObject({
        projectId: PROJECT_ID,
      });

      const remountedSourceForm = remountedSourcePane.querySelector<HTMLFormElement>(
        'form[data-chat-composer-form="true"]',
      );
      expect(remountedSourceForm).not.toBeNull();
      remountedSourceForm!.requestSubmit();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 64));
      expect(refreshProviders).toHaveBeenCalledOnce();
      expect(
        wsRequests
          .map(readDispatchedCommand)
          .filter(
            (command) =>
              command?.type === "thread.turn.start" && command.threadId === sourceThreadId,
          ),
      ).toHaveLength(0);

      resolveProviderRefresh({ providers: [availableProvider] });
      await vi.waitFor(
        () => {
          const turnStarts = wsRequests
            .map(readDispatchedCommand)
            .filter(
              (command) =>
                command?.type === "thread.turn.start" && command.threadId === sourceThreadId,
            );
          expect(turnStarts).toHaveLength(1);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      resolveProviderRefresh({ providers: [availableProvider] });
      await mounted.cleanup();
    }
  });

  it("abandons provider preflight when its source thread is deleted", async () => {
    const unavailableProvider = {
      provider: "codex" as const,
      status: "error" as const,
      available: false,
      authStatus: "unauthenticated" as const,
      message: "Codex is temporarily unavailable.",
      checkedAt: NOW_ISO,
    };
    const availableProvider = {
      provider: "codex" as const,
      status: "ready" as const,
      available: true,
      authStatus: "authenticated" as const,
      checkedAt: NOW_ISO,
      runtime: {
        source: "system" as const,
        managedVersion: null,
        canInstall: false,
        canRepair: false,
        canRollback: false,
        canRemove: false,
        message: null,
      },
    };
    let resolveProviderRefresh!: (value: { providers: [typeof availableProvider] }) => void;
    const providerRefresh = new Promise<{ providers: [typeof availableProvider] }>((resolve) => {
      resolveProviderRefresh = resolve;
    });
    const refreshProviders = vi.fn<NativeApi["server"]["refreshProviders"]>(() => providerRefresh);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-deleted-provider-preflight" as MessageId,
        targetText: "deleted provider preflight",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [unavailableProvider],
        };
      },
      configureNativeApi: (api) => ({
        ...api,
        server: { ...api.server, refreshProviders },
      }),
    });
    const deletedThreadIdsBeforeTest = useStore.getState().deletedThreadIdsById ?? {};

    try {
      await waitForServerConfigToApply();
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "do not resurrect this draft");
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find the composer before deleting its pending send.",
      );
      const requestStart = wsRequests.length;
      composerForm.requestSubmit();
      await vi.waitFor(() => expect(refreshProviders).toHaveBeenCalledOnce());

      useStore.getState().removeDeletedThreadFromClientState(THREAD_ID);
      useComposerDraftStore.getState().clearDraftThread(THREAD_ID);
      resolveProviderRefresh({ providers: [availableProvider] });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 64));

      expect(useStore.getState().deletedThreadIdsById?.[THREAD_ID]).toBe(true);
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
      expect(wsRequests.slice(requestStart).map(readDispatchedCommand).filter(Boolean)).toEqual([]);
    } finally {
      resolveProviderRefresh({ providers: [availableProvider] });
      useStore.setState({ deletedThreadIdsById: deletedThreadIdsBeforeTest });
      await mounted.cleanup();
    }
  });

  it("abandons browser capture when its source thread is deleted", async () => {
    let resolveCapture!: (value: {
      name: string;
      mimeType: "image/png";
      sizeBytes: number;
      bytes: Uint8Array;
    }) => void;
    const capture = new Promise<{
      name: string;
      mimeType: "image/png";
      sizeBytes: number;
      bytes: Uint8Array;
    }>((resolve) => {
      resolveCapture = resolve;
    });
    const captureScreenshot = vi.fn<NativeApi["browser"]["captureScreenshot"]>(() => capture);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-deleted-browser-capture" as MessageId,
        targetText: "deleted browser capture",
        sessionStatus: "running",
      }),
      configureNativeApi: (api) => ({
        ...api,
        browser: {
          ...api.browser,
          getState: vi.fn(async () => ({
            threadId: THREAD_ID,
            version: 1,
            open: true,
            activeTabId: "tab-active",
            tabs: [
              {
                id: "tab-active",
                kind: "web" as const,
                url: "https://example.test",
                displayUrl: null,
                title: "Example",
                status: "live" as const,
                isLoading: false,
                canGoBack: false,
                canGoForward: false,
                faviconUrl: null,
                lastCommittedUrl: "https://example.test",
                lastError: null,
              },
            ],
            lastError: null,
          })),
          captureScreenshot,
        },
      }),
    });
    const deletedThreadIdsBeforeTest = useStore.getState().deletedThreadIdsById ?? {};

    try {
      await waitForServerConfigToApply();
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_ID, "look at the active tab in the in-app browser");
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find the composer before the browser-capture deletion race.",
      );
      const requestStart = wsRequests.length;
      composerForm.requestSubmit();
      await vi.waitFor(() => expect(captureScreenshot).toHaveBeenCalledOnce());

      useStore.getState().removeDeletedThreadFromClientState(THREAD_ID);
      useComposerDraftStore.getState().clearDraftThread(THREAD_ID);
      resolveCapture({
        name: "captured-browser.png",
        mimeType: "image/png",
        sizeBytes: 4,
        bytes: new Uint8Array([1, 2, 3, 4]),
      });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 64));

      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
      expect(wsRequests.slice(requestStart).map(readDispatchedCommand).filter(Boolean)).toEqual([]);
    } finally {
      resolveCapture({
        name: "captured-browser.png",
        mimeType: "image/png",
        sizeBytes: 4,
        bytes: new Uint8Array([1, 2, 3, 4]),
      });
      useStore.setState({ deletedThreadIdsById: deletedThreadIdsBeforeTest });
      await mounted.cleanup();
    }
  });

  it("edits and resends a stopped prompt before any assistant answer exists", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithStoppedUnansweredPrompt(),
    });

    try {
      const editButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Edit message"]'),
        "Unable to find Edit for the stopped unanswered prompt.",
      );
      editButton.click();
      const editTextArea = page.getByRole("textbox", { name: "Edit message" });
      await editTextArea.fill("edited stopped prompt");
      const editForm = editTextArea.element().closest("form");
      expect(editForm).not.toBeNull();
      editForm!.requestSubmit();

      await vi.waitFor(() => {
        const editCommands = wsRequests
          .map(readDispatchedCommand)
          .filter((command) => command?.type === "thread.message.edit-and-resend");
        expect(editCommands).toHaveLength(1);
        expect(editCommands[0]).toMatchObject({
          threadId: THREAD_ID,
          messageId: "msg-user-stopped-unanswered",
          text: expect.stringContaining("edited stopped prompt"),
        });
      });

      const acceptedEdit = wsRequests
        .map(readDispatchedCommand)
        .find((command) => command?.type === "thread.message.edit-and-resend");
      expect(acceptedEdit?.type).toBe("thread.message.edit-and-resend");
      const acceptedText = acceptedEdit?.text;
      if (
        acceptedEdit?.type !== "thread.message.edit-and-resend" ||
        typeof acceptedText !== "string"
      ) {
        throw new Error("Missing accepted edit command.");
      }
      const acceptedAt = "2026-08-01T08:00:02.000Z";
      const acceptedSnapshot: OrchestrationReadModel = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                messages: thread.messages.map((message) =>
                  message.id === acceptedEdit.messageId
                    ? { ...message, text: acceptedText, updatedAt: acceptedAt }
                    : message,
                ),
                session: {
                  ...thread.session!,
                  lastError: "A parent-busy rejection arrived after the replacement committed.",
                  lastErrorClass: EDIT_RESEND_PARENT_BUSY_ERROR_CLASS,
                  updatedAt: acceptedAt,
                },
                updatedAt: acceptedAt,
              }
            : thread,
        ),
        updatedAt: acceptedAt,
      };
      fixture = { ...fixture, snapshot: acceptedSnapshot };
      useStore.getState().syncServerReadModel(acceptedSnapshot);

      await vi.waitFor(() => {
        expect(document.querySelector('textarea[aria-label="Edit message"]')).toBeNull();
        expect(useUserMessageEditDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a late-rejected edit recoverable without replaying it", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithStoppedUnansweredPrompt(),
    });
    const replacementText = "replacement retained after the parent becomes busy";
    const rejection =
      "The shared parent session became busy before the edited message could be resent. Your original message was not changed; wait for the parent to finish, then retry the edit.";

    try {
      await page.getByRole("button", { name: "Edit message" }).click();
      const editTextArea = page.getByRole("textbox", { name: "Edit message" });
      await editTextArea.fill(replacementText);
      const editForm = editTextArea.element().closest("form");
      expect(editForm).not.toBeNull();
      editForm!.requestSubmit();

      await vi.waitFor(() => {
        const editCommands = wsRequests
          .map(readDispatchedCommand)
          .filter((command) => command?.type === "thread.message.edit-and-resend");
        expect(editCommands).toHaveLength(1);
        expect(editTextArea.element()).toBeDisabled();
      });

      const unrelatedAt = "2026-08-01T08:00:01.500Z";
      const unrelatedErrorSnapshot: OrchestrationReadModel = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                session: {
                  ...thread.session!,
                  lastError: "An unrelated provider check failed.",
                  lastErrorClass: "provider_error",
                  updatedAt: unrelatedAt,
                },
                updatedAt: unrelatedAt,
              }
            : thread,
        ),
        updatedAt: unrelatedAt,
      };
      fixture = { ...fixture, snapshot: unrelatedErrorSnapshot };
      useStore.getState().syncServerReadModel(unrelatedErrorSnapshot);

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("An unrelated provider check failed.");
        expect(useUserMessageEditDraftStore.getState().draftsByThreadId[THREAD_ID]?.phase).toBe(
          "accepted",
        );
        expect(page.getByRole("textbox", { name: "Edit message" }).element()).toBeDisabled();
      });

      const rejectedAt = "2026-08-01T08:00:02.000Z";
      const rejectedSnapshot: OrchestrationReadModel = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                session: {
                  ...thread.session!,
                  lastError: rejection,
                  lastErrorClass: EDIT_RESEND_PARENT_BUSY_ERROR_CLASS,
                  updatedAt: rejectedAt,
                },
                updatedAt: rejectedAt,
              }
            : thread,
        ),
        updatedAt: rejectedAt,
      };
      fixture = { ...fixture, snapshot: rejectedSnapshot };
      useStore.getState().syncServerReadModel(rejectedSnapshot);

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain(rejection);
        expect(useUserMessageEditDraftStore.getState().draftsByThreadId[THREAD_ID]?.phase).toBe(
          "rejected",
        );
        const recoveredEdit = page.getByRole("textbox", { name: "Edit message" }).element();
        expect(recoveredEdit).not.toBeDisabled();
        expect(recoveredEdit).toHaveValue(replacementText);
        expect(document.activeElement).toBe(recoveredEdit);
        expect(
          wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "thread.message.edit-and-resend"),
        ).toHaveLength(1);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("confirms an unchanged resend through the message revision", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithStoppedUnansweredPrompt(),
    });

    try {
      const requestStart = wsRequests.length;
      await page.getByRole("button", { name: "Edit message" }).click();
      const editTextArea = page.getByRole("textbox", { name: "Edit message" });
      expect(editTextArea).toHaveValue("old stopped prompt");
      const editForm = editTextArea.element().closest("form");
      expect(editForm).not.toBeNull();
      editForm!.requestSubmit();

      await vi.waitFor(() => {
        expect(
          wsRequests
            .slice(requestStart)
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "thread.message.edit-and-resend"),
        ).toHaveLength(1);
      });

      const confirmedAt = "2026-08-01T08:00:03.000Z";
      const confirmedSnapshot: OrchestrationReadModel = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                messages: thread.messages.map((message) =>
                  message.id === "msg-user-stopped-unanswered"
                    ? { ...message, updatedAt: confirmedAt }
                    : message,
                ),
                updatedAt: confirmedAt,
              }
            : thread,
        ),
        updatedAt: confirmedAt,
      };
      fixture = { ...fixture, snapshot: confirmedSnapshot };
      useStore.getState().syncServerReadModel(confirmedSnapshot);

      await vi.waitFor(() => {
        expect(document.querySelector('textarea[aria-label="Edit message"]')).toBeNull();
        expect(useUserMessageEditDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("rejects edit-and-resend while a normal send owns the thread preflight", async () => {
    const unavailableProvider = {
      provider: "codex" as const,
      status: "error" as const,
      available: false,
      authStatus: "unauthenticated" as const,
      message: "Codex is temporarily unavailable.",
      checkedAt: NOW_ISO,
    };
    const availableProvider = {
      provider: "codex" as const,
      status: "ready" as const,
      available: true,
      authStatus: "authenticated" as const,
      checkedAt: NOW_ISO,
      runtime: {
        source: "system" as const,
        managedVersion: null,
        canInstall: false,
        canRepair: false,
        canRollback: false,
        canRemove: false,
        message: null,
      },
    };
    let resolveProviderRefresh!: (value: { providers: [typeof availableProvider] }) => void;
    const providerRefresh = new Promise<{ providers: [typeof availableProvider] }>((resolve) => {
      resolveProviderRefresh = resolve;
    });
    const refreshProviders = vi.fn<NativeApi["server"]["refreshProviders"]>(() => providerRefresh);
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-edit-preflight-lock" as MessageId,
      targetText: "edit preflight lock",
    });
    const snapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: baseSnapshot.threads.map((thread) => ({
        ...thread,
        messages: thread.messages.map((message, index) =>
          index >= thread.messages.length - 2
            ? { ...message, turnId: "turn-edit-preflight-lock" as TurnId }
            : message,
        ),
      })),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [unavailableProvider],
        };
      },
      configureNativeApi: (api) => ({
        ...api,
        server: { ...api.server, refreshProviders },
      }),
    });

    try {
      await waitForServerConfigToApply();
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "normal send owns preflight");
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find the composer before the edit concurrency test.",
      );
      composerForm.requestSubmit();
      await vi.waitFor(() => expect(refreshProviders).toHaveBeenCalledOnce());

      await page.getByRole("button", { name: "Edit message" }).click();
      const editTextArea = page.getByRole("textbox", { name: "Edit message" });
      await editTextArea.fill("edited text must not dispatch concurrently");
      const editForm = editTextArea.element().closest("form");
      expect(editForm).not.toBeNull();
      editForm!.requestSubmit();

      await vi.waitFor(() => {
        const commands = wsRequests.map(readDispatchedCommand);
        expect(commands.some((command) => command?.type === "thread.message.edit-and-resend")).toBe(
          false,
        );
        expect(document.body.textContent ?? "").toContain(
          "Wait for the current send to start before editing.",
        );
      });

      resolveProviderRefresh({ providers: [availableProvider] });
      await vi.waitFor(
        () => {
          const turnStarts = wsRequests
            .map(readDispatchedCommand)
            .filter(
              (command) => command?.type === "thread.turn.start" && command.threadId === THREAD_ID,
            );
          expect(turnStarts).toHaveLength(1);
          expect(turnStarts[0]).toMatchObject({
            message: expect.objectContaining({
              text: expect.stringContaining("normal send owns preflight"),
            }),
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      resolveProviderRefresh({ providers: [availableProvider] });
      await mounted.cleanup();
    }
  });

  it("abandons a plan follow-up when settings persistence outlives thread deletion", async () => {
    let resolveSettings!: () => void;
    const settingsGate = new Promise<void>((resolve) => {
      resolveSettings = resolve;
    });
    let delayedSettingsStarted = false;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSettledPlanAwaitingFollowUp(),
      configureNativeApi: (api) => ({
        ...api,
        orchestration: {
          ...api.orchestration,
          dispatchCommand: vi.fn(async (command) => {
            if (command.type === "thread.interaction-mode.set") {
              delayedSettingsStarted = true;
              await settingsGate;
              return { sequence: fixture.snapshot.snapshotSequence + 1 };
            }
            return api.orchestration.dispatchCommand(command);
          }),
        },
      }),
    });
    const deletedThreadIdsBeforeTest = useStore.getState().deletedThreadIdsById ?? {};

    try {
      await waitForServerConfigToApply();
      const requestStart = wsRequests.length;
      const implementButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
            (button) => button.textContent?.trim() === "Implement",
          ) ?? null,
        "Unable to find the plan implementation action.",
      );
      implementButton.click();
      await vi.waitFor(() => expect(delayedSettingsStarted).toBe(true));

      useStore.getState().removeDeletedThreadFromClientState(THREAD_ID);
      useComposerDraftStore.getState().clearDraftThread(THREAD_ID);
      resolveSettings();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 64));

      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
      expect(
        wsRequests
          .slice(requestStart)
          .map(readDispatchedCommand)
          .some((command) => command?.type === "thread.turn.start"),
      ).toBe(false);
    } finally {
      resolveSettings();
      useStore.setState({ deletedThreadIdsById: deletedThreadIdsBeforeTest });
      await mounted.cleanup();
    }
  });

  it("abandons edit-and-resend when settings persistence outlives thread deletion", async () => {
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-edit-deletion-race" as MessageId,
      targetText: "edit deletion race",
    });
    const snapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: baseSnapshot.threads.map((thread) => ({
        ...thread,
        messages: thread.messages.map((message, index) =>
          index >= thread.messages.length - 2
            ? { ...message, turnId: "turn-edit-deletion-race" as TurnId }
            : message,
        ),
      })),
    };
    let resolveSettings!: () => void;
    const settingsGate = new Promise<void>((resolve) => {
      resolveSettings = resolve;
    });
    let delayedSettingsStarted = false;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      configureNativeApi: (api) => ({
        ...api,
        orchestration: {
          ...api.orchestration,
          dispatchCommand: vi.fn(async (command) => {
            if (command.type === "thread.meta.update" && command.modelSelection !== undefined) {
              delayedSettingsStarted = true;
              await settingsGate;
              return { sequence: fixture.snapshot.snapshotSequence + 1 };
            }
            return api.orchestration.dispatchCommand(command);
          }),
        },
      }),
    });
    const deletedThreadIdsBeforeTest = useStore.getState().deletedThreadIdsById ?? {};

    try {
      await waitForServerConfigToApply();
      useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
        provider: "codex",
        model: "gpt-5.3-codex",
      });
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
            .codex,
        ).toEqual({
          provider: "codex",
          model: "gpt-5.3-codex",
        });
      });
      const requestStart = wsRequests.length;
      const editButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Edit message"]'),
        "Unable to find the edit action before the deletion race.",
      );
      editButton.click();
      const editTextArea = await waitForElement(
        () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit message"]'),
        "Unable to find the edit textarea before the deletion race.",
      );
      await userEvent.fill(editTextArea, "edited text must not outlive deletion");
      const editForm = editTextArea.closest("form");
      expect(editForm).not.toBeNull();
      editForm!.requestSubmit();
      await vi.waitFor(() => expect(delayedSettingsStarted).toBe(true));

      useStore.getState().removeDeletedThreadFromClientState(THREAD_ID);
      useComposerDraftStore.getState().clearDraftThread(THREAD_ID);
      resolveSettings();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 64));

      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
      expect(
        wsRequests
          .slice(requestStart)
          .map(readDispatchedCommand)
          .some((command) => command?.type === "thread.message.edit-and-resend"),
      ).toBe(false);
    } finally {
      resolveSettings();
      useStore.setState({ deletedThreadIdsById: deletedThreadIdsBeforeTest });
      await mounted.cleanup();
    }
  });

  it("snapshots sticky codex settings into a new draft thread", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        codex: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "medium",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "codex",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-codex-traits-test" as MessageId,
        targetText: "sticky codex traits test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              fastMode: true,
            },
          },
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers New worktree from an empty draft thread", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-empty-worktree-test" as MessageId,
        targetText: "empty worktree test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(
            useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId,
          ).toBe(newThreadId);
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
          expect(mounted.router.state.status).toBe("idle");
        },
        { timeout: 8_000, interval: 16 },
      );
      const envPickerTrigger = await waitForEnvironmentModeButton("Local");
      envPickerTrigger.click();

      const newWorktreeOption = page.getByText("New worktree");
      await expect.element(newWorktreeOption).toBeInTheDocument();
      await newWorktreeOption.click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)?.envMode).toBe(
            "worktree",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("records a recovery draft when dirty worktree cleanup refuses after source deletion", async () => {
    const existingPrimaryDraftId = ThreadId.makeUnsafe("thread-existing-primary-draft");
    type CreateWorktreeResult = Awaited<ReturnType<NativeApi["git"]["createWorktree"]>>;
    let resolveCreateWorktree!: (value: CreateWorktreeResult) => void;
    const createWorktreeResult = new Promise<CreateWorktreeResult>((resolve) => {
      resolveCreateWorktree = resolve;
    });
    const createWorktree = vi.fn<NativeApi["git"]["createWorktree"]>(() => createWorktreeResult);
    const removeWorktree = vi.fn<NativeApi["git"]["removeWorktree"]>(async () => {
      throw new Error("worktree contains external changes");
    });
    let resolveMetadata!: () => void;
    const metadataGate = new Promise<void>((resolve) => {
      resolveMetadata = resolve;
    });
    let metadataStarted = false;
    const snapshot = addThreadToSnapshot(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-deleted-worktree-send" as MessageId,
        targetText: "deleted worktree send",
      }),
      OTHER_THREAD_ID,
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      initialEntry: `/${OTHER_THREAD_ID}`,
      configureNativeApi: (api) => ({
        ...api,
        orchestration: {
          ...api.orchestration,
          dispatchCommand: vi.fn(async (command) => {
            if (
              command.type === "thread.meta.update" &&
              command.threadId === OTHER_THREAD_ID &&
              command.envMode === "worktree"
            ) {
              metadataStarted = true;
              await metadataGate;
              return { sequence: fixture.snapshot.snapshotSequence + 1 };
            }
            return api.orchestration.dispatchCommand(command);
          }),
        },
        git: {
          ...api.git,
          createWorktree,
          removeWorktree,
        },
      }),
    });
    const deletedThreadIdsBeforeTest = useStore.getState().deletedThreadIdsById ?? {};

    try {
      await waitForComposerEditor();
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, existingPrimaryDraftId);
      useComposerDraftStore.getState().setPrompt(existingPrimaryDraftId, "existing primary prompt");
      useStore.getState().setThreadWorkspace(OTHER_THREAD_ID, {
        envMode: "worktree",
        branch: "main",
        worktreePath: null,
      });
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "do not keep this worktree");
      await vi.waitFor(() => {
        const thread = useStore
          .getState()
          .threads.find((candidate) => candidate.id === OTHER_THREAD_ID);
        expect(thread).toMatchObject({ envMode: "worktree", branch: "main", worktreePath: null });
      });

      const requestStart = wsRequests.length;
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find the composer before the worktree-deletion race.",
      );
      composerForm.requestSubmit();
      await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledOnce());

      resolveCreateWorktree({
        worktree: {
          path: "/repo/.codex/worktrees/project/deleted-send",
          branch: "scient/deleted-send",
        },
      });
      await vi.waitFor(() => expect(metadataStarted).toBe(true), {
        timeout: 12_000,
        interval: 16,
      });

      useStore.setState((state) => ({
        deletedThreadIdsById: {
          ...(state.deletedThreadIdsById ?? {}),
          [OTHER_THREAD_ID]: true,
        },
      }));
      useComposerDraftStore.getState().clearDraftThread(OTHER_THREAD_ID);
      resolveMetadata();
      await vi.waitFor(
        () => {
          expect(removeWorktree).toHaveBeenCalledWith({
            cwd: "/repo/project",
            path: "/repo/.codex/worktrees/project/deleted-send",
            force: false,
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      const recoveryRow = page.getByRole("button", {
        name: "Open recovered worktree scient/deleted-send at /repo/.codex/worktrees/project/deleted-send",
      });
      await expect.element(recoveryRow).toBeInTheDocument();
      expect(useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId).toBe(
        existingPrimaryDraftId,
      );
      expect(
        useComposerDraftStore.getState().draftsByThreadId[existingPrimaryDraftId]?.prompt,
      ).toBe("existing primary prompt");
      expect(
        wsRequests
          .slice(requestStart)
          .map(readDispatchedCommand)
          .filter(
            (command) => command && "threadId" in command && command.threadId === OTHER_THREAD_ID,
          ),
      ).toEqual([]);

      await page.getByTestId("new-thread-button").click();
      await waitForURL(
        mounted.router,
        (path) => path === `/${existingPrimaryDraftId}`,
        "The existing primary draft should remain reachable from its project action.",
      );
      await expect.element(recoveryRow).toBeInTheDocument();
      await recoveryRow.click();
      const recoveryPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== `/${existingPrimaryDraftId}`,
        "The surfaced recovery row should open its draft.",
      );
      const recoveryThreadId = recoveryPath.slice(1) as ThreadId;
      expect(useComposerDraftStore.getState().getDraftThread(recoveryThreadId)).toMatchObject({
        branch: "scient/deleted-send",
        worktreePath: "/repo/.codex/worktrees/project/deleted-send",
        envMode: "worktree",
        recoveryReason: "worktree-cleanup-refused",
      });
      expect(useComposerDraftStore.getState().draftsByThreadId[recoveryThreadId]?.prompt).toBe(
        "do not keep this worktree",
      );
      const recoveryEditor = await waitForComposerEditor();
      await vi.waitFor(() => {
        expect(recoveryEditor.textContent ?? "").toContain("do not keep this worktree");
      });
      await expect
        .element(page.getByTestId("empty-landing-heading-project-trigger"))
        .not.toBeInTheDocument();
      const fixedProjectLabel = page.getByTestId("recovery-fixed-project-label");
      await expect.element(fixedProjectLabel).toBeInTheDocument();
      await expect
        .element(fixedProjectLabel)
        .toHaveAttribute(
          "aria-label",
          "Recovered worktree project is fixed to Project until retry or forget",
        );
      expect(useComposerDraftStore.getState().getDraftThread(recoveryThreadId)).toMatchObject({
        projectId: PROJECT_ID,
        branch: "scient/deleted-send",
        worktreePath: "/repo/.codex/worktrees/project/deleted-send",
        recoveryReason: "worktree-cleanup-refused",
      });
      expect(useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId).toBe(
        existingPrimaryDraftId,
      );
      expect(
        useComposerDraftStore.getState().draftsByThreadId[existingPrimaryDraftId]?.prompt,
      ).toBe("existing primary prompt");
      (await waitForSendButton()).click();
      await vi.waitFor(() => {
        expect(
          wsRequests
            .map(readDispatchedCommand)
            .some(
              (command) =>
                command?.type === "thread.turn.start" && command.threadId === recoveryThreadId,
            ),
        ).toBe(true);
      });
      expect(createWorktree).toHaveBeenCalledOnce();
      await vi.waitFor(() => {
        expect(
          Object.values(useComposerDraftStore.getState().draftThreadsByThreadId).filter(
            (draft) =>
              draft.recoveryReason === "worktree-cleanup-refused" && draft.promotedTo === undefined,
          ),
        ).toHaveLength(0);
      });
      await expect.element(recoveryRow).not.toBeInTheDocument();
      expect(useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId).toBe(
        existingPrimaryDraftId,
      );
    } finally {
      resolveCreateWorktree({
        worktree: {
          path: "/repo/.codex/worktrees/project/deleted-send",
          branch: "scient/deleted-send",
        },
      });
      resolveMetadata();
      useStore.setState({ deletedThreadIdsById: deletedThreadIdsBeforeTest });
      await mounted.cleanup();
    }
  });

  it("blocks project removal until a recovery is explicitly forgotten without deleting files", async () => {
    const primaryDraftId = ThreadId.makeUnsafe("thread-recovery-delete-primary");
    const recoveryThreadId = ThreadId.makeUnsafe("b6505d06-c23b-4d42-8b6c-561402266a0f");
    const dispatchedCommands: Array<Parameters<NativeApi["orchestration"]["dispatchCommand"]>[0]> =
      [];
    const confirm = vi.fn<NativeApi["dialogs"]["confirm"]>(async () => true);
    const removeWorktree = vi.fn<NativeApi["git"]["removeWorktree"]>(async () => undefined);
    const deletedProjectIdsBeforeTest = useStore.getState().deletedProjectIdsById ?? {};
    const deletedThreadIdsBeforeTest = useStore.getState().deletedThreadIdsById ?? {};
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-recovery-project-delete" as MessageId,
        targetText: "recovery project delete",
      }),
      configureNativeApi: (api) => ({
        ...api,
        dialogs: { ...api.dialogs, confirm },
        git: { ...api.git, removeWorktree },
        orchestration: {
          ...api.orchestration,
          dispatchCommand: vi.fn(async (command) => {
            dispatchedCommands.push(command);
            return api.orchestration.dispatchCommand(command);
          }),
        },
      }),
    });

    try {
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, primaryDraftId);
      useComposerDraftStore.getState().setPrompt(primaryDraftId, "primary survives forget");
      useComposerDraftStore.getState().upsertWorktreeRecoveryDraft(recoveryThreadId, {
        projectId: PROJECT_ID,
        branch: "scient/recovery-delete-block",
        worktreePath: "/repo/worktrees/recovery-delete-block",
      });
      useComposerDraftStore.getState().setPrompt(recoveryThreadId, "recovery retry content");

      const recoveryRow = page.getByRole("button", {
        name: "Open recovered worktree scient/recovery-delete-block at /repo/worktrees/recovery-delete-block",
      });
      await expect.element(recoveryRow).toBeInTheDocument();
      await clickProjectRemoveAction();
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="toast-title"]')).find(
            (element) => element.textContent === "Resolve recovered worktrees first",
          ) ?? null,
        "Project removal should show a recovery-specific error.",
      );
      expect(confirm).not.toHaveBeenCalled();
      expect(dispatchedCommands.some((command) => command.type === "project.delete")).toBe(false);
      expect(useStore.getState().projects.some((project) => project.id === PROJECT_ID)).toBe(true);
      await expect.element(recoveryRow).toBeInTheDocument();
      expect(removeWorktree).not.toHaveBeenCalled();

      await page
        .getByRole("button", { name: "Forget recovered worktree scient/recovery-delete-block" })
        .click();
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
      expect(confirm.mock.calls[0]?.[0]).toContain(
        "It does not delete the worktree or any files at /repo/worktrees/recovery-delete-block.",
      );
      await expect.element(recoveryRow).not.toBeInTheDocument();
      expect(useComposerDraftStore.getState().getDraftThread(recoveryThreadId)).toBeNull();
      expect(useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId).toBe(
        primaryDraftId,
      );
      expect(useComposerDraftStore.getState().draftsByThreadId[primaryDraftId]?.prompt).toBe(
        "primary survives forget",
      );
      expect(removeWorktree).not.toHaveBeenCalled();

      await clickProjectRemoveAction();
      await vi.waitFor(
        () => {
          expect(confirm).toHaveBeenCalledTimes(2);
          expect(dispatchedCommands.some((command) => command.type === "project.delete")).toBe(
            true,
          );
        },
        { timeout: 20_000, interval: 16 },
      );
      expect(removeWorktree).not.toHaveBeenCalled();
    } finally {
      useStore.setState({
        deletedProjectIdsById: deletedProjectIdsBeforeTest,
        deletedThreadIdsById: deletedThreadIdsBeforeTest,
      });
      await mounted.cleanup();
    }
  });

  it("blocks chat and terminal New Thread entry points while project removal is reserved", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-removal-new-thread-gate" as MessageId,
        targetText: "new thread admission source",
      }),
    });
    const reservation = reserveProjectRemoval(PROJECT_ID);
    expect(reservation).not.toBeNull();
    const originalPath = mounted.router.state.location.pathname;
    const originalDraftThreadIds = Object.keys(
      useComposerDraftStore.getState().draftThreadsByThreadId,
    ).toSorted();
    const requestStart = wsRequests.length;

    try {
      await page.getByLabelText("Create new thread in Project").click();
      await page.getByLabelText("Create new terminal thread in Project").click();
      // Each blocked entry point raises its own "Project removal in progress" warning, so match a
      // toast by text instead of a single-element locator — two identical toasts would trip the
      // locator's strict single-match and hang until the test times out.
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="toast-title"]')).find(
            (element) => element.textContent === "Project removal in progress",
          ) ?? null,
        "Blocked New Thread entry points should surface a project-removal warning.",
      );
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

      expect(mounted.router.state.location.pathname).toBe(originalPath);
      expect(
        Object.keys(useComposerDraftStore.getState().draftThreadsByThreadId).toSorted(),
      ).toEqual(originalDraftThreadIds);
      expect(
        wsRequests
          .slice(requestStart)
          .map(readDispatchedCommand)
          .some((command) => command?.type === "thread.create"),
      ).toBe(false);
      expect(hasActiveProjectOperations(PROJECT_ID)).toBe(false);
    } finally {
      if (reservation) releaseProjectRemoval(reservation);
      await mounted.cleanup();
    }
  });

  it("deletes a thread admitted before removal from the live post-drain project snapshot", async () => {
    const admittedOperation = tryBeginProjectOperation(PROJECT_ID);
    expect(admittedOperation).not.toBeNull();
    const lateThreadId = ThreadId.makeUnsafe("dfdbccf0-75b0-4a5b-8485-3cb124b05543");
    const standaloneDraftId = ThreadId.makeUnsafe("478cb186-48c7-4c52-b7ef-79df1234f31a");
    useComposerDraftStore.getState().registerDraftThread(standaloneDraftId, {
      projectId: PROJECT_ID,
      entryPoint: "chat",
      envMode: "local",
    });
    useComposerDraftStore.getState().setPrompt(standaloneDraftId, "standalone kanban draft");
    const confirm = vi.fn<NativeApi["dialogs"]["confirm"]>(async () => true);
    const dispatchedCommands: Array<Parameters<NativeApi["orchestration"]["dispatchCommand"]>[0]> =
      [];
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-removal-live-thread-set" as MessageId,
        targetText: "live project thread set source",
      }),
      configureNativeApi: (api) => ({
        ...api,
        dialogs: { ...api.dialogs, confirm },
        orchestration: {
          ...api.orchestration,
          dispatchCommand: vi.fn(async (command) => {
            dispatchedCommands.push(command);
            return api.orchestration.dispatchCommand(command);
          }),
        },
      }),
    });

    try {
      await clickProjectRemoveAction();
      await vi.waitFor(() => expect(isProjectRemovalReserved(PROJECT_ID)).toBe(true));
      expect(confirm).not.toHaveBeenCalled();
      expect(dispatchedCommands.some((command) => command.type === "thread.delete")).toBe(false);

      const sourceShell = useStore.getState().threadShellById?.[THREAD_ID];
      expect(sourceShell).toBeDefined();
      // Admit the thread the way real thread creation does: into the normalized projection
      // (`threadIds` + `threadShellById`) that `getThreadsFromState`/`getThreadFromState` read.
      // Writing only the legacy `threads` array leaves it invisible to the removal deletion
      // path, so the post-drain snapshot would never see it (the regression this guards).
      useStore.setState((state) => ({
        threadIds: [...(state.threadIds ?? []), lateThreadId],
        threadShellById: {
          ...state.threadShellById,
          [lateThreadId]: { ...sourceShell!, id: lateThreadId, title: "Late thread" },
        },
      }));
      finishProjectOperation(admittedOperation!);

      await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      expect(String(confirm.mock.calls[0]?.[0])).toContain("delete 2 threads");
      expect(String(confirm.mock.calls[0]?.[0])).toContain("and 1 unsent draft");

      await vi.waitFor(
        () => {
          expect(
            dispatchedCommands.some(
              (command) => command.type === "thread.delete" && command.threadId === lateThreadId,
            ),
          ).toBe(true);
          expect(dispatchedCommands.some((command) => command.type === "project.delete")).toBe(
            true,
          );
          expect(useComposerDraftStore.getState().getDraftThread(standaloneDraftId)).toBeNull();
        },
        { timeout: 20_000, interval: 16 },
      );

      // Consent is requested only after admitted work drains, so its count describes the same
      // stable thread set that deletion will consume. A late admitted thread must never be deleted
      // under an earlier, smaller confirmation.
    } finally {
      finishProjectOperation(admittedOperation!);
      await mounted.cleanup();
    }
  });

  it("keeps the stable post-drain project state when removal confirmation is cancelled", async () => {
    const confirm = vi.fn<NativeApi["dialogs"]["confirm"]>(async () => false);
    const dispatchedCommands: Array<Parameters<NativeApi["orchestration"]["dispatchCommand"]>[0]> =
      [];
    const standaloneDraftId = ThreadId.makeUnsafe("5ab531de-d244-452f-bdae-1fc307ea97bb");
    useComposerDraftStore.getState().registerDraftThread(standaloneDraftId, {
      projectId: PROJECT_ID,
      entryPoint: "chat",
      envMode: "local",
    });
    useComposerDraftStore.getState().setPrompt(standaloneDraftId, "do not discard me");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-removal-cancel-stable-set" as MessageId,
        targetText: "removal cancellation source",
      }),
      configureNativeApi: (api) => ({
        ...api,
        dialogs: { ...api.dialogs, confirm },
        orchestration: {
          ...api.orchestration,
          dispatchCommand: vi.fn(async (command) => {
            dispatchedCommands.push(command);
            return api.orchestration.dispatchCommand(command);
          }),
        },
      }),
    });

    try {
      await clickProjectRemoveAction();
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      expect(String(confirm.mock.calls[0]?.[0])).toContain("1 thread and 1 unsent draft");
      await vi.waitFor(() => expect(isProjectRemovalReserved(PROJECT_ID)).toBe(false));

      expect(dispatchedCommands.some((command) => command.type === "thread.delete")).toBe(false);
      expect(dispatchedCommands.some((command) => command.type === "project.delete")).toBe(false);
      expect(useComposerDraftStore.getState().getDraftThread(standaloneDraftId)).toMatchObject({
        projectId: PROJECT_ID,
      });
      expect(useComposerDraftStore.getState().draftsByThreadId[standaloneDraftId]?.prompt).toBe(
        "do not discard me",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows cancellable progress while project removal waits for admitted work", async () => {
    const admittedOperation = tryBeginProjectOperation(PROJECT_ID);
    expect(admittedOperation).not.toBeNull();
    const confirm = vi.fn<NativeApi["dialogs"]["confirm"]>(async () => true);
    const addAlert = vi.spyOn(transientAlertManager, "add");
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-removal-wait-cancel" as MessageId,
      targetText: "removal wait cancellation source",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        projects: snapshot.projects.map((project) =>
          project.id === PROJECT_ID ? { ...project, title: "Removal Wait Project" } : project,
        ),
      },
      configureNativeApi: (api) => ({
        ...api,
        dialogs: { ...api.dialogs, confirm },
      }),
    });

    try {
      await clickProjectRemoveAction("Removal Wait Project");
      await expect
        .element(page.getByText('Waiting to remove "Removal Wait Project"'))
        .toBeInTheDocument();
      expect(isProjectRemovalReserved(PROJECT_ID)).toBe(true);
      expect(confirm).not.toHaveBeenCalled();

      await expect
        .element(page.getByRole("button", { name: 'Cancel removal of "Removal Wait Project"' }))
        .toBeInTheDocument();
      const waitingAlertCallIndex = addAlert.mock.calls.findIndex(
        ([input]) => input.title === 'Waiting to remove "Removal Wait Project"',
      );
      const waitingAlert = addAlert.mock.calls[waitingAlertCallIndex]?.[0];
      expect(waitingAlert?.actionProps?.children).toBe("Cancel removal");
      // Multiple full-app mounts intentionally share the global toast manager in this file, so a
      // raw DOM click can target a retained provider from an earlier test. Invoke the exact alert
      // action captured for this removal after proving its uniquely named button is rendered.
      waitingAlert?.actionProps?.onClick?.(new MouseEvent("click") as never);
      await vi.waitFor(() => expect(isProjectRemovalReserved(PROJECT_ID)).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      await expect
        .element(page.getByText('Waiting to remove "Removal Wait Project"'))
        .not.toBeInTheDocument();
      expect(confirm).not.toHaveBeenCalled();
      expect(useStore.getState().projects.some((project) => project.id === PROJECT_ID)).toBe(true);

      const resumedOperation = tryBeginProjectOperation(PROJECT_ID);
      expect(resumedOperation).not.toBeNull();
      if (resumedOperation) finishProjectOperation(resumedOperation);

      // Swipe dismissal closes through the toast manager rather than the visible action or X.
      // Exercise that shared lifecycle directly: hiding the progress surface must also release
      // the reservation so it cannot leave project sends and creators blocked indefinitely.
      await clickProjectRemoveAction("Removal Wait Project");
      await vi.waitFor(() => expect(addAlert).toHaveBeenCalledTimes(2));
      await expect
        .element(page.getByText('Waiting to remove "Removal Wait Project"'))
        .toBeInTheDocument();
      expect(isProjectRemovalReserved(PROJECT_ID)).toBe(true);
      const managerDismissedAlertId = addAlert.mock.results[1]?.value;
      expect(managerDismissedAlertId).toBeTypeOf("string");
      transientAlertManager.close(managerDismissedAlertId);
      await vi.waitFor(() => expect(isProjectRemovalReserved(PROJECT_ID)).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      await expect
        .element(page.getByText('Waiting to remove "Removal Wait Project"'))
        .not.toBeInTheDocument();
      expect(confirm).not.toHaveBeenCalled();
      const operationAfterManagerDismissal = tryBeginProjectOperation(PROJECT_ID);
      expect(operationAfterManagerDismissal).not.toBeNull();
      if (operationAfterManagerDismissal) finishProjectOperation(operationAfterManagerDismissal);
    } finally {
      addAlert.mockRestore();
      if (admittedOperation) finishProjectOperation(admittedOperation);
      await mounted.cleanup();
    }
  });

  it("drains an admitted send before removal and reveals a late cleanup recovery", async () => {
    const sourceDraftId = ThreadId.makeUnsafe("234dc723-a85e-4019-927c-d95d62962588");
    const createdPath = "/repo/worktrees/removal-late-recovery";
    const createdBranch = "scient/removal-late-recovery";
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [sourceDraftId]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
          workspaceOrigin: "intentional",
        },
      },
      projectDraftThreadIdByProjectId: { [PROJECT_ID]: sourceDraftId },
    });
    let releaseSourceTurn!: () => void;
    const sourceTurnGate = new Promise<void>((resolve) => {
      releaseSourceTurn = resolve;
    });
    let sourceTurnHeld = false;
    const confirm = vi.fn<NativeApi["dialogs"]["confirm"]>(async () => true);
    const createWorktree = vi.fn<NativeApi["git"]["createWorktree"]>(async () => ({
      worktree: { path: createdPath, branch: createdBranch },
    }));
    const removeWorktree = vi.fn<NativeApi["git"]["removeWorktree"]>(async () => {
      throw new Error("worktree contains external changes");
    });
    const dispatchedCommands: Array<Parameters<NativeApi["orchestration"]["dispatchCommand"]>[0]> =
      [];
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(createDraftOnlySnapshot(), OTHER_THREAD_ID),
      initialEntry: `/${sourceDraftId}`,
      configureNativeApi: (api) => ({
        ...api,
        dialogs: { ...api.dialogs, confirm },
        git: { ...api.git, createWorktree, removeWorktree },
        orchestration: {
          ...api.orchestration,
          dispatchCommand: vi.fn(async (command) => {
            dispatchedCommands.push(command);
            if (command.type === "thread.turn.start" && command.threadId === sourceDraftId) {
              sourceTurnHeld = true;
              await sourceTurnGate;
              throw new Error("deterministic pre-turn failure during project removal");
            }
            return api.orchestration.dispatchCommand(command);
          }),
        },
      }),
    });

    try {
      useComposerDraftStore.getState().setPrompt(sourceDraftId, "create a recoverable worktree");
      (
        await waitForElement(
          () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
          "Unable to find the source composer before project removal.",
        )
      ).requestSubmit();
      await vi.waitFor(
        () => {
          expect(sourceTurnHeld).toBe(true);
          expect(createWorktree).toHaveBeenCalledOnce();
        },
        { timeout: 20_000, interval: 16 },
      );

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForURL(
        mounted.router,
        (path) => path === `/${OTHER_THREAD_ID}`,
        "The second project thread should open while the source send remains admitted.",
      );
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "blocked during removal");
      await clickProjectRemoveAction();
      await vi.waitFor(() => expect(isProjectRemovalReserved(PROJECT_ID)).toBe(true));
      expect(confirm).not.toHaveBeenCalled();

      (
        await waitForElement(
          () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
          "Unable to find the second composer while removal is reserved.",
        )
      ).requestSubmit();
      await vi.waitFor(() => {
        expect(
          useStore.getState().threads.find((thread) => thread.id === OTHER_THREAD_ID)?.error,
        ).toBe(
          "This project is being removed. Wait for removal to finish or cancel it before sending.",
        );
      });
      expect(
        dispatchedCommands.some(
          (command) => command.type === "thread.turn.start" && command.threadId === OTHER_THREAD_ID,
        ),
      ).toBe(false);
      expect(createWorktree).toHaveBeenCalledOnce();

      expect(dispatchedCommands.some((command) => command.type === "project.delete")).toBe(false);
      releaseSourceTurn();

      const recoveryRow = page.getByRole("button", {
        name: `Open recovered worktree ${createdBranch} at ${createdPath}`,
      });
      await expect.element(recoveryRow).toBeInTheDocument();
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="toast-title"]')).find(
            (element) => element.textContent === "Resolve recovered worktrees first",
          ) ?? null,
        "Late cleanup recovery should stop project deletion visibly.",
        20_000,
      );
      expect(removeWorktree).toHaveBeenCalledWith({
        cwd: "/repo/project",
        path: createdPath,
        force: false,
      });
      // The admitted send surfaced a recovery while the removal was draining. Re-checking that
      // blocker before consent means the user never sees a misleading deletion confirmation.
      expect(confirm).not.toHaveBeenCalled();
      expect(dispatchedCommands.some((command) => command.type === "project.delete")).toBe(false);
      expect(useStore.getState().projects.some((project) => project.id === PROJECT_ID)).toBe(true);

      (
        await waitForElement(
          () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
          "Unable to find the second composer after removal released its reservation.",
        )
      ).requestSubmit();
      await vi.waitFor(() => {
        expect(
          dispatchedCommands.some(
            (command) =>
              command.type === "thread.turn.start" && command.threadId === OTHER_THREAD_ID,
          ),
        ).toBe(true);
      });
      await vi.waitFor(() => expect(hasActiveProjectOperations(PROJECT_ID)).toBe(false));
    } finally {
      releaseSourceTurn();
      await mounted.cleanup();
    }
  });

  it("keeps sends blocked while project deletion is pending and releases them after failure", async () => {
    const localDraftId = ThreadId.makeUnsafe("48ba1679-20d2-40aa-aa1d-f92605fed30a");
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [localDraftId]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
          workspaceOrigin: "intentional",
        },
      },
      projectDraftThreadIdByProjectId: { [PROJECT_ID]: localDraftId },
    });
    let releaseProjectDelete!: () => void;
    const projectDeleteGate = new Promise<void>((resolve) => {
      releaseProjectDelete = resolve;
    });
    let projectDeleteStarted = false;
    const confirm = vi.fn<NativeApi["dialogs"]["confirm"]>(async () => true);
    const createWorktree = vi.fn<NativeApi["git"]["createWorktree"]>(async () => ({
      worktree: {
        path: "/repo/worktrees/removal-delete-failure",
        branch: "scient/removal-delete-failure",
      },
    }));
    const dispatchedCommands: Array<Parameters<NativeApi["orchestration"]["dispatchCommand"]>[0]> =
      [];
    const deletedProjectIdsBeforeTest = useStore.getState().deletedProjectIdsById ?? {};
    const deletedThreadIdsBeforeTest = useStore.getState().deletedThreadIdsById ?? {};
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-deferred-project-delete" as MessageId,
        targetText: "deferred project delete",
      }),
      configureNativeApi: (api) => ({
        ...api,
        dialogs: { ...api.dialogs, confirm },
        git: { ...api.git, createWorktree },
        orchestration: {
          ...api.orchestration,
          dispatchCommand: vi.fn(async (command) => {
            dispatchedCommands.push(command);
            if (command.type === "project.delete") {
              projectDeleteStarted = true;
              await projectDeleteGate;
              throw new Error("deterministic project deletion failure");
            }
            return api.orchestration.dispatchCommand(command);
          }),
        },
      }),
    });

    try {
      await clickProjectRemoveAction();
      await vi.waitFor(() => expect(projectDeleteStarted).toBe(true), {
        timeout: 20_000,
        interval: 16,
      });
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: localDraftId },
      });
      await waitForURL(
        mounted.router,
        (path) => path === `/${localDraftId}`,
        "The local draft should remain reachable while native project deletion is pending.",
      );
      useComposerDraftStore.getState().setPrompt(localDraftId, "blocked by project delete");
      (
        await waitForElement(
          () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
          "Unable to find the local composer while project deletion is pending.",
        )
      ).requestSubmit();
      await expect
        .element(
          page.getByText(
            "This project is being removed. Wait for removal to finish or cancel it before sending.",
          ),
        )
        .toBeInTheDocument();
      expect(createWorktree).not.toHaveBeenCalled();
      expect(
        dispatchedCommands.some(
          (command) => command.type === "thread.turn.start" && command.threadId === localDraftId,
        ),
      ).toBe(false);

      releaseProjectDelete();
      await vi.waitFor(() => expect(isProjectRemovalReserved(PROJECT_ID)).toBe(false));
      expect(hasActiveProjectOperations(PROJECT_ID)).toBe(false);
    } finally {
      releaseProjectDelete();
      useStore.setState({
        deletedProjectIdsById: deletedProjectIdsBeforeTest,
        deletedThreadIdsById: deletedThreadIdsBeforeTest,
      });
      await mounted.cleanup();
    }
  });

  it("restores exact worktree ownership when dirty cleanup refuses after promotion draft clear", async () => {
    let resolvePromotion!: () => void;
    const promotionGate = new Promise<void>((resolve) => {
      resolvePromotion = resolve;
    });
    let promotedThreadId: ThreadId | null = null;
    const createWorktree = vi.fn<NativeApi["git"]["createWorktree"]>(async () => ({
      worktree: {
        path: "/repo/.codex/worktrees/project/deleted-draft",
        branch: "scient/deleted-draft",
      },
    }));
    const removeWorktree = vi.fn<NativeApi["git"]["removeWorktree"]>(async () => {
      throw new Error("worktree contains external changes");
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-deleted-draft-promotion" as MessageId,
        targetText: "deleted draft promotion",
      }),
      configureNativeApi: (api) => ({
        ...api,
        orchestration: {
          ...api.orchestration,
          dispatchCommand: vi.fn(async (command) => {
            if (command.type === "thread.create") {
              promotedThreadId = command.threadId;
              await promotionGate;
              return { sequence: fixture.snapshot.snapshotSequence + 1 };
            }
            return api.orchestration.dispatchCommand(command);
          }),
        },
        git: {
          ...api.git,
          createWorktree,
          removeWorktree,
        },
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a draft before the promotion-deletion race.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      const envPickerTrigger = await waitForEnvironmentModeButton("Local");
      envPickerTrigger.click();
      const newWorktreeOption = page.getByText("New worktree");
      await expect.element(newWorktreeOption).toBeInTheDocument();
      await newWorktreeOption.click();

      useComposerDraftStore.getState().setPrompt(newThreadId, "do not promote this draft");
      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
          envMode: "worktree",
          branch: "main",
        });
      });
      const requestStart = wsRequests.length;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await sendButton.click();
      await vi.waitFor(
        () => {
          expect(createWorktree).toHaveBeenCalledOnce();
          expect(promotedThreadId).toBe(newThreadId);
        },
        { timeout: 12_000, interval: 16 },
      );

      useComposerDraftStore.getState().clearDraftThread(newThreadId);
      resolvePromotion();
      await vi.waitFor(
        () => {
          expect(removeWorktree).toHaveBeenCalledWith({
            cwd: "/repo/project",
            path: "/repo/.codex/worktrees/project/deleted-draft",
            force: false,
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
        branch: "scient/deleted-draft",
        worktreePath: "/repo/.codex/worktrees/project/deleted-draft",
        envMode: "worktree",
      });
      expect(
        useComposerDraftStore.getState().getDraftThread(newThreadId)?.promotedTo,
      ).toBeUndefined();
      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.prompt).toBe(
        "do not promote this draft",
      );
      const dispatchedCommands = wsRequests
        .slice(requestStart)
        .map(readDispatchedCommand)
        .filter(Boolean);
      expect(dispatchedCommands).toContainEqual(
        expect.objectContaining({ type: "thread.delete", threadId: newThreadId }),
      );
      expect(
        dispatchedCommands.some(
          (command) => command?.type === "thread.turn.start" && command.threadId === newThreadId,
        ),
      ).toBe(false);

      await (await waitForSendButton()).click();
      await vi.waitFor(() => {
        expect(
          wsRequests
            .map(readDispatchedCommand)
            .some(
              (command) =>
                command?.type === "thread.turn.start" && command.threadId === newThreadId,
            ),
        ).toBe(true);
      });
      expect(createWorktree).toHaveBeenCalledOnce();
    } finally {
      resolvePromotion();
      await mounted.cleanup();
    }
  });

  it("does not delete a thread created by a concurrent draft promoter when send later fails", async () => {
    const newThreadId = ThreadId.makeUnsafe("thread-concurrent-promotion-failure");
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [newThreadId]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: "main",
          worktreePath: null,
          envMode: "local",
          workspaceOrigin: "default",
        },
      },
      projectDraftThreadIdByProjectId: { [PROJECT_ID]: newThreadId },
    });
    let resolvePromotion!: () => void;
    const promotionGate = new Promise<void>((resolve) => {
      resolvePromotion = resolve;
    });
    const dispatchedCommands: Array<Parameters<NativeApi["orchestration"]["dispatchCommand"]>[0]> =
      [];
    let nativeApi: NativeApi | null = null;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialEntry: `/${newThreadId}`,
      configureNativeApi: (api) => {
        const configuredApi: NativeApi = {
          ...api,
          orchestration: {
            ...api.orchestration,
            dispatchCommand: vi.fn(async (command) => {
              dispatchedCommands.push(command);
              if (command.type === "thread.create") {
                await promotionGate;
              }
              if (command.type === "thread.turn.start") {
                throw new Error("deterministic pre-turn failure");
              }
              return { sequence: fixture.snapshot.snapshotSequence + 1 };
            }),
          },
        };
        nativeApi = configuredApi;
        return configuredApi;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(newThreadId, "keep the concurrent thread");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(() => {
        expect(composerEditor.textContent ?? "").toContain("keep the concurrent thread");
      });
      expect(nativeApi).not.toBeNull();

      const competingPromotion = promoteThreadCreate(
        {
          type: "thread.create",
          commandId: CommandId.makeUnsafe("command-concurrent-promoter"),
          threadId: newThreadId,
          projectId: PROJECT_ID,
          title: "Concurrent owner",
          modelSelection: { provider: "codex", model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          envMode: "local",
          branch: "main",
          worktreePath: null,
          lastKnownPr: null,
          createdAt: NOW_ISO,
        },
        nativeApi!,
      );
      await vi.waitFor(() => {
        expect(
          dispatchedCommands.filter((command) => command.type === "thread.create"),
        ).toHaveLength(1);
      });

      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find the composer before the concurrent promotion race.",
      );
      composerForm.requestSubmit();
      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.prompt ?? "").toBe(
          "",
        );
        expect(
          dispatchedCommands.filter((command) => command.type === "thread.create"),
        ).toHaveLength(1);
      });
      resolvePromotion();
      await expect(competingPromotion).resolves.toBe("created");
      await vi.waitFor(() => {
        expect(dispatchedCommands.some((command) => command.type === "thread.turn.start")).toBe(
          true,
        );
      });

      expect(dispatchedCommands.filter((command) => command.type === "thread.create")).toHaveLength(
        1,
      );
      expect(dispatchedCommands.some((command) => command.type === "thread.delete")).toBe(false);
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)?.promotedTo).toBe(
        newThreadId,
      );
    } finally {
      resolvePromotion();
      await mounted.cleanup();
    }
  });

  it("removes a generated worktree and restores an owned draft after pre-turn failure", async () => {
    const newThreadId = ThreadId.makeUnsafe("thread-owned-promotion-failure");
    const restoredPreviewUrl = "blob:restored-after-pre-turn-failure";
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [newThreadId]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
          workspaceOrigin: "intentional",
        },
      },
      projectDraftThreadIdByProjectId: { [PROJECT_ID]: newThreadId },
    });
    const createWorktree = vi.fn<NativeApi["git"]["createWorktree"]>(async (input) => ({
      worktree: {
        path: `/repo/.codex/worktrees/project/${input.newBranch}`,
        branch: input.newBranch!,
      },
    }));
    const removeWorktree = vi.fn<NativeApi["git"]["removeWorktree"]>(async () => undefined);
    let failNextTurn = true;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialEntry: `/${newThreadId}`,
      configureNativeApi: (api) => ({
        ...api,
        orchestration: {
          ...api.orchestration,
          dispatchCommand: vi.fn(async (command) => {
            const result = await api.orchestration.dispatchCommand(command);
            if (command.type === "thread.turn.start" && failNextTurn) {
              failNextTurn = false;
              throw new Error("deterministic pre-turn failure");
            }
            return result;
          }),
        },
        git: { ...api.git, createWorktree, removeWorktree },
      }),
    });

    try {
      useComposerDraftStore.getState().setPrompt(newThreadId, "retry this send");
      useComposerDraftStore.getState().addImages(newThreadId, [
        createComposerImage({
          id: "restored-after-pre-turn-failure",
          previewUrl: restoredPreviewUrl,
          name: "restored-after-failure.png",
        }),
      ]);
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(() => {
        expect(composerEditor.textContent ?? "").toContain("retry this send");
        expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
          envMode: "worktree",
          branch: "main",
          worktreePath: null,
        });
      });

      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find the composer before the owned rollback test.",
      );
      composerForm.requestSubmit();
      await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledOnce());
      await vi.waitFor(
        () => {
          const commandTypes = wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command && command.threadId === newThreadId)
            .map((command) => command!.type);
          expect(
            commandTypes,
            `Expected owned rollback; saw ${commandTypes.join(", ")}; draft=${JSON.stringify(
              useComposerDraftStore.getState().getDraftThread(newThreadId),
            )}; error=${JSON.stringify(
              useStore.getState().threads.find((thread) => thread.id === newThreadId)?.error,
            )}`,
          ).toContain("thread.delete");
        },
        { timeout: 20_000, interval: 16 },
      );
      await vi.waitFor(() => {
        expect(removeWorktree).toHaveBeenCalledOnce();
        expect(useComposerDraftStore.getState().getDraftThread(newThreadId)?.promotedTo).toBe(
          undefined,
        );
        expect(
          useOptimisticUserMessageStore.getState().messagesByThreadId[newThreadId],
        ).toBeUndefined();
      });
      expect(useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId).toBe(
        newThreadId,
      );
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
        envMode: "worktree",
        worktreePath: null,
      });
      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.prompt).toBe(
        "retry this send",
      );
      const restoredImage =
        useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.images[0];
      expect(restoredImage?.previewUrl).toMatch(/^blob:/);
      expect(restoredImage?.previewUrl).not.toBe(restoredPreviewUrl);
      expect(document.querySelector(`img[src="${restoredImage!.previewUrl}"]`)).not.toBeNull();
      expect(revokeObjectUrl.mock.calls.filter(([url]) => url === restoredPreviewUrl)).toHaveLength(
        1,
      );

      await (await waitForSendButton()).click();
      await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(2));
      await vi.waitFor(
        () => {
          expect(
            wsRequests
              .map(readDispatchedCommand)
              .filter(
                (command) =>
                  command?.type === "thread.turn.start" && command.threadId === newThreadId,
              ),
          ).toHaveLength(2);
        },
        { timeout: 20_000, interval: 16 },
      );
      const firstPath = (await createWorktree.mock.results[0]!.value).worktree.path;
      const secondPath = (await createWorktree.mock.results[1]!.value).worktree.path;
      expect(firstPath).not.toBe(secondPath);
      expect(removeWorktree).toHaveBeenCalledWith({
        cwd: "/repo/project",
        path: firstPath,
        force: false,
      });
    } finally {
      revokeObjectUrl.mockRestore();
      await mounted.cleanup();
    }
  });

  it("adopts a generated worktree when non-forced rollback cleanup refuses removal", async () => {
    const newThreadId = ThreadId.makeUnsafe("thread-dirty-worktree-promotion-failure");
    const createdPath = "/repo/.codex/worktrees/project/dirty-before-turn";
    const createdBranch = "scient/dirty-before-turn";
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [newThreadId]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
          workspaceOrigin: "intentional",
        },
      },
      projectDraftThreadIdByProjectId: { [PROJECT_ID]: newThreadId },
    });
    const createWorktree = vi.fn<NativeApi["git"]["createWorktree"]>(async () => ({
      worktree: { path: createdPath, branch: createdBranch },
    }));
    const removeWorktree = vi.fn<NativeApi["git"]["removeWorktree"]>(async () => {
      throw new Error("worktree contains external changes");
    });
    let failNextTurn = true;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialEntry: `/${newThreadId}`,
      configureNativeApi: (api) => ({
        ...api,
        orchestration: {
          ...api.orchestration,
          dispatchCommand: vi.fn(async (command) => {
            const result = await api.orchestration.dispatchCommand(command);
            if (command.type === "thread.turn.start" && failNextTurn) {
              failNextTurn = false;
              throw new Error("deterministic pre-turn failure");
            }
            return result;
          }),
        },
        git: { ...api.git, createWorktree, removeWorktree },
      }),
    });

    try {
      useComposerDraftStore.getState().setPrompt(newThreadId, "preserve external worktree data");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(() => {
        expect(composerEditor.textContent ?? "").toContain("preserve external worktree data");
      });

      (
        await waitForElement(
          () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
          "Unable to find the composer before dirty-worktree rollback.",
        )
      ).requestSubmit();

      await vi.waitFor(
        () => {
          expect(removeWorktree).toHaveBeenCalledWith({
            cwd: "/repo/project",
            path: createdPath,
            force: false,
          });
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            envMode: "worktree",
            branch: createdBranch,
            worktreePath: createdPath,
          });
          expect(
            useComposerDraftStore.getState().getDraftThread(newThreadId)?.promotedTo,
          ).toBeUndefined();
        },
        { timeout: 20_000, interval: 16 },
      );
      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.prompt).toBe(
        "preserve external worktree data",
      );

      await (await waitForSendButton()).click();
      await vi.waitFor(
        () => {
          expect(
            wsRequests
              .map(readDispatchedCommand)
              .filter(
                (command) =>
                  command?.type === "thread.turn.start" && command.threadId === newThreadId,
              ),
          ).toHaveLength(2);
        },
        { timeout: 20_000, interval: 16 },
      );
      expect(createWorktree).toHaveBeenCalledOnce();
      expect(removeWorktree).toHaveBeenCalledOnce();
    } finally {
      await mounted.cleanup();
    }
  });

  it("adopts a generated worktree after setup starts so retry creates no duplicate", async () => {
    const newThreadId = ThreadId.makeUnsafe("thread-setup-started-promotion-failure");
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [newThreadId]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
          workspaceOrigin: "intentional",
        },
      },
      projectDraftThreadIdByProjectId: { [PROJECT_ID]: newThreadId },
    });
    const createdPath = "/repo/.codex/worktrees/project/setup-started";
    const createdBranch = "scient/setup-started";
    const createWorktree = vi.fn<NativeApi["git"]["createWorktree"]>(async () => ({
      worktree: { path: createdPath, branch: createdBranch },
    }));
    const removeWorktree = vi.fn<NativeApi["git"]["removeWorktree"]>(async () => undefined);
    let failSetupOpen = true;
    const setupTerminalOpenInputs: Array<Parameters<NativeApi["terminal"]["open"]>[0]> = [];
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "printf setup",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      initialEntry: `/${newThreadId}`,
      configureNativeApi: (api) => ({
        ...api,
        terminal: {
          ...api.terminal,
          open: vi.fn(async (input) => {
            if (input.threadId === newThreadId && input.cwd === createdPath && failSetupOpen) {
              failSetupOpen = false;
              setupTerminalOpenInputs.push(input);
              throw new Error("deterministic setup failure");
            }
            return api.terminal.open(input);
          }),
        },
        git: { ...api.git, createWorktree, removeWorktree },
      }),
    });

    try {
      useComposerDraftStore.getState().setPrompt(newThreadId, "retry without another worktree");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(() => {
        expect(composerEditor.textContent ?? "").toContain("retry without another worktree");
        expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
          envMode: "worktree",
          branch: "main",
          worktreePath: null,
        });
      });

      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find the composer before the setup rollback test.",
      );
      composerForm.requestSubmit();
      await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledOnce());
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            envMode: "worktree",
            branch: createdBranch,
            worktreePath: createdPath,
          });
          expect(
            useComposerDraftStore.getState().getDraftThread(newThreadId)?.promotedTo,
          ).toBeUndefined();
        },
        { timeout: 20_000, interval: 16 },
      );
      expect(removeWorktree).not.toHaveBeenCalled();
      expect(setupTerminalOpenInputs).toEqual([
        expect.objectContaining({ threadId: newThreadId, cwd: createdPath }),
      ]);
      expect(useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId).toBe(
        newThreadId,
      );
      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.prompt).toBe(
        "retry without another worktree",
      );

      await (await waitForSendButton()).click();
      await vi.waitFor(() => {
        expect(
          wsRequests.some((candidate) => {
            const command = readDispatchedCommand(candidate);
            return command?.type === "thread.turn.start" && command.threadId === newThreadId;
          }),
        ).toBe(true);
      });
      expect(createWorktree).toHaveBeenCalledOnce();
      expect(removeWorktree).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a temporary branch-backed worktree on first send in New worktree mode", async () => {
    const restoreNativeApi = installDeterministicActionNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-worktree-send-test" as MessageId,
        targetText: "new worktree send test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(
            useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId,
          ).toBe(newThreadId);
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
          expect(mounted.router.state.status).toBe("idle");
        },
        { timeout: 8_000, interval: 16 },
      );
      const envPickerTrigger = await waitForEnvironmentModeButton("Local");
      envPickerTrigger.click();

      const newWorktreeOption = page.getByText("New worktree");
      await expect.element(newWorktreeOption).toBeInTheDocument();
      await newWorktreeOption.click();

      useComposerDraftStore.getState().setPrompt(newThreadId, "Ship it");
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            envMode: "worktree",
            branch: "main",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("Ship it");
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await sendButton.click();

      await vi.waitFor(
        () => {
          const createWorktreeRequest = wsRequests.find(
            (request) =>
              request._tag === WS_METHODS.gitCreateWorktree &&
              request.cwd === "/repo/project" &&
              request.branch === "main" &&
              typeof request.newBranch === "string",
          );
          expect(createWorktreeRequest).toBeTruthy();
          expect(createWorktreeRequest?.newBranch).toMatch(
            new RegExp(`^${WORKTREE_BRANCH_PREFIX}/[0-9a-f]{8}$`),
          );

          const detachedRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.gitCreateDetachedWorktree,
          );
          expect(detachedRequest).toBeUndefined();

          const createThreadRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              "threadId" in request.command &&
              request.command.type === "thread.create" &&
              request.command.threadId === newThreadId,
          );
          expect(createThreadRequest).toBeTruthy();
          expect(createThreadRequest?.command).toMatchObject({
            envMode: "worktree",
            branch: createWorktreeRequest?.newBranch,
            worktreePath: `/repo/.codex/worktrees/project/${String(createWorktreeRequest?.newBranch).replaceAll("/", "-")}`,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("runs the setup action from the newly-created worktree before starting the turn", async () => {
    const restoreNativeApi = installDeterministicActionNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(
        withStudioProject(
          withHomeChatProject(
            createSnapshotForTargetUser({
              targetMessageId: "msg-user-new-worktree-setup-action-test" as MessageId,
              targetText: "new worktree setup action test",
            }),
          ),
        ),
        [
          {
            id: "setup",
            name: "Setup",
            command: "printf setup",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ],
      ),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(
            useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId,
          ).toBe(newThreadId);
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
          expect(mounted.router.state.status).toBe("idle");
        },
        { timeout: 8_000, interval: 16 },
      );
      const envPickerTrigger = await waitForEnvironmentModeButton("Local");
      envPickerTrigger.click();

      const newWorktreeOption = page.getByText("New worktree");
      await expect.element(newWorktreeOption).toBeInTheDocument();
      await newWorktreeOption.click();

      useComposerDraftStore.getState().setPrompt(newThreadId, "Ship it with setup");
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            envMode: "worktree",
            branch: "main",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("Ship it with setup");
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      const composerForm = document.querySelector<HTMLFormElement>(
        'form[data-chat-composer-form="true"]',
      );
      expect(composerForm).not.toBeNull();
      composerForm!.requestSubmit();

      const createWorktreeRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === WS_METHODS.gitCreateWorktree &&
              candidate.cwd === "/repo/project" &&
              candidate.branch === "main" &&
              typeof candidate.newBranch === "string",
          );
          expect(
            request,
            `Expected create worktree request; draft=${JSON.stringify(
              useComposerDraftStore.getState().getDraftThread(newThreadId),
            )}; path=${mounted.router.state.location.pathname}; forms=${
              document.querySelectorAll('form[data-chat-composer-form="true"]').length
            }; ui=${(document.body.textContent ?? "").slice(-300)}; saw ${wsRequests
              .map((candidate) => {
                const command = readDispatchedCommand(candidate);
                return command ? `${candidate._tag}:${command.type}` : candidate._tag;
              })
              .slice(-40)
              .join(", ")}`,
          ).toBeTruthy();
          if (!request || request._tag !== WS_METHODS.gitCreateWorktree) {
            throw new Error("Expected create worktree request.");
          }
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      const createWorktreeIndex = wsRequests.indexOf(createWorktreeRequest);
      const worktreePath = `/repo/.codex/worktrees/project/${String(
        createWorktreeRequest.newBranch,
      ).replaceAll("/", "-")}`;

      const terminalOpenRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === WS_METHODS.terminalOpen &&
              candidate.threadId === newThreadId &&
              candidate.cwd === worktreePath,
          );
          expect(
            request,
            `Expected setup terminal open; saw ${wsRequests
              .map((candidate) => {
                const command = readDispatchedCommand(candidate);
                return command ? `${candidate._tag}:${command.type}` : candidate._tag;
              })
              .join(", ")}`,
          ).toBeTruthy();
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      const terminalOpenIndex = wsRequests.indexOf(terminalOpenRequest!);
      expect(terminalOpenIndex).toBeGreaterThan(createWorktreeIndex);
      expect(terminalOpenRequest).toMatchObject({
        _tag: WS_METHODS.terminalOpen,
        cwd: worktreePath,
        env: {
          SYNARA_PROJECT_ROOT: "/repo/project",
          SYNARA_WORKTREE_PATH: worktreePath,
        },
      });

      const terminalWriteRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === WS_METHODS.terminalWrite &&
              candidate.threadId === newThreadId &&
              candidate.data === "printf setup\r",
          );
          expect(request).toBeTruthy();
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      const terminalWriteIndex = wsRequests.indexOf(terminalWriteRequest!);
      expect(terminalWriteIndex).toBeGreaterThan(terminalOpenIndex);

      const turnStartRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find((candidate) => {
            const command = readDispatchedCommand(candidate);
            return command?.type === "thread.turn.start" && command.threadId === newThreadId;
          });
          expect(request).toBeTruthy();
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      expect(wsRequests.indexOf(turnStartRequest!)).toBeGreaterThan(terminalWriteIndex);
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("hydrates the provider alongside a sticky claude model", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        claudeAgent: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "claudeAgent",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-claude-model-test" as MessageId,
        targetText: "sticky claude model test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new sticky claude draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toMatchObject({
        modelSelectionByProvider: {
          claudeAgent: {
            provider: "claudeAgent",
            model: "claude-opus-4-6",
            options: {
              effort: "max",
              fastMode: true,
            },
          },
        },
        activeProvider: "claudeAgent",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to defaults when no sticky composer settings exist", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-default-codex-traits-test" as MessageId,
        targetText: "default codex traits test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toBeUndefined();
    } finally {
      await mounted.cleanup();
    }
  });

  it("reuses the existing draft thread when the user clicks new thread again", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        codex: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "medium",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "codex",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-codex-traits-precedence-test" as MessageId,
        targetText: "draft codex traits precedence test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const threadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a sticky draft thread UUID.",
      );
      const threadId = threadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              fastMode: true,
            },
          },
        },
        activeProvider: "codex",
      });

      useComposerDraftStore.getState().setModelSelection(threadId, {
        provider: "codex",
        model: "gpt-5.4",
        options: {
          reasoningEffort: "low",
          fastMode: true,
        },
      });
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
            modelSelectionByProvider: {
              codex: {
                provider: "codex",
                model: "gpt-5.4",
                options: {
                  reasoningEffort: "low",
                  fastMode: true,
                },
              },
            },
            activeProvider: "codex",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await newThreadButton.click();
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 64);
      });

      expect(mounted.router.state.location.pathname).toBe(threadPath);
      expect(useComposerDraftStore.getState().projectDraftThreadIdByProjectId[PROJECT_ID]).toBe(
        threadId,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new thread from the global chat.new shortcut", async () => {
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-chat-shortcut-test" as MessageId,
      targetText: "chat shortcut test",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) => ({
          ...thread,
          envMode: "worktree" as const,
          branch: "feature/viewed-worktree",
          worktreePath: "/repo/worktrees/viewed-worktree",
        })),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      const newThreadPath = await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the shortcut.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
        branch: null,
        worktreePath: null,
        envMode: "local",
        workspaceOrigin: "default",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the configured New worktree default for provider-specific shortcuts", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-provider-shortcut-worktree-default" as MessageId,
        targetText: "provider shortcut worktree default",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.newCodex",
              shortcut: {
                key: "c",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
      configureNativeApi: (api) => ({
        ...api,
        server: {
          ...api.server,
          getSettings: async () => ({
            ...DEFAULT_SERVER_SETTINGS,
            defaultThreadEnvMode: "worktree",
          }),
        },
      }),
    });

    try {
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      const newThreadPath = await triggerThreadShortcutUntilPath(
        mounted.router,
        () => dispatchThreadShortcut("c"),
        (path) => UUID_ROUTE_RE.test(path),
        "Provider shortcut should open a fresh draft thread.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
        branch: "main",
        worktreePath: null,
        envMode: "worktree",
        workspaceOrigin: "default",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not let a delayed provider preflight replace a later reused draft", async () => {
    const reusableDraftThreadId = ThreadId.makeUnsafe("thread-provider-preflight-race");
    const unavailableProvider = {
      provider: "codex" as const,
      status: "error" as const,
      available: false,
      authStatus: "unauthenticated" as const,
      message: "Codex is temporarily unavailable.",
      checkedAt: NOW_ISO,
    };
    const availableProvider = {
      provider: "codex" as const,
      status: "ready" as const,
      available: true,
      authStatus: "authenticated" as const,
      checkedAt: NOW_ISO,
      runtime: {
        source: "system" as const,
        managedVersion: null,
        canInstall: false,
        canRepair: false,
        canRollback: false,
        canRemove: false,
        message: null,
      },
    };
    let resolveProviderRefresh!: (value: { providers: [typeof availableProvider] }) => void;
    const providerRefresh = new Promise<{ providers: [typeof availableProvider] }>((resolve) => {
      resolveProviderRefresh = resolve;
    });
    const refreshProviders = vi.fn<NativeApi["server"]["refreshProviders"]>(() => providerRefresh);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-provider-preflight-race" as MessageId,
        targetText: "provider preflight race",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [unavailableProvider],
          keybindings: [
            {
              command: "chat.newCodex",
              shortcut: {
                key: "c",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
      configureNativeApi: (api) => ({
        ...api,
        server: {
          ...api.server,
          refreshProviders,
        },
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, reusableDraftThreadId, {
        entryPoint: "chat",
        envMode: "local",
        branch: null,
        worktreePath: null,
        workspaceOrigin: "default",
      });
      useComposerDraftStore.getState().setPrompt(reusableDraftThreadId, "later draft prompt");

      await dispatchThreadShortcut("c");
      await dispatchThreadShortcut("c");
      await vi.waitFor(() => expect(refreshProviders).toHaveBeenCalledOnce());

      await page.getByTestId("new-thread-button").click();
      useComposerDraftStore.getState().addFiles(reusableDraftThreadId, [
        {
          type: "file",
          id: "provider-race-file",
          name: "provider-race.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          file: new File(["notes"], "provider-race.txt", { type: "text/plain" }),
        },
      ]);
      resolveProviderRefresh({ providers: [availableProvider] });
      await waitForDraftNavigationIdle(draftNavigationSlotKey());

      expect(mounted.router.state.location.pathname).toBe(`/${reusableDraftThreadId}`);
      expect(
        useComposerDraftStore.getState().draftsByThreadId[reusableDraftThreadId],
      ).toMatchObject({
        prompt: "later draft prompt",
        files: [expect.objectContaining({ id: "provider-race-file" })],
      });
      expect(
        useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID, "chat")?.threadId,
      ).toBe(reusableDraftThreadId);
    } finally {
      resolveProviderRefresh({ providers: [availableProvider] });
      await waitForDraftNavigationIdle(draftNavigationSlotKey());
      await mounted.cleanup();
    }
  });

  it("starts one fresh thread in the exact worktree from repeated context-menu actions", async () => {
    const contextMenuShow = vi.fn(
      async (_items: Parameters<NativeApi["contextMenu"]["show"]>[0]) => "new-thread-in-workspace",
    );
    const exactWorktreeBranchResult: Awaited<ReturnType<NativeApi["git"]["listBranches"]>> = {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: "feature/exact-worktree",
          current: false,
          isDefault: false,
          worktreePath: "/repo/worktrees/exact-worktree",
        },
      ],
    };
    const branchLookupDeferred = (() => {
      let resolve!: (value: Awaited<ReturnType<NativeApi["git"]["listBranches"]>>) => void;
      const promise = new Promise<Awaited<ReturnType<NativeApi["git"]["listBranches"]>>>(
        (nextResolve) => {
          resolve = nextResolve;
        },
      );
      return { promise, resolve };
    })();
    const branchLookup = vi.fn<NativeApi["git"]["listBranches"]>(
      async () => exactWorktreeBranchResult,
    );
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-context-worktree-test" as MessageId,
      targetText: "context worktree test",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) => ({
          ...thread,
          envMode: "worktree" as const,
          branch: "feature/exact-worktree",
          worktreePath: "/repo/worktrees/exact-worktree",
        })),
      },
      configureNativeApi: (api) => ({
        ...api,
        contextMenu: {
          ...api.contextMenu,
          show: contextMenuShow as NativeApi["contextMenu"]["show"],
        },
        git: {
          ...api.git,
          listBranches: branchLookup,
        },
      }),
    });
    const defaultNavigationBlocker = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((nextResolve) => {
        resolve = nextResolve;
      });
      return { promise, resolve };
    })();
    let defaultNavigationOperation: Promise<void> | null = null;

    try {
      await waitForServerConfigToApply();
      await waitForComposerEditor();
      useStore.getState().setProjectExpanded(PROJECT_ID, true);
      await waitForLayout();
      branchLookup.mockClear();
      branchLookup.mockImplementation(() => branchLookupDeferred.promise);
      const projectValidationCallCount = () =>
        branchLookup.mock.calls.filter(([input]) => input.cwd === "/repo/project").length;
      defaultNavigationOperation = runDraftNavigationOnce(
        draftNavigationSlotKey(),
        newThreadNavigationRequestKey({ projectId: PROJECT_ID, entryPoint: "chat" }),
        () => defaultNavigationBlocker.promise,
      );
      const threadRow = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-thread-entry-point]")).find(
            (row) => row.textContent?.includes(THREAD_TITLE),
          ) ?? null,
        "Unable to find the current thread row.",
      );
      const openContextMenu = () =>
        threadRow.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 24,
            clientY: 24,
          }),
        );

      openContextMenu();
      await vi.waitFor(() => expect(contextMenuShow).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(projectValidationCallCount()).toBe(1));
      openContextMenu();
      await vi.waitFor(() => expect(contextMenuShow).toHaveBeenCalledTimes(2));
      expect(contextMenuShow.mock.calls[0]?.[0]?.[0]).toMatchObject({
        id: "new-thread-in-workspace",
        label: "New thread in worktree (feature/exact-worktree)",
      });

      expect(projectValidationCallCount()).toBe(1);
      branchLookupDeferred.resolve(exactWorktreeBranchResult);
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "The explicit worktree action should open a fresh draft.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      expect(projectValidationCallCount()).toBe(1);
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
        branch: "feature/exact-worktree",
        worktreePath: "/repo/worktrees/exact-worktree",
        envMode: "worktree",
        workspaceOrigin: "intentional",
      });
    } finally {
      defaultNavigationBlocker.resolve();
      branchLookupDeferred.resolve(exactWorktreeBranchResult);
      await defaultNavigationOperation;
      await mounted.cleanup();
    }
  });

  it("keeps a newer direct Kanban route ahead of delayed exact-workspace validation", async () => {
    const otherThreadId = ThreadId.makeUnsafe("thread-existing-navigation-wins");
    const contextMenuShow = vi.fn(
      async (_items: Parameters<NativeApi["contextMenu"]["show"]>[0]) => "new-thread-in-workspace",
    );
    const exactWorktreeBranchResult: Awaited<ReturnType<NativeApi["git"]["listBranches"]>> = {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: "feature/delayed-exact",
          current: false,
          isDefault: false,
          worktreePath: "/repo/worktrees/delayed-exact",
        },
      ],
    };
    let resolveValidation!: (value: Awaited<ReturnType<NativeApi["git"]["listBranches"]>>) => void;
    const delayedValidation = new Promise<Awaited<ReturnType<NativeApi["git"]["listBranches"]>>>(
      (resolve) => {
        resolveValidation = resolve;
      },
    );
    const branchLookup = vi.fn<NativeApi["git"]["listBranches"]>(() => delayedValidation);
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-existing-navigation-wins" as MessageId,
      targetText: "existing navigation wins",
    });
    const sourceThread = baseSnapshot.threads[0]!;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...baseSnapshot,
        threads: [
          {
            ...sourceThread,
            envMode: "worktree",
            branch: "feature/delayed-exact",
            worktreePath: "/repo/worktrees/delayed-exact",
          },
          {
            ...sourceThread,
            id: otherThreadId,
            title: "Existing destination thread",
            messages: [],
            envMode: "local",
            branch: "main",
            worktreePath: null,
          },
        ],
      },
      configureNativeApi: (api) => ({
        ...api,
        contextMenu: {
          ...api.contextMenu,
          show: contextMenuShow as NativeApi["contextMenu"]["show"],
        },
        git: {
          ...api.git,
          listBranches: branchLookup,
        },
      }),
    });

    try {
      await waitForServerConfigToApply();
      await waitForComposerEditor();
      useStore.getState().setProjectExpanded(PROJECT_ID, true);
      await waitForLayout();
      const sourceRow = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-thread-entry-point]")).find(
            (row) => row.textContent?.includes(THREAD_TITLE),
          ) ?? null,
        "Unable to find the source thread row.",
      );
      sourceRow.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 24,
        }),
      );
      await vi.waitFor(() => expect(branchLookup).toHaveBeenCalledOnce());

      await mounted.router.navigate({ to: "/kanban" });
      await waitForURL(
        mounted.router,
        (path) => path === "/kanban",
        "The newer direct Kanban route should take control of the route.",
      );
      resolveValidation(exactWorktreeBranchResult);
      await waitForDraftNavigationIdle(draftNavigationSlotKey());

      expect(mounted.router.state.location.pathname).toBe("/kanban");
      expect(
        Object.values(useComposerDraftStore.getState().draftThreadsByThreadId).some(
          (draft) => draft.worktreePath === "/repo/worktrees/delayed-exact",
        ),
      ).toBe(false);
    } finally {
      resolveValidation(exactWorktreeBranchResult);
      await waitForDraftNavigationIdle(draftNavigationSlotKey());
      await mounted.cleanup();
    }
  });

  it("lets a renewed exact-workspace action win after an intervening default action", async () => {
    const reusableDraftThreadId = ThreadId.makeUnsafe("thread-exact-default-exact-race");
    const contextMenuShow = vi.fn(
      async (_items: Parameters<NativeApi["contextMenu"]["show"]>[0]) => "new-thread-in-workspace",
    );
    const exactWorktreeBranchResult: Awaited<ReturnType<NativeApi["git"]["listBranches"]>> = {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: "feature/exact-default-exact",
          current: false,
          isDefault: false,
          worktreePath: "/repo/worktrees/exact-default-exact",
        },
      ],
    };
    let resolveFirstValidation!: (
      value: Awaited<ReturnType<NativeApi["git"]["listBranches"]>>,
    ) => void;
    const firstValidation = new Promise<Awaited<ReturnType<NativeApi["git"]["listBranches"]>>>(
      (resolve) => {
        resolveFirstValidation = resolve;
      },
    );
    const branchLookup = vi.fn<NativeApi["git"]["listBranches"]>(
      async () => exactWorktreeBranchResult,
    );
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-exact-default-exact-race" as MessageId,
      targetText: "exact default exact race",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) => ({
          ...thread,
          envMode: "worktree" as const,
          branch: "feature/exact-default-exact",
          worktreePath: "/repo/worktrees/exact-default-exact",
        })),
      },
      configureNativeApi: (api) => ({
        ...api,
        contextMenu: {
          ...api.contextMenu,
          show: contextMenuShow as NativeApi["contextMenu"]["show"],
        },
        git: {
          ...api.git,
          listBranches: branchLookup,
        },
      }),
    });

    try {
      await waitForServerConfigToApply();
      await waitForComposerEditor();
      useStore.getState().setProjectExpanded(PROJECT_ID, true);
      await waitForLayout();
      const threadRow = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-thread-entry-point]")).find(
            (row) => row.textContent?.includes(THREAD_TITLE),
          ) ?? null,
        "Unable to find the current thread row.",
      );
      const openContextMenu = () =>
        threadRow.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 24,
            clientY: 24,
          }),
        );
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, reusableDraftThreadId, {
        entryPoint: "chat",
        envMode: "local",
        branch: null,
        worktreePath: null,
        workspaceOrigin: "default",
      });
      branchLookup.mockClear();
      branchLookup.mockImplementationOnce(() => firstValidation);
      branchLookup.mockImplementation(async () => exactWorktreeBranchResult);

      openContextMenu();
      await vi.waitFor(() => expect(branchLookup).toHaveBeenCalledTimes(1));

      await page.getByTestId("new-thread-button").click();
      await waitForURL(
        mounted.router,
        (path) => path === `/${reusableDraftThreadId}`,
        "The intervening ordinary action should reuse the default draft.",
      );

      openContextMenu();
      await vi.waitFor(() => expect(contextMenuShow).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(branchLookup).toHaveBeenCalledTimes(2));
      const renewedExactPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "The renewed exact-workspace action should become the latest route.",
      );
      const renewedExactThreadId = renewedExactPath.slice(1) as ThreadId;
      expect(useComposerDraftStore.getState().getDraftThread(renewedExactThreadId)).toMatchObject({
        branch: "feature/exact-default-exact",
        worktreePath: "/repo/worktrees/exact-default-exact",
        envMode: "worktree",
        workspaceOrigin: "intentional",
      });

      resolveFirstValidation(exactWorktreeBranchResult);
      await waitForDraftNavigationIdle(draftNavigationSlotKey());
      expect(mounted.router.state.location.pathname).toBe(`/${renewedExactThreadId}`);
    } finally {
      resolveFirstValidation(exactWorktreeBranchResult);
      await waitForDraftNavigationIdle(draftNavigationSlotKey());
      await mounted.cleanup();
    }
  });

  it("preserves a reused draft when it supersedes a waiting exact-workspace request", async () => {
    const reusableDraftThreadId = ThreadId.makeUnsafe("thread-reused-draft-race");
    const contextMenuShow = vi.fn(
      async (_items: Parameters<NativeApi["contextMenu"]["show"]>[0]) => "new-thread-in-workspace",
    );
    const exactWorktreeBranchResult: Awaited<ReturnType<NativeApi["git"]["listBranches"]>> = {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: "feature/exact-worktree",
          current: false,
          isDefault: false,
          worktreePath: "/repo/worktrees/exact-worktree",
        },
      ],
    };
    let resolveExactValidation!: (
      value: Awaited<ReturnType<NativeApi["git"]["listBranches"]>>,
    ) => void;
    const exactValidation = new Promise<Awaited<ReturnType<NativeApi["git"]["listBranches"]>>>(
      (resolve) => {
        resolveExactValidation = resolve;
      },
    );
    const branchLookup = vi.fn<NativeApi["git"]["listBranches"]>(
      async () => exactWorktreeBranchResult,
    );
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-reused-draft-race" as MessageId,
      targetText: "reused draft race",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) => ({
          ...thread,
          envMode: "worktree" as const,
          branch: "feature/exact-worktree",
          worktreePath: "/repo/worktrees/exact-worktree",
        })),
      },
      configureNativeApi: (api) => ({
        ...api,
        contextMenu: {
          ...api.contextMenu,
          show: contextMenuShow as NativeApi["contextMenu"]["show"],
        },
        git: {
          ...api.git,
          listBranches: branchLookup,
        },
      }),
    });

    try {
      await waitForServerConfigToApply();
      await waitForComposerEditor();
      useStore.getState().setProjectExpanded(PROJECT_ID, true);
      await waitForLayout();
      const threadRow = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-thread-entry-point]")).find(
            (row) => row.textContent?.includes(THREAD_TITLE),
          ) ?? null,
        "Unable to find the current thread row.",
      );
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, reusableDraftThreadId, {
        entryPoint: "chat",
        envMode: "local",
        branch: null,
        worktreePath: null,
        workspaceOrigin: "default",
      });
      useComposerDraftStore.getState().setPrompt(reusableDraftThreadId, "preserve this draft");
      branchLookup.mockClear();
      branchLookup.mockImplementation(() => exactValidation);

      threadRow.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 24,
        }),
      );
      await vi.waitFor(() => expect(branchLookup).toHaveBeenCalledTimes(1));

      await page.getByTestId("new-thread-button").click();
      useComposerDraftStore
        .getState()
        .setPrompt(reusableDraftThreadId, "newer prompt with attachment");
      useComposerDraftStore.getState().addFiles(reusableDraftThreadId, [
        {
          type: "file",
          id: "reused-draft-notes",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          file: new File(["notes"], "notes.txt", { type: "text/plain" }),
        },
      ]);

      resolveExactValidation(exactWorktreeBranchResult);
      await waitForDraftNavigationIdle(draftNavigationSlotKey());
      await waitForURL(
        mounted.router,
        (path) => path === `/${reusableDraftThreadId}`,
        "The later ordinary New Thread action should keep the reusable draft selected.",
      );

      expect(useComposerDraftStore.getState().getDraftThread(reusableDraftThreadId)).toMatchObject({
        branch: null,
        worktreePath: null,
        envMode: "local",
        workspaceOrigin: "default",
      });
      expect(
        useComposerDraftStore.getState().draftsByThreadId[reusableDraftThreadId],
      ).toMatchObject({
        prompt: "newer prompt with attachment",
        files: [expect.objectContaining({ id: "reused-draft-notes", name: "notes.txt" })],
      });
      expect(
        useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID, "chat")?.threadId,
      ).toBe(reusableDraftThreadId);
      expect(document.body.textContent).not.toContain("Unable to start thread");
    } finally {
      resolveExactValidation(exactWorktreeBranchResult);
      await waitForDraftNavigationIdle(draftNavigationSlotKey());
      await mounted.cleanup();
    }
  });

  it("does not adopt a staged route draft before its older navigation settles", async () => {
    const reusableDraftThreadId = ThreadId.makeUnsafe("thread-staged-route-reuse-race");
    const contextMenuShow = vi.fn(
      async (_items: Parameters<NativeApi["contextMenu"]["show"]>[0]) => "new-thread-in-workspace",
    );
    const exactWorktreeBranchResult: Awaited<ReturnType<NativeApi["git"]["listBranches"]>> = {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: "feature/staged-route-race",
          current: false,
          isDefault: false,
          worktreePath: "/repo/worktrees/staged-route-race",
        },
      ],
    };
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-staged-route-reuse-race" as MessageId,
      targetText: "staged route reuse race",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) => ({
          ...thread,
          envMode: "worktree" as const,
          branch: "feature/staged-route-race",
          worktreePath: "/repo/worktrees/staged-route-race",
        })),
      },
      configureNativeApi: (api) => ({
        ...api,
        contextMenu: {
          ...api.contextMenu,
          show: contextMenuShow as NativeApi["contextMenu"]["show"],
        },
        git: {
          ...api.git,
          listBranches: vi.fn(async () => exactWorktreeBranchResult),
        },
      }),
    });
    let releaseFirstNavigation!: () => void;
    const firstNavigationBlocker = new Promise<void>((resolve) => {
      releaseFirstNavigation = resolve;
    });
    const originalNavigate = mounted.router.navigate.bind(mounted.router);
    let navigationCount = 0;
    const navigateSpy = vi.spyOn(mounted.router, "navigate").mockImplementation((options) => {
      navigationCount += 1;
      const navigation = originalNavigate(options);
      return navigationCount === 1 ? navigation.then(() => firstNavigationBlocker) : navigation;
    });

    try {
      await waitForServerConfigToApply();
      await waitForComposerEditor();
      useStore.getState().setProjectExpanded(PROJECT_ID, true);
      await waitForLayout();
      const threadRow = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-thread-entry-point]")).find(
            (row) => row.textContent?.includes(THREAD_TITLE),
          ) ?? null,
        "Unable to find the current thread row.",
      );
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, reusableDraftThreadId, {
        entryPoint: "chat",
        envMode: "local",
        branch: null,
        worktreePath: null,
        workspaceOrigin: "default",
      });
      useComposerDraftStore.getState().setPrompt(reusableDraftThreadId, "keep staged-race prompt");
      useComposerDraftStore.getState().addFiles(reusableDraftThreadId, [
        {
          type: "file",
          id: "staged-route-race-notes",
          name: "staged-route-race.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          file: new File(["notes"], "staged-route-race.txt", { type: "text/plain" }),
        },
      ]);

      threadRow.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 24,
        }),
      );
      await vi.waitFor(() => expect(contextMenuShow).toHaveBeenCalledOnce());
      const stagedThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "The older exact-workspace draft should become visible before navigation settles.",
      );
      const stagedThreadId = stagedThreadPath.slice(1) as ThreadId;
      expect(stagedThreadId).not.toBe(reusableDraftThreadId);

      await page.getByTestId("new-thread-button").click();
      await waitForURL(
        mounted.router,
        (path) => path === `/${reusableDraftThreadId}`,
        "The later ordinary action should reuse the durable mapped draft.",
      );
      releaseFirstNavigation();
      await waitForDraftNavigationIdle(draftNavigationSlotKey());

      expect(
        useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID, "chat")?.threadId,
      ).toBe(reusableDraftThreadId);
      expect(
        useComposerDraftStore.getState().draftsByThreadId[reusableDraftThreadId],
      ).toMatchObject({
        prompt: "keep staged-race prompt",
        files: [
          expect.objectContaining({
            id: "staged-route-race-notes",
            name: "staged-route-race.txt",
          }),
        ],
      });
      expect(useComposerDraftStore.getState().getDraftThread(stagedThreadId)).toBeNull();
      expect(mounted.router.state.location.pathname).toBe(`/${reusableDraftThreadId}`);
    } finally {
      releaseFirstNavigation();
      await waitForDraftNavigationIdle(draftNavigationSlotKey());
      navigateSpy.mockRestore();
      await mounted.cleanup();
    }
  });

  it("keeps a later terminal intent and preserves chat attachments across entry points", async () => {
    const reusableChatDraftId = ThreadId.makeUnsafe("thread-cross-entry-chat-draft");
    const reusableTerminalDraftId = ThreadId.makeUnsafe("thread-cross-entry-terminal-draft");
    const contextMenuShow = vi.fn(
      async (_items: Parameters<NativeApi["contextMenu"]["show"]>[0]) => "new-thread-in-workspace",
    );
    const exactWorktreeBranchResult: Awaited<ReturnType<NativeApi["git"]["listBranches"]>> = {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: "feature/exact-worktree",
          current: false,
          isDefault: false,
          worktreePath: "/repo/worktrees/exact-worktree",
        },
      ],
    };
    let resolveExactValidation!: (
      value: Awaited<ReturnType<NativeApi["git"]["listBranches"]>>,
    ) => void;
    const exactValidation = new Promise<Awaited<ReturnType<NativeApi["git"]["listBranches"]>>>(
      (resolve) => {
        resolveExactValidation = resolve;
      },
    );
    const branchLookup = vi.fn<NativeApi["git"]["listBranches"]>(
      async () => exactWorktreeBranchResult,
    );
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-cross-entry-race" as MessageId,
      targetText: "cross entry race",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) =>
          Object.assign({}, thread, {
            envMode: "worktree" as const,
            branch: "feature/exact-worktree",
            worktreePath: "/repo/worktrees/exact-worktree",
          }),
        ),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.newTerminal",
              shortcut: {
                key: "t",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
      configureNativeApi: (api) => ({
        ...api,
        contextMenu: {
          ...api.contextMenu,
          show: contextMenuShow as NativeApi["contextMenu"]["show"],
        },
        git: {
          ...api.git,
          listBranches: branchLookup,
        },
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      useStore.getState().setProjectExpanded(PROJECT_ID, true);
      await waitForLayout();
      const threadRow = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-thread-entry-point]")).find(
            (row) => row.textContent?.includes(THREAD_TITLE),
          ) ?? null,
        "Unable to find the current thread row.",
      );
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, reusableChatDraftId, {
        entryPoint: "chat",
        envMode: "local",
        branch: null,
        worktreePath: null,
        workspaceOrigin: "default",
      });
      useComposerDraftStore.getState().setPrompt(reusableChatDraftId, "cross-entry prompt");
      useComposerDraftStore.getState().addFiles(reusableChatDraftId, [
        {
          type: "file",
          id: "cross-entry-notes",
          name: "cross-entry.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          file: new File(["notes"], "cross-entry.txt", { type: "text/plain" }),
        },
      ]);
      useComposerDraftStore
        .getState()
        .setProjectDraftThreadId(PROJECT_ID, reusableTerminalDraftId, {
          entryPoint: "terminal",
          envMode: "local",
          branch: null,
          worktreePath: null,
          workspaceOrigin: "default",
        });
      branchLookup.mockClear();
      branchLookup.mockImplementation(() => exactValidation);

      threadRow.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 24,
        }),
      );
      await vi.waitFor(() => expect(branchLookup).toHaveBeenCalledTimes(1));

      await dispatchTerminalThreadShortcut();
      resolveExactValidation(exactWorktreeBranchResult);
      await waitForDraftNavigationIdle(draftNavigationSlotKey());

      expect(
        useComposerDraftStore.getState().projectDraftThreadIdByProjectId[`${PROJECT_ID}::terminal`],
      ).toBe(reusableTerminalDraftId);
      expect(
        useComposerDraftStore.getState().getDraftThread(reusableTerminalDraftId),
      ).toMatchObject({
        entryPoint: "terminal",
        promotedTo: reusableTerminalDraftId,
      });
      expect(mounted.router.state.location.pathname).toBe(`/${reusableTerminalDraftId}`);
      expect(
        useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID, "chat")?.threadId,
      ).toBe(reusableChatDraftId);
      expect(useComposerDraftStore.getState().draftsByThreadId[reusableChatDraftId]).toMatchObject({
        prompt: "cross-entry prompt",
        files: [expect.objectContaining({ id: "cross-entry-notes", name: "cross-entry.txt" })],
      });
    } finally {
      resolveExactValidation(exactWorktreeBranchResult);
      await waitForDraftNavigationIdle(draftNavigationSlotKey());
      await mounted.cleanup();
    }
  });

  it("fails closed with a visible error when an exact worktree moved", async () => {
    const contextMenuShow = vi.fn(
      async (_items: Parameters<NativeApi["contextMenu"]["show"]>[0]) => "new-thread-in-workspace",
    );
    const exactWorktreeBranchResult: Awaited<ReturnType<NativeApi["git"]["listBranches"]>> = {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: "feature/exact-worktree",
          current: false,
          isDefault: false,
          worktreePath: "/repo/worktrees/exact-worktree",
        },
      ],
    };
    const movedWorktreeBranchResult: Awaited<ReturnType<NativeApi["git"]["listBranches"]>> = {
      ...exactWorktreeBranchResult,
      branches: [
        {
          ...exactWorktreeBranchResult.branches[0]!,
          worktreePath: "/repo/worktrees/moved-worktree",
        },
      ],
    };
    const branchLookup = vi.fn<NativeApi["git"]["listBranches"]>(
      async () => exactWorktreeBranchResult,
    );
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-context-worktree-moved" as MessageId,
      targetText: "context worktree moved",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) => ({
          ...thread,
          envMode: "worktree" as const,
          branch: "feature/exact-worktree",
          worktreePath: "/repo/worktrees/exact-worktree",
        })),
      },
      configureNativeApi: (api) => ({
        ...api,
        contextMenu: {
          ...api.contextMenu,
          show: contextMenuShow as NativeApi["contextMenu"]["show"],
        },
        git: {
          ...api.git,
          listBranches: branchLookup,
        },
      }),
    });

    try {
      await vi.waitFor(() => expect(branchLookup).toHaveBeenCalled());
      branchLookup.mockClear();
      branchLookup.mockResolvedValue(movedWorktreeBranchResult);
      const startingPath = mounted.router.state.location.pathname;
      const startingDraftIds = Object.keys(
        useComposerDraftStore.getState().draftThreadsByThreadId,
      ).toSorted();
      const threadRow = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-thread-entry-point]")).find(
            (row) => row.textContent?.includes(THREAD_TITLE),
          ) ?? null,
        "Unable to find the current thread row.",
      );

      threadRow.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 24,
        }),
      );

      await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="toast-title"]')).find(
            (element) => element.textContent === "Workspace changed",
          ) ?? null,
        "A moved exact worktree should show a visible Workspace changed error.",
      );
      expect(mounted.router.state.location.pathname).toBe(startingPath);
      expect(
        Object.keys(useComposerDraftStore.getState().draftThreadsByThreadId).toSorted(),
      ).toEqual(startingDraftIds);
    } finally {
      await mounted.cleanup();
    }
  });

  it("promotes terminal-first shortcut threads so they render as terminal rows", async () => {
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-terminal-shortcut-test" as MessageId,
      targetText: "terminal shortcut test",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) => ({
          ...thread,
          envMode: "worktree" as const,
          branch: "feature/viewed-terminal-worktree",
          worktreePath: "/repo/worktrees/viewed-terminal-worktree",
        })),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.newTerminal",
              shortcut: {
                key: "t",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
      configureNativeApi: (api) => ({
        ...api,
        server: {
          ...api.server,
          getSettings: async () => ({
            ...DEFAULT_SERVER_SETTINGS,
            defaultThreadEnvMode: "worktree",
          }),
        },
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      const newThreadPath = await triggerTerminalThreadShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new terminal-first draft thread UUID from the shortcut.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                typeof request.command === "object" &&
                request.command !== null &&
                "type" in request.command &&
                "threadId" in request.command &&
                request.command.type === "thread.create" &&
                request.command.threadId === newThreadId,
            ),
          ).toBe(true);
        },
        { timeout: 20_000, interval: 16 },
      );
      const terminalCreateRequest = wsRequests.find(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          typeof request.command === "object" &&
          request.command !== null &&
          "type" in request.command &&
          "threadId" in request.command &&
          request.command.type === "thread.create" &&
          request.command.threadId === newThreadId,
      );
      expect(terminalCreateRequest?.command).toMatchObject({
        envMode: "local",
        branch: null,
        worktreePath: null,
      });

      // The shortcut persists terminal-first presentation separately from the
      // server thread row. Observe that state before simulating promotion so
      // clearing the draft cannot race the shortcut's async UI update.
      await vi.waitFor(
        () => {
          expect(
            useTerminalStateStore.getState().terminalStateByThreadId[newThreadId]?.entryPoint,
          ).toBe("terminal");
        },
        { timeout: 8_000, interval: 16 },
      );

      useStore.getState().syncServerReadModel(addThreadToSnapshot(fixture.snapshot, newThreadId));
      useStore.getState().setProjectExpanded(PROJECT_ID, true);
      useComposerDraftStore.getState().clearDraftThread(newThreadId);

      await vi.waitFor(
        () => {
          expect(
            wsRequests.find(
              (request) =>
                request._tag === WS_METHODS.terminalOpen && request.threadId === newThreadId,
            ),
          ).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: newThreadId,
            cwd: "/repo/project",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const terminalThreadRow = document.querySelector<HTMLElement>(
            '[data-thread-entry-point="terminal"]',
          );
          expect(terminalThreadRow).not.toBeNull();
          expect(terminalThreadRow?.textContent).toContain("New thread");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("promotes a stored terminal draft using its saved context and model selection", async () => {
    const draftThreadId = ThreadId.makeUnsafe("thread-terminal-draft-reuse");
    useComposerDraftStore.setState({
      draftsByThreadId: {
        [draftThreadId]: {
          prompt: "",
          promptHistorySavedDraft: null,
          images: [],
          files: [],
          nonPersistedImageIds: [],
          persistedAttachments: [],
          assistantSelections: [],
          terminalContexts: [],
          fileComments: [],
          pastedTexts: [],
          skills: [],
          mentions: [],
          queuedTurns: [],
          modelSelectionByProvider: {
            claudeAgent: {
              provider: "claudeAgent",
              model: "claude-opus-4-6",
              options: {
                effort: "max",
              },
            },
          },
          activeProvider: "claudeAgent",
          runtimeMode: null,
          interactionMode: null,
        },
      },
      draftThreadsByThreadId: {
        [draftThreadId]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "approval-required",
          interactionMode: "default",
          entryPoint: "terminal",
          branch: "feature/terminal-title",
          worktreePath: "/repo/project/.worktrees/terminal-title",
          envMode: "worktree",
          workspaceOrigin: "intentional",
        },
      },
      projectDraftThreadIdByProjectId: {
        [`${PROJECT_ID}::terminal`]: draftThreadId,
      },
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-draft-reuse-test" as MessageId,
        targetText: "terminal draft reuse test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.newTerminal",
              shortcut: {
                key: "t",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      await dispatchTerminalThreadShortcut();

      await waitForURL(
        mounted.router,
        (path) => path === `/${draftThreadId}`,
        "Shortcut should reuse the stored terminal draft thread route.",
      );

      await vi.waitFor(
        () => {
          const createRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              "threadId" in request.command &&
              request.command.type === "thread.create" &&
              request.command.threadId === draftThreadId,
          );

          expect(createRequest).toBeTruthy();
          expect(createRequest?.command).toMatchObject({
            branch: "feature/terminal-title",
            worktreePath: "/repo/project/.worktrees/terminal-title",
            runtimeMode: "approval-required",
            modelSelection: {
              provider: "claudeAgent",
              model: "claude-opus-4-6",
              options: {
                effort: "max",
              },
            },
          });
        },
        { timeout: 20_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("enables plan mode from the composer extras menu", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-plan-mode-toggle-test" as MessageId,
        targetText: "plan mode toggle test",
      }),
    });

    try {
      await page.getByLabelText("Composer extras").click();
      await page.getByText("Plan mode").click();

      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode).toBe(
          "plan",
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("distinguishes plan mode from the plan details sidebar button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSettledPlanAwaitingFollowUp(),
    });

    try {
      await waitForServerConfigToApply();
      const footer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
        "Unable to find composer footer.",
      );

      await vi.waitFor(() => {
        const buttonLabels = Array.from(footer.querySelectorAll("button"))
          .map((button) => button.textContent?.trim() ?? "")
          .filter(Boolean);

        expect(buttonLabels.filter((label) => label === "Plan")).toHaveLength(1);
        expect(buttonLabels).toContain("Plan details");
        expect(document.querySelector('button[title="Show plan sidebar"]')).toBeNull();
      });
      await expect
        .element(page.getByTitle("Plan mode — click to return to normal build mode"))
        .toBeInTheDocument();
      await expect.element(page.getByLabelText("Show plan details sidebar")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a fresh draft after the previous draft thread is promoted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoted-draft-shortcut-test" as MessageId,
        targetText: "promoted draft shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      await newThreadButton.click();

      const promotedThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a promoted draft thread UUID.",
      );
      const promotedThreadId = promotedThreadPath.slice(1) as ThreadId;

      const { syncServerReadModel } = useStore.getState();
      syncServerReadModel(addThreadToSnapshot(fixture.snapshot, promotedThreadId));
      useComposerDraftStore.getState().clearDraftThread(promotedThreadId);

      const freshThreadPath = await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== promotedThreadPath,
        "Shortcut should create a fresh draft instead of reusing the promoted thread.",
      );
      expect(freshThreadPath).not.toBe(promotedThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps long proposed plans lightweight until the user expands them", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongProposedPlan(),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );

      expect(document.body.textContent).not.toContain("deep hidden detail only after expand");

      const expandButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );
      expandButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("deep hidden detail only after expand");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps proposed plans inline until execution starts", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongProposedPlan(),
    });

    try {
      await expect.element(page.getByText("Expand plan")).toBeInTheDocument();
      expect(document.querySelector('[aria-label="Close plan sidebar"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the skinny inline plan card for active turn plans", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithActiveInlinePlan(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("1 out of 3 tasks completed");
          expect(document.body.textContent).toContain("Inspecting ChatView boundaries");
          expect(document.body.textContent).toContain("Patch the shared checklist receiver");
          expect(document.body.textContent).toContain("1 background agent");
        },
        { timeout: 8_000, interval: 16 },
      );

      const transcriptPane = document.querySelector<HTMLElement>("[data-chat-transcript-pane]");
      const taskListCard = document.querySelector<HTMLElement>(
        '[data-testid="active-task-list-card"]',
      );
      const composerShell = document.querySelector<HTMLElement>(
        'form[data-chat-composer-form="true"] .chat-composer-shell',
      );
      expect(transcriptPane).not.toBeNull();
      expect(taskListCard).not.toBeNull();
      expect(composerShell).not.toBeNull();
      expect(transcriptPane!.getBoundingClientRect().bottom).toBeGreaterThan(
        taskListCard!.getBoundingClientRect().top + 1,
      );
      // Active plan activity shares the centered queued-follow-up rail, intentionally inset to
      // eleven twelfths of the composer width while the input keeps its rounded top corners.
      const taskRect = taskListCard!.getBoundingClientRect();
      const composerRect = composerShell!.getBoundingClientRect();
      expect(Math.abs(taskRect.width - (composerRect.width * 11) / 12)).toBeLessThanOrEqual(2);
      expect(
        Math.abs(taskRect.left + taskRect.width / 2 - (composerRect.left + composerRect.width / 2)),
      ).toBeLessThanOrEqual(1);
      expect(parseFloat(getComputedStyle(composerShell!).borderTopLeftRadius)).toBeGreaterThan(0);

      const openPlanButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[title="Open tasks sidebar"]'),
        "Unable to find inline active plan sidebar button.",
      );
      openPlanButton.click();

      await expect.element(page.getByLabelText("Close plan sidebar")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides an unfinished task list once the latest turn is settled", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSettledInlinePlan(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Finished the investigation.");
          expect(document.body.textContent).not.toContain("1 out of 3 tasks completed");
          expect(document.querySelector('[data-testid="active-task-list-card"]')).toBeNull();
          expect(document.body.textContent).not.toContain("1 background agent");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides a completed task list once the latest turn is settled", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSettledCompletedInlinePlan(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Finished the investigation.");
          expect(document.body.textContent).not.toContain("3 out of 3 tasks completed");
          expect(document.querySelector('[data-testid="active-task-list-card"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the stop button once a completed turn is no longer live", async () => {
    const settledSnapshot = createSnapshotWithSettledInlinePlan();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...settledSnapshot,
        threads: settledSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                messages: thread.messages.map((message) =>
                  message.role === "assistant"
                    ? {
                        ...message,
                        streaming: true,
                      }
                    : message,
                ),
              }
            : thread,
        ),
      },
    });

    try {
      await vi.waitFor(
        () => {
          expect(
            document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the live inline-tool layout through the first settled paint, then relaxes after the grace delay", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithInlineToolOverflow({ active: true }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Tool 6");
          expect(document.body.textContent).not.toContain("Tool 1");
        },
        { timeout: 8_000, interval: 16 },
      );

      const settledSnapshot = createSnapshotWithInlineToolOverflow({ active: false });
      fixture = { ...fixture, snapshot: settledSnapshot };
      useStore.getState().syncServerReadModel(settledSnapshot);

      expect(document.body.textContent).toContain("Tool 6");
      expect(document.body.textContent).not.toContain("Tool 1");

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 260);
      });

      // Once the grace delay lapses the settled turn folds into "Worked for…",
      // but the old details stay mounted briefly inside the shared disclosure
      // close transition so the transcript height eases down instead of snapping.
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Worked for");
          const transitionClone = document.querySelector(
            "[data-settled-turn-collapse-transition='true']",
          );
          expect(transitionClone).not.toBeNull();
          expect(transitionClone?.hasAttribute("inert")).toBe(true);
          expect(transitionClone?.querySelector("[aria-hidden='true'][inert]")).not.toBeNull();
          expect(document.body.textContent).toContain("Tool 6");
        },
        { timeout: 8_000, interval: 16 },
      );

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 320);
      });

      // After the close motion finishes, details are only available by opening
      // the "Worked for…" disclosure.
      await vi.waitFor(
        () => {
          expect(
            document.querySelector("[data-settled-turn-collapse-transition='true']"),
          ).toBeNull();
          expect(document.body.textContent).not.toContain("Tool 1");
          expect(document.body.textContent).not.toContain("Tool 6");
        },
        { timeout: 20_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
