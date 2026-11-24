/** The Scient recorder sends canonical mono PCM16 at 24 kHz. */
export function readDictationWav(encoded: string): Buffer {
  const wav = Buffer.from(encoded, "base64");
  const dataBytes = wav.length - 44;
  if (
    dataBytes < 4 ||
    dataBytes > 180 * 24_000 * 2 ||
    dataBytes % 2 !== 0 ||
    wav.toString("base64") !== encoded ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.readUInt32LE(4) !== wav.length - 8 ||
    wav.toString("ascii", 8, 16) !== "WAVEfmt " ||
    wav.readUInt32LE(16) !== 16 ||
    wav.readUInt16LE(20) !== 1 ||
    wav.readUInt16LE(22) !== 1 ||
    wav.readUInt32LE(24) !== 24_000 ||
    wav.readUInt32LE(28) !== 48_000 ||
    wav.readUInt16LE(32) !== 2 ||
    wav.readUInt16LE(34) !== 16 ||
    wav.toString("ascii", 36, 40) !== "data" ||
    wav.readUInt32LE(40) !== dataBytes
  ) {
    throw new Error("Expected a 24 kHz mono PCM WAV recording of at most 180 seconds.");
  }
  return wav;
}

/** Average each 1.5-sample output interval before decimating. */
export function dictationPcm(wav: Buffer): Float32Array {
  const samples = Math.floor((wav.length - 44) / 3);
  const pcm = new Float32Array(samples);
  for (let index = 0; index < samples; index += 1) {
    const offset = 44 + 2 * Math.floor(index * 1.5);
    const left = wav.readInt16LE(offset);
    const right = wav.readInt16LE(offset + 2);
    pcm[index] = (index % 2 ? left + 2 * right : 2 * left + right) / (3 * 32768);
  }
  return pcm;
}
