import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 5 * 60_000;

export type SignedMediaUrlPayload = {
  resourceUri: string;
  clientId: string;
  expiresAt: number;
};

export class LocalAgentSignedUrlService {
  private readonly key: Buffer;

  constructor(key: Buffer = randomBytes(32)) {
    this.key = key;
  }

  mint(args: {
    baseUrl: string;
    resourceUri: string;
    clientId: string;
    ttlMs?: number;
  }): { url: string; expiresAt: string } {
    const expiresAt = Date.now() + (args.ttlMs ?? DEFAULT_TTL_MS);
    const payload: SignedMediaUrlPayload = {
      resourceUri: args.resourceUri,
      clientId: args.clientId,
      expiresAt
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = this.sign(encoded);
    const url = new URL("/media", args.baseUrl);
    url.searchParams.set("grant", encoded);
    url.searchParams.set("signature", signature);
    return { url: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
  }

  verify(url: URL): SignedMediaUrlPayload | null {
    const encoded = url.searchParams.get("grant");
    const signature = url.searchParams.get("signature");
    if (encoded === null || signature === null) return null;
    const expected = Buffer.from(this.sign(encoded), "utf8");
    const actual = Buffer.from(signature, "utf8");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return null;
    }
    try {
      const parsed = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8")
      ) as Partial<SignedMediaUrlPayload>;
      if (
        typeof parsed.resourceUri !== "string" ||
        typeof parsed.clientId !== "string" ||
        typeof parsed.expiresAt !== "number" ||
        !Number.isFinite(parsed.expiresAt) ||
        parsed.expiresAt <= Date.now()
      ) {
        return null;
      }
      return {
        resourceUri: parsed.resourceUri,
        clientId: parsed.clientId,
        expiresAt: parsed.expiresAt
      };
    } catch {
      return null;
    }
  }

  private sign(encoded: string): string {
    return createHmac("sha256", this.key).update(encoded).digest("base64url");
  }
}
