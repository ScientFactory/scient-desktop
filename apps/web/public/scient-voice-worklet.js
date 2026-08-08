// Scient local-voice AudioWorklet processor (static, same-origin asset).
//
// Loaded via `audioWorklet.addModule(new URL("scient-voice-worklet.js",
// document.baseURI))`. It is served same-origin, so it satisfies the renderer
// CSP `script-src 'self'` — unlike a `blob:` URL, which the CSP blocks (blob:
// is only allowed for `worker-src`, and AudioWorklet modules load under
// script-src). Runs in AudioWorkletGlobalScope: no DOM, no imports.
//
// The registered name MUST stay in sync with VOICE_WORKLET_PROCESSOR_NAME in
// voiceWorkletProcessor.ts. CHUNK_SAMPLES ~= 43ms at 48kHz.

const CHUNK_SAMPLES = 2048;

class ScientVoiceRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(CHUNK_SAMPLES);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this._buffer[this._offset] = channel[i];
      this._offset += 1;
      if (this._offset >= this._buffer.length) this._flush();
    }
    return true;
  }

  _flush() {
    const chunk = this._buffer.slice(0, this._offset);
    let sumOfSquares = 0;
    for (let i = 0; i < chunk.length; i += 1) sumOfSquares += chunk[i] * chunk[i];
    const rms = chunk.length > 0 ? Math.sqrt(sumOfSquares / chunk.length) : 0;
    this.port.postMessage({ samples: chunk, rms: rms }, [chunk.buffer]);
    this._offset = 0;
  }
}

registerProcessor("scient-voice-recorder", ScientVoiceRecorderProcessor);
