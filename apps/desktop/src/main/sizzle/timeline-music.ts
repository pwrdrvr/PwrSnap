/** Deterministic sample-free music bed. The seed, tempo and hit positions are
 * manifest data; no network service, sample library or Python runtime is needed. */
export async function synthesizeTimelineMusic(
  args: {
    durationSec: number;
    bpm: number;
    dropSec: number;
    finalHitSec?: number;
    seed: number;
  },
  signal?: AbortSignal,
): Promise<Buffer> {
  const rate = 48_000,
    samples = Math.round(args.durationSec * rate);
  if (samples < 1 || samples > 72_000_000)
    throw new Error("Music duration is out of bounds");
  const pcm = new Float32Array(samples * 2);
  const beat = 60 / args.bpm;
  const roots = [55, 43.6535, 65.4064, 49];
  const chords = [
    [220, 261.626, 329.628],
    [174.614, 220, 261.626],
    [196, 261.626, 329.628],
    [196, 246.942, 293.665],
  ];
  let state = args.seed || 1;
  let lastNoise = 0,
    peak = 0;
  const tau = Math.PI * 2;
  const final =
    args.finalHitSec ?? Math.max(args.dropSec, args.durationSec - 3.5);
  for (let i = 0; i < samples; i++) {
    if (i % 8192 === 0) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const t = i / rate;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const noise = (state >>> 0) / 0x80000000 - 1;
    const highNoise = (noise - lastNoise) / 2;
    lastNoise = noise;
    const active = t >= args.dropSec && t < final;
    const beatAt = Math.max(0, (t - args.dropSec) / beat);
    const phase = (beatAt % 1) * beat;
    const bar = Math.floor(beatAt / 4) % 4;
    const chord = chords[bar]!;
    const padEnvelope = active ? 0.025 : 0.065 * Math.min(1, t / 0.8);
    const pad =
      chord.reduce(
        (sum, f) =>
          sum + Math.sin(tau * f * 0.998 * t) + Math.sin(tau * f * 1.002 * t),
        0,
      ) * padEnvelope;
    const kick = active
      ? Math.sin(
          tau * (45 * phase + (110 / 28) * (1 - Math.exp(-28 * phase))),
        ) *
        Math.exp(-phase * 14) *
        0.7
      : 0;
    const hatPhase = (((beatAt * 2) % 1) * beat) / 2;
    const hat =
      active || (t > 0.5 && t < args.dropSec)
        ? highNoise * Math.exp(-hatPhase * 110) * 0.13
        : 0;
    const clap =
      active && Math.floor(beatAt) % 2 === 1
        ? highNoise * Math.exp(-phase * 38) * 0.35
        : 0;
    const bassPhase = (((beatAt * 2) % 1) * beat) / 2;
    const bass = active
      ? Math.sin(
          tau * roots[bar]! * (Math.floor(beatAt * 2) % 2 ? 2 : 1) * bassPhase,
        ) *
        Math.exp(-bassPhase * 12) *
        0.3
      : 0;
    let impact = 0;
    for (const at of [args.dropSec, final]) {
      const elapsed = t - at;
      if (elapsed >= 0 && elapsed < 2.5)
        impact +=
          Math.sin(tau * (30 * elapsed + 35 * (1 - Math.exp(-2 * elapsed)))) *
          Math.exp(-elapsed * 2) *
          0.8;
    }
    const rise =
      t > args.dropSec - 2.2 && t < args.dropSec
        ? Math.pow((t - args.dropSec + 2.2) / 2.2, 3) *
          (noise * 0.2 + Math.sin(tau * (180 * t + 120 * t * t)) * 0.08)
        : 0;
    const fade = Math.min(
      1,
      (args.durationSec - t) / Math.min(1.2, args.durationSec),
    );
    const base = pad + kick + clap + bass + impact + rise;
    const left = Math.tanh((base + hat * 0.7) * 1.3) * fade;
    const right = Math.tanh((base + hat) * 1.3) * fade;
    pcm[i * 2] = left;
    pcm[i * 2 + 1] = right;
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
  }
  const wav = Buffer.alloc(44 + samples * 4);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 4, 40);
  const gain = (0.89 * 32767) / Math.max(1e-8, peak);
  for (let i = 0; i < pcm.length; i++)
    wav.writeInt16LE(Math.round(pcm[i]! * gain), 44 + i * 2);
  return wav;
}
