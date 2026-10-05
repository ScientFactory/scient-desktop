import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedString } from "../baseSchemas.ts";
import type { CustomModelSetting as CustomModelSchema } from "../model.ts";

export function makeScientProviderSettings<BinaryPath extends Schema.Top>({
  makeProviderSettingsSchema,
  makeBinaryPathSetting,
  CustomModelSetting,
}: {
  makeProviderSettingsSchema: <const Fields extends Schema.Struct.Fields>(
    fields: Fields,
    options?: { readonly order?: readonly Extract<keyof Fields, string>[] | undefined },
  ) => Schema.Struct<Fields>;
  makeBinaryPathSetting: (fallback: string) => BinaryPath;
  CustomModelSetting: typeof CustomModelSchema;
}) {
  const OmpSettings = makeProviderSettingsSchema(
    {
      enabled: Schema.Boolean.pipe(
        Schema.withDecodingDefault(Effect.succeed(false)),
        Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
      ),
      binaryPath: makeBinaryPathSetting("omp").pipe(
        Schema.annotateKey({
          title: "Binary path",
          description: "Path to the Oh My Pi executable (18.2.8 or newer).",
          providerSettingsForm: { placeholder: "omp", clearWhenEmpty: "omit" },
        }),
      ),
      customModels: Schema.Array(CustomModelSetting).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
        Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
      ),
      homePath: TrimmedString.pipe(
        Schema.withDecodingDefault(Effect.succeed("")),
        Schema.annotateKey({
          title: "Oh My Pi home",
          description:
            "Optional PI_CODING_AGENT_DIR for this instance. Leave empty to use the server's normal Oh My Pi home and credentials, which every empty-home instance shares. Set a directory to isolate this instance; do not combine it with a named profile.",
          providerSettingsForm: { placeholder: "~/.omp/agent", clearWhenEmpty: "omit" },
        }),
      ),
      profile: TrimmedString.pipe(
        Schema.withDecodingDefault(Effect.succeed("")),
        Schema.annotateKey({
          title: "Oh My Pi profile",
          description:
            "Optional OMP_PROFILE for this instance. Leave empty to use Oh My Pi's default profile. A profile name asks Oh My Pi to use that profile's agent directory; do not combine it with a custom home.",
          providerSettingsForm: { placeholder: "work", clearWhenEmpty: "omit" },
        }),
      ),
    },
    { order: ["binaryPath", "homePath", "profile"] },
  );

  /**
   * Scient Agent keeps its state in a directory this server assigns, so it has
   * no home or profile setting. It is Scient's own agent, so it is on by default.
   */
  const ScientAgentSettings = makeProviderSettingsSchema(
    {
      enabled: Schema.Boolean.pipe(
        Schema.withDecodingDefault(Effect.succeed(true)),
        Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
      ),
      binaryPath: makeBinaryPathSetting("scient-agent").pipe(
        Schema.annotateKey({
          title: "Binary path",
          description: "Path to the Scient Agent executable (0.1.0 or newer).",
          providerSettingsForm: { placeholder: "scient-agent", clearWhenEmpty: "omit" },
        }),
      ),
      customModels: Schema.Array(CustomModelSetting).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
        Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
      ),
    },
    { order: ["binaryPath"] },
  );

  const DroidSettings = makeProviderSettingsSchema(
    {
      // Off by default (like Cursor, Grok, and OpenCode): the binding is not
      // yet stable enough to probe on every install. Users opt in from Settings.
      enabled: Schema.Boolean.pipe(
        Schema.withDecodingDefault(Effect.succeed(false)),
        Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
      ),
      binaryPath: makeBinaryPathSetting("droid").pipe(
        Schema.annotateKey({
          title: "Binary path",
          description: "Path to the Factory Droid CLI binary.",
          providerSettingsForm: { placeholder: "droid", clearWhenEmpty: "omit" },
        }),
      ),
      customModels: Schema.Array(Schema.String).pipe(
        // Droid's ACP catalog is authoritative and rejects unknown slugs, so
        // custom models are persisted for compatibility but never advertised.
        Schema.withDecodingDefault(Effect.succeed([])),
        Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
      ),
      // On leaves Droid's own `cloudSessionSync` setting alone (Scient writes
      // nothing, so sync turned off in Droid stays off); off writes `false` for
      // the processes Scient starts.
      cloudSessionSync: Schema.Boolean.pipe(
        Schema.withDecodingDefault(Effect.succeed(true)),
        Schema.annotateKey({
          title: "Sync conversations to Factory",
          description:
            "On: Droid syncs conversations to Factory as its own settings say (messages and titles, also with your own custom models). Off: Scient stops Droid from syncing them; model and usage counts still reach Factory.",
          providerSettingsForm: { control: "switch" },
        }),
      ),
    },
    {
      order: ["binaryPath", "cloudSessionSync"],
    },
  );

  return { OmpSettings, ScientAgentSettings, DroidSettings };
}
