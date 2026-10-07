import {
  createContext,
  useContext,
  type ReactElement,
  type ReactNode
} from "react";
import type { DraftCart } from "@pwrsnap/shared";
import { useDraftCart } from "../../lib/useDraftCart";

// Single subscription point for the Project Asset Cart. Replaces the
// per-consumer `useDraftCart` calls (Library + DetailRail + CartPanel
// + every grid cell's checkbox) with ONE subscription, and — more
// importantly — splits the cart into two contexts so the heavy Library
// tree doesn't re-render on every toggle:
//
//   • CartStateContext — the full cart. Consumed by the per-cell
//     checkbox, the CartPanel, and the DetailRail tab badge. These
//     re-render on every mutation (they have to — they show cart
//     contents).
//   • CartEmptyContext — a boolean. Consumed by Library (for the
//     grid-mode rail gate + the `data-cart` attribute). Because the
//     value is a primitive, React bails out of re-rendering its
//     consumers when it's referentially equal — so Library only
//     re-renders on the empty↔non-empty EDGE, not on every toggle
//     within a non-empty cart. That keeps the virtualized grid (which
//     isn't memoized) from reflowing on each check.
//
// The provider re-renders on every cart change (it holds the
// subscription), but `children` is a stable element reference passed
// down from App, so React skips re-rendering the Library subtree
// except where a consumed context value actually changed.

const EMPTY_CART: DraftCart = {
  name: "Untitled draft",
  captureIds: [],
  createdAt: "",
  modifiedAt: ""
};

const CartStateContext = createContext<DraftCart>(EMPTY_CART);
const CartEmptyContext = createContext<boolean>(true);
// Whether the first `cart:get` has answered. Until it has, the cart reads
// as EMPTY_CART, so the 0 → N step when a saved cart arrives is a load,
// not the user adding something. Defaults to true outside a provider so
// an isolated test's cart is taken as loaded.
const CartLoadedContext = createContext<boolean>(true);

export function CartProvider({ children }: { children: ReactNode }): ReactElement {
  const { cart, loading } = useDraftCart();
  return (
    <CartLoadedContext.Provider value={!loading}>
      <CartEmptyContext.Provider value={cart.captureIds.length === 0}>
        <CartStateContext.Provider value={cart}>{children}</CartStateContext.Provider>
      </CartEmptyContext.Provider>
    </CartLoadedContext.Provider>
  );
}

/** The full draft cart. Consumers re-render on every cart mutation.
 *  Outside a CartProvider (e.g. an isolated renderer test) returns a
 *  stable empty cart rather than throwing. */
export function useCart(): DraftCart {
  return useContext(CartStateContext);
}

/** Whether the cart is empty. Consumers re-render ONLY on the
 *  empty↔non-empty transition (primitive context value). */
export function useCartIsEmpty(): boolean {
  return useContext(CartEmptyContext);
}

/** Whether the saved cart has been read. Before that, `useCart()` is the
 *  empty placeholder, not the user's cart. */
export function useCartLoaded(): boolean {
  return useContext(CartLoadedContext);
}
