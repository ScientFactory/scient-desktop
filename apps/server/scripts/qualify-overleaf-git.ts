// @effect-diagnostics nodeBuiltinImport:off -- Qualification entrypoint uses host paths and process identity.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Command, Flag, Prompt } from "effect/cli";
import * as Executor from "../src/scient/overleaf/OverleafGitExecutor.ts";
import * as Repository from "../src/scient/overleaf/OverleafRepository.ts";
import {
  cloudProbeGitUrl,
  redactProbePushOutput,
  runProtocolProbe,
  type ProbeObservation,
} from "../src/scient/overleaf/OverleafProtocolProbe.ts";

const probe = Command.make(
  "overleaf-probe",
  {
    cloud: Flag.Boolean("cloud").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Write only to a disposable Overleaf Cloud project; token is entered at a hidden prompt.",
      ),
    ),
    project: Flag.String("project").pipe(
      Flag.optional,
      Flag.withDescription("Disposable Cloud project URL. No credentials in the URL."),
    ),
    output: Flag.String("output").pipe(
      Flag.optional,
      Flag.withDescription("New JSON report path; existing files are never overwritten."),
    ),
  },
  Effect.fnUntraced(function* ({ cloud, project, output }) {
    const fs = yield* FileSystem.FileSystem;
    const id = NodeCrypto.randomUUID();
    const prefix = `scient-probe-${id}`;
    const report = NodePath.resolve(Option.getOrElse(output, () => `overleaf-probe-${id}.json`));
    const observations: ProbeObservation[] = [];
    const encode = (s: string) => new TextEncoder().encode(s);
    let secret = new Uint8Array();
    yield* fs.writeFileString(
      report,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        version: 1,
        mode: cloud ? "cloud" : "local-rehearsal",
        prefix,
        observations,
      }),
      { flag: "wx", mode: 0o600 },
    );
    const observe = Effect.fnUntraced(function* (observation: ProbeObservation) {
      observations.push(observation);
      yield* fs.writeFileString(
        report,
        (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))({
          version: 1,
          mode: cloud ? "cloud" : "local-rehearsal",
          prefix,
          observations,
        })) + "\n",
      );
      yield* Console.log(`${observation.name}: ${observation.status}`);
    });
    const acknowledged = Effect.fnUntraced(function* (message: string) {
      if (!(yield* Prompt.Confirm({ message, initial: false })))
        return yield* Effect.fail("Browser step not completed.");
    });
    const run = Effect.scoped(
      Effect.gen(function* () {
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-overleaf-probe-" });
        yield* fs.chmod(root, 0o700);
        let gitUrl = NodePath.join(root, "disposable.git");
        if (cloud) {
          if (!process.stdin.isTTY || !process.stdout.isTTY)
            return yield* Effect.fail("Cloud probe needs a local interactive terminal.");
          const url = Option.isSome(project)
            ? project.value
            : yield* Prompt.String({
                message: "Paste the disposable Overleaf project URL (no token):",
              });
          const normalized = cloudProbeGitUrl(url);
          if (!normalized) return yield* Effect.fail("Invalid Cloud project URL.");
          gitUrl = normalized;
          yield* Console.log(
            "This test publishes a few small files and browser edits to this project. Use a new disposable project without other collaborators. It will leave its history and probe files for inspection.",
          );
          yield* acknowledged("Is this your disposable project, and may this test publish to it?");
          const entered = yield* Prompt.Hidden({
            message: "Overleaf Git token (hidden; never logged or saved in the report):",
          });
          const value = Redacted.value(entered);
          if (!value || value.length > 4096 || /[\r\n\u0000]/u.test(value))
            return yield* Effect.fail("Invalid token input.");
          secret = encode(value);
        } else if (Option.isSome(project))
          return yield* Effect.fail(
            "--project requires --cloud; local rehearsal never contacts Cloud.",
          );
        const rawGit = yield* Executor.make({
          runtimeRoot: NodePath.join(root, "runtime"),
          allowLocalProtocols: !cloud,
        });
        yield* observe({
          name: "git-version",
          status: "observed",
          facts: { version: (yield* rawGit.availability).version },
        });
        const git = Executor.OverleafGitExecutor.of({
          availability: rawGit.availability,
          execute: Effect.fnUntraced(function* (command) {
            const result = yield* rawGit.execute(command);
            if (command.args[0] === "push")
              yield* observe({
                name: "push-response",
                status: "observed",
                facts: {
                  exitCode: result.exitCode,
                  stdout: redactProbePushOutput(new TextDecoder().decode(result.stdout), secret),
                  stderr: redactProbePushOutput(result.stderr, secret),
                },
              }).pipe(Effect.orDie);
            return result;
          }),
        });
        const repository = yield* Repository.make.pipe(
          Effect.provideService(Executor.OverleafGitExecutor, git),
        );
        if (!cloud) {
          yield* fs.makeDirectory(gitUrl);
          yield* git.execute({ cwd: gitUrl, args: ["init", "--bare", "--initial-branch=main"] });
          const tree = yield* repository.writeTree({ repo: gitUrl, entries: [] });
          const commit = yield* repository.commit({
            repo: gitUrl,
            tree,
            parents: [],
            message: "Synthetic disposable project",
          });
          yield* git.execute({ cwd: gitUrl, args: ["update-ref", "refs/heads/main", commit] });
        }
        const repo = NodePath.join(root, "scient.git");
        let commentCreated = false;
        let trackedChangeCreated = false;
        const localBrowser = Effect.fnUntraced(function* (
          stage: "edit" | "revert",
          args: { branch: "main" | "master" },
        ) {
          const writer = NodePath.join(root, "browser.git");
          yield* repository.initialize({ repo: writer, gitUrl });
          const head = yield* repository.fetch({
            repo: writer,
            branch: args.branch,
            token: secret,
          });
          const entries = yield* repository.readTree({ repo: writer, tree: head.tree });
          let before = head;
          const revisions =
            stage === "edit" ? ["PROBE_BROWSER_EDIT"] : ["PROBE_ACK_LATER", "PROBE_REVERT"];
          for (const value of revisions) {
            const path = `${prefix}/${stage === "edit" ? "review.tex" : "ack.tex"}`;
            const oid = yield* repository.writeBlob({ repo: writer, bytes: encode(value + "\n") });
            const tree = yield* repository.writeTree({
              repo: writer,
              entries: [...entries.filter((entry) => entry.path !== path), { path, oid }],
            });
            const commit = yield* repository.commit({
              repo: writer,
              tree,
              parents: [before.commit],
              message: value,
            });
            const result = yield* repository.push({
              repo: writer,
              commit,
              branch: args.branch,
              token: secret,
            });
            if (result._tag !== "accepted")
              return yield* Effect.fail("Local browser fixture push failed.");
            before = { commit, tree };
          }
        });
        yield* runProtocolProbe({
          repository,
          git,
          repo,
          witnessRepo: NodePath.join(root, "independent.git"),
          gitUrl,
          token: secret,
          prefix,
          hooks: {
            observe,
            browser: (stage, args) =>
              !cloud
                ? localBrowser(stage, args)
                : Effect.gen(function* () {
                    if (stage === "edit") {
                      yield* Console.log(
                        `In Overleaf, open ${prefix}/review.tex. Change PROBE_INITIAL to PROBE_BROWSER_EDIT. Wait for Overleaf to save.`,
                      );
                    } else {
                      yield* Console.log(
                        `In Overleaf, open ${prefix}/ack.tex. Change PROBE_ACK to PROBE_ACK_LATER, wait for save, and label that version. Then restore the project to the 'probe-before-ack' label made in the previous step. Wait for save. This tests accepted publication followed by edits and a revert before verification.`,
                      );
                    }
                    yield* acknowledged("Have you completed the browser step and waited for save?");
                  }),
            reviewMetadata: (stage, namespace) =>
              !cloud
                ? observe({
                    name: `browser-metadata-${stage}`,
                    status: "unverified",
                    facts: { localGitHasNoReviewMetadata: true },
                  })
                : Effect.gen(function* () {
                    if (stage === "before-rename") {
                      yield* Console.log(
                        `Confirm ${namespace}/review.tex and folder/child.tex are visible in Overleaf. Inspect the Git commit's displayed author in History. Add a comment to review.tex and a tracked change if your plan supports it. Remember what is attached to that file.`,
                      );
                    } else {
                      yield* Console.log(
                        `Confirm ${namespace}/renamed.tex and renamed-folder/child.tex are visible. Inspect the old empty folder, comments and tracked changes. Create the History label 'probe-before-ack' at this version before continuing.`,
                      );
                    }
                    yield* acknowledged(
                      "Have you inspected this version and completed the requested setup?",
                    );
                    if (stage === "after-rename") {
                      yield* observe({
                        name: "rename-comments",
                        status: commentCreated ? "observed" : "unverified",
                        facts: commentCreated
                          ? {
                              commentsSurvived: yield* Prompt.Confirm({
                                message: "Are the original comments still attached to renamed.tex?",
                                initial: false,
                              }),
                            }
                          : { commentNotCreated: true },
                      });
                      yield* observe({
                        name: "rename-tracked-changes",
                        status: trackedChangeCreated ? "observed" : "unverified",
                        facts: trackedChangeCreated
                          ? {
                              trackChangesSurvived: yield* Prompt.Confirm({
                                message: "Are the original tracked changes still attached?",
                                initial: false,
                              }),
                            }
                          : { trackedChangeNotCreated: true },
                      });
                    } else {
                      commentCreated = yield* Prompt.Confirm({
                        message: "Did you add a comment to review.tex?",
                        initial: false,
                      });
                      trackedChangeCreated = yield* Prompt.Confirm({
                        message: "Did you add a tracked change to review.tex?",
                        initial: false,
                      });
                      yield* observe({
                        name: "displayed-author",
                        status: "observed",
                        facts: {
                          showsScientIdentity: yield* Prompt.Confirm({
                            message: "Does History show Scient as the Git author?",
                            initial: false,
                          }),
                        },
                      });
                    }
                  }),
          },
        });
        yield* observe({
          name: "probe-completed",
          status: "observed",
          facts: { noAutomaticRetry: true, reviewUnknownAndUnverifiedObservations: true },
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer));
    yield* run.pipe(
      Effect.catchCause(() =>
        Effect.gen(function* () {
          // Raw Git failures and defects can contain remote output: do not echo them.
          yield* observe({
            name: "probe-stopped",
            status: "failed",
            facts: { noAutomaticRetry: true },
          });
          yield* Console.error(
            "Probe stopped. Inspect the redacted report and disposable project before running it again. No push was automatically retried.",
          );
          process.exitCode = 1;
        }),
      ),
      Effect.ensuring(Effect.sync(() => secret.fill(0))),
    );
    yield* Console.log(`Report: ${report}`);
  }),
);

probe.pipe(
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
