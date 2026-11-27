import * as Schema from "effect/Schema";

export const RecordingSessionType = Schema.Literals(["lecture", "meeting", "interview"]);
export type RecordingSessionType = typeof RecordingSessionType.Type;

export const RecordingSessionId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
);
const Source = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Title = Schema.String.check(Schema.isMaxLength(200));
const Seconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Revision = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}-[\p{L}\p{N}\p{M}-]+-[a-f0-9]{8}$/u),
  Schema.isMaxLength(240),
);
const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const RecordingSessionPart = Schema.Struct({
  id: RecordingSessionId,
  recordingId: RecordingSessionId,
  source: Source,
  mediaSource: Schema.optionalKey(Source),
  contentHash: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  transcriptOnly: Schema.optionalKey(Schema.Boolean),
  duration: Seconds,
  revision: Schema.optionalKey(Revision),
  previousSessionId: Schema.optionalKey(RecordingSessionId),
});
export type RecordingSessionPart = typeof RecordingSessionPart.Type;

export const RecordingSessionMarker = Schema.Struct({
  id: RecordingSessionId,
  recordingId: RecordingSessionId,
  time: Seconds,
});
export type RecordingSessionMarker = typeof RecordingSessionMarker.Type;

export const RecordingSessionMaterial = Schema.Struct({
  id: RecordingSessionId,
  name: Title,
  source: Schema.Literals(["project", "library"]),
  reference: Source,
  included: Schema.Boolean,
  pages: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d+(?:-\d+)?$/))),
  moment: Schema.optionalKey(Schema.Struct({ recordingId: RecordingSessionId, time: Seconds })),
});
export type RecordingSessionMaterial = typeof RecordingSessionMaterial.Type;

export const RecordingSession = Schema.Struct({
  id: RecordingSessionId,
  version: Version,
  timelineRevision: Version,
  title: Title,
  type: RecordingSessionType,
  created: Seconds,
  parts: Schema.Array(RecordingSessionPart),
  material: Schema.Array(RecordingSessionMaterial),
  markers: Schema.Array(RecordingSessionMarker),
  archived: Schema.optionalKey(Schema.Boolean),
  trashed: Schema.optionalKey(Schema.Boolean),
});
export type RecordingSession = typeof RecordingSession.Type;

export const RecordingSessionSnapshot = Schema.Struct({
  sessionId: RecordingSessionId,
  contextRevision: RecordingSessionId,
  title: Title,
  type: RecordingSessionType,
  timelineRevision: Version,
  parts: Schema.Array(RecordingSessionPart),
  material: Schema.Array(RecordingSessionMaterial),
  markers: Schema.Array(RecordingSessionMarker),
});
export type RecordingSessionSnapshot = typeof RecordingSessionSnapshot.Type;

const Versioned = { id: RecordingSessionId, version: Version };
const Selection = Schema.Union([Schema.Struct({ source: Source }), Schema.Struct(Versioned)]);
const Move = Schema.Struct({
  partId: RecordingSessionId,
  direction: Schema.Literals(["earlier", "later"]),
});

export const RecordingSessionCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("list") }),
  Schema.Struct({ kind: Schema.Literal("read-snapshot"), contextRevision: RecordingSessionId }),
  Schema.Struct({
    kind: Schema.Literal("snapshot-part"),
    contextRevision: RecordingSessionId,
    partId: RecordingSessionId,
  }),
  Schema.Struct({ kind: Schema.Literal("ensure"), source: Source }),
  Schema.Struct({
    kind: Schema.Literal("combine"),
    selection: Schema.Array(Selection).check(Schema.isMinLength(2), Schema.isMaxLength(20)),
  }),
  Schema.Struct({ kind: Schema.Literal("split"), ...Versioned }),
  Schema.Struct({ kind: Schema.Literal("snapshot"), ...Versioned }),
  Schema.Struct({ kind: Schema.Literal("trash"), ...Versioned }),
  Schema.Struct({ kind: Schema.Literal("restore"), ...Versioned }),
  Schema.Struct({ kind: Schema.Literal("remove-part"), ...Versioned, partId: RecordingSessionId }),
  Schema.Struct({ kind: Schema.Literal("reorder"), ...Versioned, ...Move.fields }),
  Schema.Struct({
    kind: Schema.Literal("edit"),
    ...Versioned,
    title: Schema.optionalKey(Title),
    type: Schema.optionalKey(RecordingSessionType),
  }),
  Schema.Struct({
    kind: Schema.Literal("locate"),
    ...Versioned,
    partId: RecordingSessionId,
    source: Source,
  }),
  Schema.Struct({
    kind: Schema.Literal("select-revision"),
    ...Versioned,
    partId: RecordingSessionId,
    revision: Revision,
  }),
  Schema.Struct({
    kind: Schema.Literal("mark"),
    ...Versioned,
    recordingId: RecordingSessionId,
    time: Seconds,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-material"),
    ...Versioned,
    material: Schema.Array(RecordingSessionMaterial).check(Schema.isMaxLength(30)),
  }),
]);
export type RecordingSessionCommand = typeof RecordingSessionCommand.Type;

export type RecordingSessionResult = {
  readonly sessions: readonly RecordingSession[];
  readonly session?: RecordingSession;
  readonly snapshot?: RecordingSessionSnapshot & { readonly path: string };
  readonly segments?: readonly {
    readonly id: string;
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }[];
};
