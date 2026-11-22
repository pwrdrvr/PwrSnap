import { none } from "stream-chain/core";
import { jsonParser, type Token } from "stream-json/core/parser.js";

const MAX_INLINE_CHARS = 64 * 1024;
// Chromium's numeric fields and every allowlisted name fit well below this.
const MAX_SCALAR_CHARS = 256;
const EVENT_KEYS = new Set(["pid", "tid", "ph", "name", "cat", "ts", "dur", "tts", "tdur", "args"]);

function appendScalar(prefix: string | undefined, chunk: string): string | undefined {
  return prefix !== undefined && prefix.length + chunk.length <= MAX_SCALAR_CHARS
    ? prefix + chunk
    : undefined;
}

function parseInline(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Parser errors can quote the unfiltered input.
    throw new Error("Chromium trace contains invalid JSON");
  }
}

function oversizedEvent(allowedCategories: readonly string[]) {
  const event: Record<string, unknown> = {};
  const knownCategories = new Set(allowedCategories);
  const matchedCategories = new Set<string>();
  let depth = 0;
  let key: string | undefined;
  let scalar: string | undefined;
  let args: Record<string, unknown> | undefined;
  let readingCategories = false;

  function store(value: unknown): void {
    if (depth === 1 && key !== undefined && EVENT_KEYS.has(key)) event[key] = value;
    if (depth === 2 && args !== undefined && key === "name") args.name = value;
  }

  function matchCategory(): void {
    if (scalar !== undefined && knownCategories.has(scalar)) matchedCategories.add(scalar);
  }

  return {
    event,
    accept(token: Token): void {
      switch (token.name) {
        case "startObject":
          if (depth === 1 && key === "args") {
            args = {};
            store(args);
          } else {
            store(undefined);
          }
          depth++;
          break;
        case "startArray":
          store(undefined);
          depth++;
          break;
        case "endObject":
        case "endArray":
          if (depth-- === 2) args = undefined;
          break;
        case "startKey":
        case "startNumber":
          scalar = depth === 1 || (depth === 2 && args !== undefined) ? "" : undefined;
          break;
        case "startString":
          readingCategories = depth === 1 && key === "cat";
          if (readingCategories) matchedCategories.clear();
          scalar = depth === 1 || (depth === 2 && args !== undefined) ? "" : undefined;
          break;
        case "stringChunk":
          if (readingCategories) {
            const pieces = token.value.split(",");
            for (const [i, piece] of pieces.entries()) {
              if (i > 0) {
                matchCategory();
                scalar = "";
              }
              scalar = appendScalar(scalar, piece);
            }
          } else {
            scalar = appendScalar(scalar, token.value);
          }
          break;
        case "numberChunk":
          scalar = appendScalar(scalar, token.value);
          break;
        case "endKey":
          key = scalar;
          break;
        case "endNumber":
          store(scalar === undefined ? undefined : Number(scalar));
          break;
        case "endString":
          if (readingCategories) {
            matchCategory();
            store([...matchedCategories].join(","));
            readingCategories = false;
          } else {
            store(scalar);
          }
          break;
        case "trueValue":
        case "falseValue":
        case "nullValue":
          store(undefined);
          break;
      }
    }
  };
}

type Tokenizer = (chunk: string | typeof none) => ReturnType<ReturnType<typeof jsonParser>>;

// Keep V8's whole-object fast path for small events. The unpacked tokenizer
// validates larger fragments a chunk at a time while retaining only values
// that could survive the allowlist. Root metadata needs syntax validation only.
export function traceJsonFragment(allowedCategories?: readonly string[]) {
  let inline = "";
  let tokenize: Tokenizer | undefined;
  let projection: ReturnType<typeof oversizedEvent> | undefined;

  function consume(chunk: string | typeof none): void {
    try {
      const tokens = tokenize!(chunk);
      if (projection !== undefined && tokens !== none) {
        for (const token of tokens.values) projection.accept(token);
      }
    } catch {
      throw new Error("Chromium trace contains invalid JSON");
    }
  }

  return {
    append(chunk: string): void {
      if (tokenize === undefined) {
        if (inline.length + chunk.length <= MAX_INLINE_CHARS) {
          inline += chunk;
          return;
        }
        if (allowedCategories !== undefined) projection = oversizedEvent(allowedCategories);
        // Stream-chain signals end of input by calling the flushable with none.
        tokenize = jsonParser({ packValues: false }) as Tokenizer;
        consume(inline);
        inline = "";
      }
      consume(chunk);
    },
    finish(): unknown {
      if (tokenize === undefined) {
        const result = parseInline(inline);
        inline = "";
        return result;
      }
      consume(none);
      const result = projection?.event;
      projection = undefined;
      tokenize = undefined;
      return result;
    }
  };
}
