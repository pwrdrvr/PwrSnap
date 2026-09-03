export type FfmpegProgressDisposition = "continue" | "end";

export type FfmpegProgressRecord = {
  progress: FfmpegProgressDisposition;
  outTimeSec: number | null;
  ratio: number | null;
};

function parseMicroseconds(value: string | undefined): number | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;

  const microseconds = Number(normalized);
  if (!Number.isFinite(microseconds) || microseconds < 0) return null;
  return microseconds / 1_000_000;
}

function parseClockTime(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(value.trim());
  if (match === null) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const total = hours * 3_600 + minutes * 60 + seconds;
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function parseOutTime(fields: ReadonlyMap<string, string>): number | null {
  const outTimeUs = parseMicroseconds(fields.get("out_time_us"));
  if (outTimeUs !== null) return outTimeUs;

  // FFmpeg's legacy out_time_ms key is misleadingly named: like
  // out_time_us, its value is expressed in microseconds.
  const outTimeMs = parseMicroseconds(fields.get("out_time_ms"));
  if (outTimeMs !== null) return outTimeMs;

  return parseClockTime(fields.get("out_time"));
}

/**
 * Incrementally parses FFmpeg's `-progress pipe:1` key/value stream.
 * A record is emitted only when FFmpeg terminates it with
 * `progress=continue` or `progress=end`.
 */
export class FfmpegProgressParser {
  private readonly durationSec: number | null;
  private readonly fields = new Map<string, string>();
  private pending = "";
  private lastRatio: number | null = null;
  private finished = false;

  constructor(durationSec?: number | null) {
    this.durationSec =
      typeof durationSec === "number" &&
      Number.isFinite(durationSec) &&
      durationSec > 0
        ? durationSec
        : null;
  }

  push(chunk: string | Buffer): FfmpegProgressRecord[] {
    if (this.finished) {
      throw new Error("cannot push FFmpeg progress after finish()");
    }

    this.pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    return this.drainCompleteLines();
  }

  finish(): FfmpegProgressRecord[] {
    if (this.finished) return [];
    this.finished = true;

    const records = this.drainCompleteLines();
    if (this.pending.length > 0) {
      const record = this.consumeLine(this.withoutTrailingCarriageReturn(this.pending));
      if (record !== null) records.push(record);
      this.pending = "";
    }

    // An unterminated collection of fields is not an FFmpeg progress record.
    this.fields.clear();
    return records;
  }

  private drainCompleteLines(): FfmpegProgressRecord[] {
    const records: FfmpegProgressRecord[] = [];
    let newlineIndex = this.pending.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = this.withoutTrailingCarriageReturn(
        this.pending.slice(0, newlineIndex)
      );
      this.pending = this.pending.slice(newlineIndex + 1);

      const record = this.consumeLine(line);
      if (record !== null) records.push(record);
      newlineIndex = this.pending.indexOf("\n");
    }

    return records;
  }

  private withoutTrailingCarriageReturn(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }

  private consumeLine(line: string): FfmpegProgressRecord | null {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) return null;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key.length === 0) return null;

    this.fields.set(key, value);
    if (key !== "progress" || (value !== "continue" && value !== "end")) {
      return null;
    }

    const outTimeSec = parseOutTime(this.fields);
    let ratio = this.lastRatio;
    if (this.durationSec !== null && outTimeSec !== null) {
      const candidate = Math.min(1, Math.max(0, outTimeSec / this.durationSec));
      ratio = ratio === null ? candidate : Math.max(ratio, candidate);
      this.lastRatio = ratio;
    }

    const record: FfmpegProgressRecord = {
      progress: value,
      outTimeSec,
      ratio: this.durationSec === null ? null : ratio
    };
    this.fields.clear();
    return record;
  }
}
