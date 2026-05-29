import { useEffect, useState } from "react";
import { EVENT_CHANNELS, type DraftCart } from "@pwrsnap/shared";
import { dispatch, subscribe } from "./pwrsnap";

// Note: the broadcast PRODUCER (cart-handlers.ts) uses `EventPayloads`
// in `@pwrsnap/shared/src/ipc.ts` to type-check the payload at send
// time. The consumer side (this hook) STILL shape-checks at runtime
// because `subscribe()` hands callbacks `unknown` by design — the
// preload bridge can't enforce types across the IPC boundary. Same
// pattern as `useSizzleProjects`.

const EMPTY_CART: DraftCart = {
  name: "Untitled draft",
  captureIds: [],
  createdAt: "",
  modifiedAt: ""
};

function isDraftCart(value: unknown): value is DraftCart {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.name === "string" &&
    Array.isArray(r.captureIds) &&
    r.captureIds.every((id) => typeof id === "string")
  );
}

/**
 * Subscribe to the single global Project Asset Cart. Fetches once on
 * mount via `cart:get`, then listens to `events:cart:changed` for live
 * updates pushed by the main process on every cart mutation (toggle /
 * reorder / remove / rename / clear / commit).
 *
 * Mirrors `useSizzleProjects` — fetch-once-then-subscribe, no polling.
 * The cart lives in the main process so two BrowserWindows (e.g. the
 * Library and a future detached panel) share one cart and stay in
 * sync on the next event tick.
 *
 * Returns the cart + a loading flag so consumers can avoid flashing an
 * empty cart before the first read returns.
 */
export function useDraftCart(): { cart: DraftCart; loading: boolean } {
  const [cart, setCart] = useState<DraftCart>(EMPTY_CART);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void dispatch("cart:get", {}).then((r) => {
      if (!active) return;
      // Shape-check before commit. In production the bus guarantees a
      // DraftCart; renderer test stubs that don't mock `cart:get`
      // would otherwise crash here. Mirrors the useSizzleProjects
      // guard rationale.
      if (r.ok && isDraftCart(r.value)) {
        setCart(r.value);
      }
      setLoading(false);
    });
    const unsubscribe = subscribe(EVENT_CHANNELS.cartChanged, (payload) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        isDraftCart((payload as { cart?: unknown }).cart)
      ) {
        setCart((payload as { cart: DraftCart }).cart);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return { cart, loading };
}
