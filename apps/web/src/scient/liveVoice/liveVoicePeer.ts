/**
 * The window's side of a voice call: the microphone goes out and the voice comes back over
 * WebRTC. Scient Agent signals the call, so this peer only makes the offer and plays the answer.
 */

/** OpenAI's realtime calls expect this data channel in the offer. */
const EVENTS_CHANNEL = "oai-events";
/** Candidates gathered by then go in the offer; the far side also learns them from checks. */
const ICE_GATHERING_WAIT_MS = 1_000;

export interface LiveVoicePeer {
  readonly offer: string;
  readonly applyAnswer: (sdp: string) => Promise<void>;
  readonly setMuted: (muted: boolean) => void;
  /** Microphone and voice loudness, each 0 to 1. */
  readonly levels: () => { readonly input: number; readonly output: number };
  readonly close: () => void;
}

const waitForIceGathering = (peer: RTCPeerConnection): Promise<void> =>
  new Promise((resolve) => {
    if (peer.iceGatheringState === "complete") return resolve();
    const done = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, ICE_GATHERING_WAIT_MS);
    peer.addEventListener("icegatheringstatechange", onChange);
  });

/** Root mean square of the analyser's current frame, scaled so speech fills most of 0 to 1. */
const loudness = (
  analyser: AnalyserNode | undefined,
  buffer: Float32Array<ArrayBuffer>,
): number => {
  if (analyser === undefined) return 0;
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const sample of buffer) sum += sample * sample;
  return Math.min(1, Math.sqrt(sum / buffer.length) * 4);
};

export async function openLiveVoicePeer(microphone: MediaStream): Promise<LiveVoicePeer> {
  const peer = new RTCPeerConnection();
  const audio = new Audio();
  audio.autoplay = true;
  const context = new AudioContext();
  const analyser = () => {
    const node = context.createAnalyser();
    node.fftSize = 512;
    return node;
  };
  const inputAnalyser = analyser();
  context.createMediaStreamSource(microphone).connect(inputAnalyser);
  let outputAnalyser: AnalyserNode | undefined;
  const buffer = new Float32Array(512);

  try {
    for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
    peer.createDataChannel(EVENTS_CHANNEL);
    peer.addEventListener("track", (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      audio.srcObject = stream;
      outputAnalyser = analyser();
      context.createMediaStreamSource(stream).connect(outputAnalyser);
    });
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIceGathering(peer);
  } catch (cause) {
    peer.close();
    void context.close();
    throw cause;
  }
  const offer = peer.localDescription?.sdp;
  if (!offer) {
    peer.close();
    void context.close();
    throw new Error("The call couldn't start: no offer was made.");
  }

  return {
    offer,
    applyAnswer: (sdp) => peer.setRemoteDescription({ type: "answer", sdp }),
    setMuted: (muted) => {
      for (const track of microphone.getAudioTracks()) track.enabled = !muted;
    },
    levels: () => ({
      input: loudness(inputAnalyser, buffer),
      output: loudness(outputAnalyser, buffer),
    }),
    close: () => {
      peer.close();
      audio.srcObject = null;
      void context.close();
    },
  };
}
