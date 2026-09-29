// @effect-diagnostics nodeBuiltinImport:off -- test fixtures are local OS-opened files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import {
  cancelOpenedConversationFileUploadFor,
  listenForOpenedConversationFiles,
  makeOpenedPathRelay,
  registerOpenedConversationFile,
  releaseOpenedConversationFileFor,
  remoteUploadApprovalOptions,
  takeOpenedConversationFileList,
  uploadOpenedConversationFileTo,
  uploadTarget,
} from "./openedConversationFiles.ts";

const permitted = new Set(["http://127.0.0.1:31234"]);
const route = "/api/scient/conversation-import/v1/upload/payload.signature";
const remoteUrl = `https://remote.example.com${route}`;
const lanUrl = `http://192.168.1.20:3773${route}`;
const tailscaleIpUrl = `http://100.84.12.7:3773${route}`;
const directories: string[] = [];
let attempts = 0;
/** Each upload call is its own attempt. */
const nextAttemptId = () => `attempt-${++attempts}`;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

async function openedFile(
  name = "opened.scic",
  contents: string | Uint8Array = "portable conversation",
) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-opened-scic-"));
  directories.push(directory);
  const path = NodePath.join(directory, name);
  NodeFS.writeFileSync(path, contents);
  expect(await registerOpenedConversationFile(path)).toBe(true);
  const [file] = takeOpenedConversationFileList();
  if (!file) throw new Error("The opened file was not returned to the renderer.");
  return file;
}

describe("OS-opened conversation file upload target", () => {
  it("accepts managed backends and requires approval for remote HTTPS and HTTP", () => {
    expect(uploadTarget(`http://127.0.0.1:31234${route}`, permitted)).toMatchObject({
      requiresApproval: false,
      plaintextNetwork: false,
    });
    expect(uploadTarget(remoteUrl, permitted)).toMatchObject({
      requiresApproval: true,
      plaintextNetwork: false,
    });
    expect(uploadTarget(`http://127.0.0.1:31235${route}`, permitted)).toMatchObject({
      requiresApproval: true,
      plaintextNetwork: false,
    });
    for (const url of [lanUrl, tailscaleIpUrl]) {
      expect(uploadTarget(url, permitted)).toMatchObject({
        requiresApproval: true,
        plaintextNetwork: true,
      });
    }
    expect(uploadTarget(lanUrl, new Set([...permitted, "http://192.168.1.20:3773"]))).toMatchObject(
      {
        requiresApproval: false,
        plaintextNetwork: false,
      },
    );
  });

  it("shows a conspicuous HTTP warning with the canonical origin and a cancel default", () => {
    const origin = uploadTarget("http://LAN.example.com:80" + route, permitted)?.url.origin;
    expect(origin).toBe("http://lan.example.com");
    const options = remoteUploadApprovalOptions(origin!, "opened.scic", true);
    expect(options.type).toBe("warning");
    expect(options.title).toContain("no TLS");
    expect(options.message).toContain("http://lan.example.com");
    expect(options.message).toContain("opened.scic");
    expect(options.detail).toContain("unprotected network");
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(0);
  });

  it("rejects unrelated routes, credentials, redirects, and encoded path tricks", () => {
    expect(uploadTarget(`http://127.0.0.1:31234/other`, permitted)).toBeNull();
    expect(uploadTarget(`http://127.0.0.1:31234${route}?redirect=evil`, permitted)).toBeNull();
    expect(uploadTarget(`http://user:pass@127.0.0.1:31234${route}`, permitted)).toBeNull();
    expect(uploadTarget(`${remoteUrl}#fragment`, permitted)).toBeNull();
    expect(uploadTarget(`${remoteUrl}/extra`, permitted)).toBeNull();
    expect(
      uploadTarget(remoteUrl.replace("payload.signature", "payload%2Esignature"), permitted),
    ).toBeNull();
    expect(uploadTarget("file:///tmp/opened.scic", permitted)).toBeNull();
  });
});

describe("OS-opened conversation file upload retry", () => {
  it("rejects remote HTTP without per-file approval and uploads after explicit approval", async () => {
    const file = await openedFile();
    let approvals = 0;
    let requests = 0;
    const approveRemote = async (origin: string, fileName: string, plaintextNetwork: boolean) => {
      expect(origin).toBe("http://192.168.1.20:3773");
      expect(fileName).toBe("opened.scic");
      expect(plaintextNetwork).toBe(true);
      approvals += 1;
      return approvals === 2;
    };
    const fetchImpl: typeof fetch = async (_input, init) => {
      requests += 1;
      expect(init?.redirect).toBe("error");
      expect(await new Response(init?.body).text()).toBe("portable conversation");
      return new Response(null, { status: 204 });
    };
    expect(
      await uploadOpenedConversationFileTo(
        { token: file.token, attemptId: nextAttemptId(), url: lanUrl },
        permitted,
        approveRemote,
        fetchImpl,
      ),
    ).toEqual({ _tag: "failed", reason: "declined" });
    expect(requests).toBe(0);
    expect(
      await uploadOpenedConversationFileTo(
        {
          token: file.token,
          attemptId: nextAttemptId(),
          url: lanUrl.replace("payload.signature", "fresh.signature"),
        },
        permitted,
        approveRemote,
        fetchImpl,
      ),
    ).toEqual({ _tag: "uploaded" });
    expect(approvals).toBe(2);
    expect(requests).toBe(1);
  });

  it("retains the token after an invalid URL, declined approval, upload failures, and success", async () => {
    const file = await openedFile();
    let approvals = 0;
    const approveRemote = async (origin: string, fileName: string) => {
      expect(origin).toBe("https://remote.example.com");
      expect(fileName).toBe("opened.scic");
      approvals += 1;
      return approvals > 1;
    };
    let requests = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requests += 1;
      expect(init?.redirect).toBe("error");
      expect(await new Response(init?.body).text()).toBe("portable conversation");
      if (requests === 1) throw new Error("connection lost");
      if (requests === 2) return new Response(null, { status: 503 });
      return new Response(null, { status: 204 });
    };
    const upload = (url: string) =>
      uploadOpenedConversationFileTo(
        { token: file.token, attemptId: nextAttemptId(), url },
        permitted,
        approveRemote,
        fetchImpl,
      );

    expect(await upload("https://remote.example.com/other")).toEqual({
      _tag: "failed",
      reason: "invalid-url",
    });
    expect(await upload(remoteUrl.replace("remote.example.com", "REMOTE.example.com:443"))).toEqual(
      {
        _tag: "failed",
        reason: "declined",
      },
    );
    expect(requests).toBe(0);
    expect(await upload(remoteUrl)).toEqual({ _tag: "failed", reason: "network-failed" });
    expect(await upload(remoteUrl.replace("payload.signature", "fresh.signature"))).toEqual({
      _tag: "failed",
      reason: "rejected",
    });
    expect(await upload(remoteUrl.replace("payload.signature", "newer.signature"))).toEqual({
      _tag: "uploaded",
    });
    // Preview can fail after a successful upload; it needs another fresh signed URL.
    expect(await upload(remoteUrl.replace("payload.signature", "again.signature"))).toEqual({
      _tag: "uploaded",
    });
    expect(approvals).toBe(2);
    expect(requests).toBe(4);
  });

  it("requires separate native approval for each opened file", async () => {
    const first = await openedFile();
    const second = await openedFile("another.scic");
    const approvedFiles: string[] = [];
    const approveRemote = async (_origin: string, fileName: string) => {
      approvedFiles.push(fileName);
      return true;
    };
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(await new Response(init?.body).text()).toBe("portable conversation");
      return new Response(null, { status: 204 });
    };
    const upload = (token: string, url: string) =>
      uploadOpenedConversationFileTo(
        { token, attemptId: nextAttemptId(), url },
        permitted,
        approveRemote,
        fetchImpl,
      );

    expect(await upload(first.token, remoteUrl)).toEqual({ _tag: "uploaded" });
    expect(
      await upload(first.token, remoteUrl.replace("payload.signature", "retry.signature")),
    ).toEqual({
      _tag: "uploaded",
    });
    expect(await upload(second.token, remoteUrl)).toEqual({ _tag: "uploaded" });
    expect(approvedFiles).toEqual(["opened.scic", "another.scic"]);
  });

  it("refuses a concurrent replay of the same opened-file token", async () => {
    const file = await openedFile();
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(await new Response(init?.body).text()).toBe("portable conversation");
      signalStarted();
      await blocked;
      return new Response(null, { status: 204 });
    };
    const request = {
      token: file.token,
      attemptId: nextAttemptId(),
      url: `http://127.0.0.1:31234${route}`,
    };
    const approveRemote = async () => false;
    const first = uploadOpenedConversationFileTo(request, permitted, approveRemote, fetchImpl);
    await started;
    const replay = await uploadOpenedConversationFileTo(
      request,
      permitted,
      approveRemote,
      fetchImpl,
    );
    release();
    expect(replay).toEqual({ _tag: "failed", reason: "file-unavailable" });
    expect(await first).toEqual({ _tag: "uploaded" });
  });

  it("never follows a response redirect with the OS-opened file", async () => {
    const file = await openedFile();
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(init?.redirect).toBe("error");
      throw new Error("redirect refused");
    };
    const result = await uploadOpenedConversationFileTo(
      { token: file.token, attemptId: nextAttemptId(), url: `http://127.0.0.1:31234${route}` },
      permitted,
      async () => {
        throw new Error("Managed backend should not request approval.");
      },
      fetchImpl,
    );
    expect(result).toEqual({ _tag: "failed", reason: "network-failed" });
  });
});

describe("OS-opened conversation file upload outcomes", () => {
  const managedUrl = `http://127.0.0.1:31234${route}`;
  const managed = new Set(["http://127.0.0.1:31234"]);

  it("tells a declined send from a server refusal", async () => {
    const file = await openedFile();
    let requests = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requests += 1;
      await new Response(init?.body).arrayBuffer();
      return new Response(null, { status: 409 });
    };
    expect(
      await uploadOpenedConversationFileTo(
        { token: file.token, attemptId: nextAttemptId(), url: remoteUrl },
        permitted,
        async () => false,
        fetchImpl,
      ),
    ).toEqual({ _tag: "failed", reason: "declined" });
    expect(requests).toBe(0);
    expect(
      await uploadOpenedConversationFileTo(
        { token: file.token, attemptId: nextAttemptId(), url: managedUrl },
        managed,
        async () => false,
        fetchImpl,
      ),
    ).toEqual({ _tag: "failed", reason: "rejected" });
    expect(requests).toBe(1);
  });

  /** A fetch that reads the first chunk, then waits for its signal to abort. */
  function abortableFetch() {
    let firstChunk: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      firstChunk = resolve;
    });
    const state: {
      signal: AbortSignal | undefined;
      readAfterCancel: "failed" | "continued" | null;
    } = { signal: undefined, readAfterCancel: null };
    const fetchImpl: typeof fetch = async (_input, init) => {
      state.signal = init?.signal ?? undefined;
      const body = init?.body as ReadableStream<Uint8Array> | undefined;
      if (body === undefined) throw new Error("The upload has no body.");
      const reader = body.getReader();
      await reader.read();
      firstChunk();
      await new Promise((resolve) =>
        state.signal?.addEventListener("abort", resolve, { once: true }),
      );
      state.readAfterCancel = await reader.read().then(
        () => "continued" as const,
        () => "failed" as const,
      );
      throw new DOMException("The upload was aborted.", "AbortError");
    };
    return { fetchImpl, started, state };
  }

  const countingFetch = () => {
    const sent: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      sent.push(await new Response(init?.body).text());
      return new Response(null, { status: 204 });
    };
    return { fetchImpl, sent };
  };

  it("stops the request and the file read when an attempt is cancelled midway, then sends a new attempt", async () => {
    const file = await openedFile("large.scic", new Uint8Array(4 * 1024 * 1024));
    const { fetchImpl, started, state } = abortableFetch();
    const uploading = uploadOpenedConversationFileTo(
      { token: file.token, attemptId: "attempt-a", url: managedUrl },
      managed,
      async () => false,
      fetchImpl,
    );
    await started;
    cancelOpenedConversationFileUploadFor({ token: file.token, attemptId: "attempt-a" });
    expect(await uploading).toEqual({ _tag: "failed", reason: "cancelled" });
    expect(state.signal?.aborted).toBe(true);
    // The file stream was closed under the request's body.
    expect(state.readAfterCancel).toBe("failed");

    // A new destination or "Try again" is a new attempt on the same file.
    const retry = countingFetch();
    expect(
      await uploadOpenedConversationFileTo(
        { token: file.token, attemptId: "attempt-b", url: managedUrl },
        managed,
        async () => false,
        retry.fetchImpl,
      ),
    ).toEqual({ _tag: "uploaded" });
    expect(retry.sent).toHaveLength(1);
    expect(retry.sent[0]).toHaveLength(4 * 1024 * 1024);
  });

  it("sends nothing for an attempt cancelled before it started, and still sends the next", async () => {
    const file = await openedFile();
    const { fetchImpl, sent } = countingFetch();
    cancelOpenedConversationFileUploadFor({ token: file.token, attemptId: "attempt-a" });
    const upload = (attemptId: string) =>
      uploadOpenedConversationFileTo(
        { token: file.token, attemptId, url: managedUrl },
        managed,
        async () => true,
        fetchImpl,
      );
    expect(await upload("attempt-a")).toEqual({ _tag: "failed", reason: "cancelled" });
    expect(sent).toHaveLength(0);
    expect(await upload("attempt-b")).toEqual({ _tag: "uploaded" });
    expect(sent).toEqual(["portable conversation"]);
    // An unknown token is ignored.
    cancelOpenedConversationFileUploadFor({ token: "unknown-token", attemptId: "attempt-a" });
  });

  it("sends nothing when the attempt is cancelled while the send is awaiting approval", async () => {
    const file = await openedFile();
    const { fetchImpl, sent } = countingFetch();
    const result = await uploadOpenedConversationFileTo(
      { token: file.token, attemptId: "attempt-a", url: remoteUrl },
      permitted,
      async () => {
        cancelOpenedConversationFileUploadFor({ token: file.token, attemptId: "attempt-a" });
        return true;
      },
      fetchImpl,
    );
    expect(result).toEqual({ _tag: "failed", reason: "cancelled" });
    expect(sent).toHaveLength(0);
  });

  it("forgets a released file: an upload in progress stops and later ones fail", async () => {
    const file = await openedFile("large.scic", new Uint8Array(4 * 1024 * 1024));
    const { fetchImpl, started, state } = abortableFetch();
    const uploading = uploadOpenedConversationFileTo(
      { token: file.token, attemptId: "attempt-a", url: managedUrl },
      managed,
      async () => false,
      fetchImpl,
    );
    await started;
    releaseOpenedConversationFileFor(file.token);
    expect(await uploading).toEqual({ _tag: "failed", reason: "cancelled" });
    expect(state.signal?.aborted).toBe(true);

    const later = countingFetch();
    expect(
      await uploadOpenedConversationFileTo(
        { token: file.token, attemptId: "attempt-b", url: managedUrl },
        managed,
        async () => false,
        later.fetchImpl,
      ),
    ).toEqual({ _tag: "failed", reason: "file-unavailable" });
    expect(later.sent).toHaveLength(0);
    // Releasing again, or an unknown token, is ignored.
    releaseOpenedConversationFileFor(file.token);
  });
});

describe("the file an OS-opened upload sends", () => {
  const managedUrl = `http://127.0.0.1:31234${route}`;
  const managed = new Set(["http://127.0.0.1:31234"]);

  async function openedAt(contents = "portable conversation") {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-opened-scic-"));
    directories.push(directory);
    const path = NodePath.join(directory, "opened.scic");
    NodeFS.writeFileSync(path, contents);
    expect(await registerOpenedConversationFile(path)).toBe(true);
    const [file] = takeOpenedConversationFileList();
    if (!file) throw new Error("The opened file was not returned to the renderer.");
    return { file, path, directory };
  }

  /** Records what each request carried. */
  function recordingFetch() {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(await new Response(init?.body).text());
      return new Response(null, { status: 204 });
    };
    return { bodies, fetchImpl };
  }

  it("sends the opened file, never a replacement put at its path during the prompt", async () => {
    const { file, path, directory } = await openedAt();
    const { bodies, fetchImpl } = recordingFetch();
    const replacement = NodePath.join(directory, "replacement.scic");
    // Same size, so only the file's identity can tell them apart.
    NodeFS.writeFileSync(replacement, "PORTABLE CONVERSATION");
    const result = await uploadOpenedConversationFileTo(
      { token: file.token, attemptId: nextAttemptId(), url: remoteUrl },
      permitted,
      async () => {
        NodeFS.renameSync(replacement, path);
        return true;
      },
      fetchImpl,
    );
    expect(result).toEqual({ _tag: "uploaded" });
    expect(bodies).toEqual(["portable conversation"]);
    // A later attempt finds another file at the path and sends nothing.
    expect(
      await uploadOpenedConversationFileTo(
        { token: file.token, attemptId: nextAttemptId(), url: managedUrl },
        managed,
        async () => true,
        fetchImpl,
      ),
    ).toEqual({ _tag: "failed", reason: "file-changed" });
    expect(bodies).toHaveLength(1);
  });

  it("refuses a file whose size changed, before the prompt or during it", async () => {
    const { file, path } = await openedAt();
    const { bodies, fetchImpl } = recordingFetch();
    let prompts = 0;
    const approve = async () => {
      prompts += 1;
      return true;
    };
    NodeFS.appendFileSync(path, " and more");
    expect(
      await uploadOpenedConversationFileTo(
        { token: file.token, attemptId: nextAttemptId(), url: remoteUrl },
        permitted,
        approve,
        fetchImpl,
      ),
    ).toEqual({ _tag: "failed", reason: "file-changed" });
    expect(prompts).toBe(0);

    const second = await openedAt();
    expect(
      await uploadOpenedConversationFileTo(
        { token: second.file.token, attemptId: nextAttemptId(), url: remoteUrl },
        permitted,
        async () => {
          NodeFS.appendFileSync(second.path, " written in place");
          return true;
        },
        fetchImpl,
      ),
    ).toEqual({ _tag: "failed", reason: "file-changed" });
    expect(bodies).toEqual([]);
  });

  it("refuses a file cut short while it is being sent", async () => {
    const { file, path } = await openedAt("x".repeat(1024 * 1024));
    let sent = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      NodeFS.truncateSync(path, 1024);
      sent = (await new Response(init?.body).arrayBuffer()).byteLength;
      return new Response(null, { status: 204 });
    };
    expect(
      await uploadOpenedConversationFileTo(
        { token: file.token, attemptId: nextAttemptId(), url: managedUrl },
        managed,
        async () => true,
        fetchImpl,
      ).catch(() => "threw"),
    ).toEqual({ _tag: "failed", reason: "file-changed" });
    expect(sent).toBeLessThan(1024 * 1024);
  });

  it("refuses a same-inode, same-size rewrite before accepting the upload response", async () => {
    const { file, path } = await openedAt();
    const before = NodeFS.statSync(path, { bigint: true });
    let sent = "";
    const upload = { signal: null as AbortSignal | null };
    const fetchImpl: typeof fetch = async (_input, init) => {
      upload.signal = init?.signal ?? null;
      sent = await new Response(init?.body).text();
      NodeFS.writeFileSync(path, "PORTABLE CONVERSATION");
      NodeFS.utimesSync(path, 1_577_836_800, 1_577_836_800);
      return new Response(null, { status: 204 });
    };
    expect(
      await uploadOpenedConversationFileTo(
        { token: file.token, attemptId: nextAttemptId(), url: managedUrl },
        managed,
        async () => true,
        fetchImpl,
      ),
    ).toEqual({ _tag: "failed", reason: "file-changed" });
    const after = NodeFS.statSync(path, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).not.toBe(before.mtimeNs);
    expect(sent).toBe("portable conversation");
    expect(upload.signal?.aborted).toBe(true);
  });

  it("refuses a same-size rewrite while the request body is streaming", async () => {
    const size = 1024 * 1024;
    const { file, path } = await openedAt("a".repeat(size));
    const before = NodeFS.statSync(path, { bigint: true });
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (!init?.body) throw new Error("The upload has no body.");
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      expect((await reader.read()).done).toBe(false);
      NodeFS.writeFileSync(path, "b".repeat(size));
      NodeFS.utimesSync(path, 1_577_836_800, 1_577_836_800);
      while (!(await reader.read()).done) {}
      return new Response(null, { status: 204 });
    };
    expect(
      await uploadOpenedConversationFileTo(
        { token: file.token, attemptId: nextAttemptId(), url: managedUrl },
        managed,
        async () => true,
        fetchImpl,
      ),
    ).toEqual({ _tag: "failed", reason: "file-changed" });
    const after = NodeFS.statSync(path, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
  });

  it("does not accept an early success response before the upload body completes", async () => {
    const { file } = await openedAt();
    const upload = { signal: null as AbortSignal | null };
    const fetchImpl: typeof fetch = async (_input, init) => {
      upload.signal = init?.signal ?? null;
      return new Response(null, { status: 204 });
    };
    expect(
      await uploadOpenedConversationFileTo(
        { token: file.token, attemptId: nextAttemptId(), url: managedUrl },
        managed,
        async () => true,
        fetchImpl,
      ),
    ).toEqual({ _tag: "failed", reason: "network-failed" });
    expect(upload.signal?.aborted).toBe(true);
  });

  it("closes the opened file when the upload is released, even with the prompt still open", async () => {
    const { file } = await openedAt();
    const handles: NodeFS.promises.FileHandle[] = [];
    let answer: (approved: boolean) => void = () => undefined;
    let prompted: () => void = () => undefined;
    const promptOpen = new Promise<void>((resolve) => {
      prompted = resolve;
    });
    const uploading = uploadOpenedConversationFileTo(
      { token: file.token, attemptId: nextAttemptId(), url: remoteUrl },
      permitted,
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
          prompted();
        }),
      recordingFetch().fetchImpl,
      async (path) => {
        const handle = await NodeFS.promises.open(path, "r");
        handles.push(handle);
        return handle;
      },
    );
    await promptOpen;
    expect(handles).toHaveLength(1);
    expect(handles[0]!.fd).toBeGreaterThanOrEqual(0);
    releaseOpenedConversationFileFor(file.token);
    expect(handles[0]!.fd).toBe(-1);
    answer(true);
    expect(await uploading).toEqual({ _tag: "failed", reason: "cancelled" });
  });

  it("closes a descriptor whose open finished after its attempt was cancelled, and asks nothing", async () => {
    const { file } = await openedAt();
    const handles: NodeFS.promises.FileHandle[] = [];
    let finishOpen: () => void = () => undefined;
    const opening = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    let openStarted: () => void = () => undefined;
    const openRequested = new Promise<void>((resolve) => {
      openStarted = resolve;
    });
    let prompts = 0;
    const attemptId = nextAttemptId();
    const uploading = uploadOpenedConversationFileTo(
      { token: file.token, attemptId, url: remoteUrl },
      permitted,
      async () => {
        prompts += 1;
        return true;
      },
      recordingFetch().fetchImpl,
      async (path) => {
        openStarted();
        await opening;
        const handle = await NodeFS.promises.open(path, "r");
        handles.push(handle);
        return handle;
      },
    );
    await openRequested;
    cancelOpenedConversationFileUploadFor({ token: file.token, attemptId });
    finishOpen();
    expect(await uploading).toEqual({ _tag: "failed", reason: "cancelled" });
    expect(handles).toHaveLength(1);
    expect(handles[0]!.fd).toBe(-1);
    expect(prompts).toBe(0);
  });

  it("closes a descriptor held by a pending prompt when the file expires, unprompted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { file } = await openedAt();
      const handles: NodeFS.promises.FileHandle[] = [];
      let answer: (approved: boolean) => void = () => undefined;
      let prompted: () => void = () => undefined;
      const promptOpen = new Promise<void>((resolve) => {
        prompted = resolve;
      });
      const uploading = uploadOpenedConversationFileTo(
        { token: file.token, attemptId: nextAttemptId(), url: remoteUrl },
        permitted,
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
            prompted();
          }),
        recordingFetch().fetchImpl,
        async (path) => {
          const handle = await NodeFS.promises.open(path, "r");
          handles.push(handle);
          return handle;
        },
      );
      await promptOpen;
      expect(handles[0]!.fd).toBeGreaterThanOrEqual(0);
      // No renderer call: the lifetime alone ends it.
      vi.advanceTimersByTime(30 * 60_000);
      expect(handles[0]!.fd).toBe(-1);
      answer(true);
      expect(await uploading).toEqual({ _tag: "failed", reason: "cancelled" });
      expect(
        await uploadOpenedConversationFileTo(
          { token: file.token, attemptId: nextAttemptId(), url: managedUrl },
          managed,
          async () => true,
          recordingFetch().fetchImpl,
        ),
      ).toEqual({ _tag: "failed", reason: "file-unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.effect("refuses a FIFO put at the path without waiting on it", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const { file, path } = yield* Effect.promise(() => openedAt());
      NodeFS.rmSync(path);
      expect(NodeChildProcess.spawnSync("mkfifo", [path]).status).toBe(0);
      // No writer ever opens the FIFO: a blocking open would never return.
      const result = yield* Effect.promise(() =>
        uploadOpenedConversationFileTo(
          { token: file.token, attemptId: nextAttemptId(), url: managedUrl },
          managed,
          async () => true,
          recordingFetch().fetchImpl,
        ),
      );
      expect(result).toEqual({ _tag: "failed", reason: "file-changed" });
    }),
  );

  it("closes the opened file when an attempt ends, sent or not", async () => {
    const { file } = await openedAt();
    const handles: NodeFS.promises.FileHandle[] = [];
    const openFile = async (path: string) => {
      const handle = await NodeFS.promises.open(path, "r");
      handles.push(handle);
      return handle;
    };
    const { fetchImpl } = recordingFetch();
    for (const approve of [async () => false, async () => true]) {
      await uploadOpenedConversationFileTo(
        { token: file.token, attemptId: nextAttemptId(), url: remoteUrl },
        permitted,
        approve,
        fetchImpl,
        openFile,
      );
    }
    expect(handles.map((handle) => handle.fd)).toEqual([-1, -1]);
  });
});

describe("files macOS opens before Scient is ready", () => {
  it("holds paths until a handler attaches, then hands over each one as it arrives", () => {
    const relay = makeOpenedPathRelay(2);
    relay.receive("/files/first.scic");
    relay.receive("/files/second.scic");
    relay.receive("/files/third.scic");
    const opened: string[] = [];
    const detach = relay.attach((path) => opened.push(path));
    // The oldest is dropped beyond the limit.
    expect(opened).toEqual(["/files/second.scic", "/files/third.scic"]);
    relay.receive("/files/fourth.scic");
    expect(opened).toEqual(["/files/second.scic", "/files/third.scic", "/files/fourth.scic"]);
    detach();
    relay.receive("/files/fifth.scic");
    expect(opened).toHaveLength(3);
    const later: string[] = [];
    relay.attach((path) => later.push(path));
    expect(later).toEqual(["/files/fifth.scic"]);
  });

  it("takes over open-file only for conversation files", () => {
    const listeners: Array<(event: { preventDefault: () => void }, path: string) => void> = [];
    const app = {
      on: (_event: "open-file", listener: (event: never, path: string) => void) => {
        listeners.push(listener as (typeof listeners)[number]);
      },
    };
    const relay = makeOpenedPathRelay();
    listenForOpenedConversationFiles(app, relay);
    expect(listeners).toHaveLength(1);
    const prevented: string[] = [];
    const emit = (path: string) =>
      listeners[0]!({ preventDefault: () => prevented.push(path) }, path);
    emit("/files/Opened.SCIC");
    emit("/files/notes.txt");
    expect(prevented).toEqual(["/files/Opened.SCIC"]);
    const opened: string[] = [];
    relay.attach((path) => opened.push(path));
    expect(opened).toEqual(["/files/Opened.SCIC"]);
  });
});
