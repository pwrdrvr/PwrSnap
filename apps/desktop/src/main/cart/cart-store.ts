import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { DraftCart } from "@pwrsnap/shared";
import { getMainLogger } from "../log";

// The Project Asset Cart store. Persists the SINGLE global draft cart
// at `<userData>/draft-cart.json`. Mirrors `SizzleStore`'s mechanics
// (in-memory cache + serialized write queue + atomic-rename writes +
// parse-fail quarantine) — see that file for the rationale on each
// piece. The cart is a single object rather than a list, so this is
// the simpler cousin.

type Logger = ReturnType<typeof getMainLogger>;

export type CartStoreConfig = {
  filePath?: string;
  logger?: Logger;
};

type StoredBlob = {
  schemaVersion: 1;
  cart: DraftCart;
};

const DEFAULT_NAME = "Untitled draft";

function emptyCart(): DraftCart {
  const now = new Date().toISOString();
  return { name: DEFAULT_NAME, captureIds: [], createdAt: now, modifiedAt: now };
}

function defaultBlob(): StoredBlob {
  return { schemaVersion: 1, cart: emptyCart() };
}

export class CartStore {
  private readonly filePath: string;
  private readonly log: Logger;
  private writeQueue: Promise<unknown> = Promise.resolve();
  /**
   * In-memory cache of the parsed cart blob. Populated on first
   * `readBlob()` and refreshed on every successful `writeBlob()`.
   * Reads after the first skip disk I/O and return a deep clone.
   * Cache invariant: every write updates the cache AFTER the rename
   * succeeds, in the same serialized region — so a read sequenced
   * after a mutation always sees the just-written state.
   */
  private cachedBlob: StoredBlob | null = null;

  constructor(config: CartStoreConfig = {}) {
    this.filePath =
      config.filePath ?? join(app.getPath("userData"), "draft-cart.json");
    this.log = config.logger ?? getMainLogger("pwrsnap:cart-store");
  }

  async get(): Promise<DraftCart> {
    return this.serialize(async () => {
      const blob = await this.readBlob();
      return clone(blob.cart);
    });
  }

  /** Add the capture if absent; remove it if present. New additions
   *  append to the END (check order). */
  async toggle(captureId: string): Promise<DraftCart> {
    return this.mutate((cart) => {
      const idx = cart.captureIds.indexOf(captureId);
      if (idx >= 0) {
        cart.captureIds.splice(idx, 1);
      } else {
        cart.captureIds.push(captureId);
      }
    });
  }

  async remove(captureId: string): Promise<DraftCart> {
    return this.mutate((cart) => {
      const idx = cart.captureIds.indexOf(captureId);
      if (idx >= 0) cart.captureIds.splice(idx, 1);
    });
  }

  /** Move the item at `from` to `to`. Both indices are clamped to
   *  `[0, length-1]`; an out-of-range `from` is a no-op. */
  async reorder(from: number, to: number): Promise<DraftCart> {
    return this.mutate((cart) => {
      const n = cart.captureIds.length;
      if (from < 0 || from >= n) return; // nothing to move
      const clampedTo = Math.max(0, Math.min(n - 1, to));
      if (from === clampedTo) return;
      const [moved] = cart.captureIds.splice(from, 1);
      if (moved === undefined) return;
      cart.captureIds.splice(clampedTo, 0, moved);
    });
  }

  async rename(name: string): Promise<DraftCart> {
    return this.mutate((cart) => {
      const trimmed = name.trim();
      cart.name = trimmed.length > 0 ? trimmed : DEFAULT_NAME;
    });
  }

  /** Empty the cart back to a fresh draft. Resets the name + clears
   *  ids; keeps `createdAt` so "when did I start this cart" survives
   *  a clear-and-refill, but bumps `modifiedAt`. */
  async clear(): Promise<DraftCart> {
    return this.mutate((cart) => {
      cart.name = DEFAULT_NAME;
      cart.captureIds = [];
    });
  }

  /**
   * Apply a synchronous mutation to the cart, bump `modifiedAt`,
   * persist, and return the new cart. The serialize queue makes
   * concurrent dispatches from multiple windows safe — each mutation
   * reads the post-previous-write state.
   */
  private async mutate(fn: (cart: DraftCart) => void): Promise<DraftCart> {
    return this.serialize(async () => {
      const blob = await this.readBlob();
      fn(blob.cart);
      blob.cart.modifiedAt = new Date().toISOString();
      await this.writeBlob(blob);
      return clone(blob.cart);
    });
  }

  private async readBlob(): Promise<StoredBlob> {
    if (this.cachedBlob !== null) return clone(this.cachedBlob);
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") {
        this.cachedBlob = defaultBlob();
        return clone(this.cachedBlob);
      }
      this.log.warn("cart-store: read failed, returning empty", {
        path: this.filePath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      this.cachedBlob = defaultBlob();
      return clone(this.cachedBlob);
    }
    if (raw.length === 0) {
      this.cachedBlob = defaultBlob();
      return clone(this.cachedBlob);
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isStoredBlob(parsed)) {
        this.cachedBlob = defaultBlob();
        return clone(this.cachedBlob);
      }
      // Normalize the cart shape on read so an older / partially-
      // written file can't crash a consumer with a missing field.
      this.cachedBlob = { schemaVersion: 1, cart: sanitizeCart(parsed.cart) };
      return clone(this.cachedBlob);
    } catch (cause) {
      this.log.warn("cart-store: parse failed, quarantining", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      const quarantine = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      try {
        await rename(this.filePath, quarantine);
      } catch {
        /* ignore */
      }
      this.cachedBlob = defaultBlob();
      return clone(this.cachedBlob);
    }
  }

  private async writeBlob(blob: StoredBlob): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(blob, null, 2), "utf8");
      await rename(tmp, this.filePath);
      // Refresh cache AFTER the rename succeeds so a failed write
      // doesn't leave the cache reading ahead of disk. Cloned —
      // the caller's `blob` is shared mutable state.
      this.cachedBlob = clone(blob);
    } catch (cause) {
      try {
        await unlink(tmp);
      } catch {
        /* ignore */
      }
      throw cause;
    }
  }

  private async serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.catch(() => undefined).then(task);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

function sanitizeCart(cart: unknown): DraftCart {
  const fallback = emptyCart();
  if (typeof cart !== "object" || cart === null) return fallback;
  const r = cart as Record<string, unknown>;
  const name =
    typeof r.name === "string" && r.name.trim().length > 0
      ? r.name
      : DEFAULT_NAME;
  const captureIds = Array.isArray(r.captureIds)
    ? r.captureIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const createdAt = typeof r.createdAt === "string" ? r.createdAt : fallback.createdAt;
  const modifiedAt =
    typeof r.modifiedAt === "string" ? r.modifiedAt : fallback.modifiedAt;
  return { name, captureIds, createdAt, modifiedAt };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function isStoredBlob(v: unknown): v is StoredBlob {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return r.schemaVersion === 1 && typeof r.cart === "object" && r.cart !== null;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return (
    value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string"
  );
}

let singleton: CartStore | null = null;
export function getCartStore(): CartStore {
  if (singleton === null) singleton = new CartStore();
  return singleton;
}
