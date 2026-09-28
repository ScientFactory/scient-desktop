// @effect-diagnostics nodeBuiltinImport:off -- test fixtures are local OS-opened files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  registerOpenedConversationFile,
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

afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

async function openedFile(name = "opened.scic") {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-opened-scic-"));
  directories.push(directory);
  const path = NodePath.join(directory, name);
  NodeFS.writeFileSync(path, "portable conversation");
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
        { token: file.token, url: lanUrl },
        permitted,
        approveRemote,
        fetchImpl,
      ),
    ).toEqual({ _tag: "failed", reason: "rejected" });
    expect(requests).toBe(0);
    expect(
      await uploadOpenedConversationFileTo(
        { token: file.token, url: lanUrl.replace("payload.signature", "fresh.signature") },
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
        { token: file.token, url },
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
        reason: "rejected",
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
      uploadOpenedConversationFileTo({ token, url }, permitted, approveRemote, fetchImpl);

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
    const request = { token: file.token, url: `http://127.0.0.1:31234${route}` };
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
      { token: file.token, url: `http://127.0.0.1:31234${route}` },
      permitted,
      async () => {
        throw new Error("Managed backend should not request approval.");
      },
      fetchImpl,
    );
    expect(result).toEqual({ _tag: "failed", reason: "network-failed" });
  });
});
