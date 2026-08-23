/**
 * One shared lease for every user-facing selector flow (still and video).
 *
 * `pickRegion()` historically superseded an existing resolver. That is not
 * safe while callers own teardown: the superseded caller can wake up, run its
 * delayed cancel choreography, and hide/release the newer caller's selector.
 * Rejecting the duplicate before it enters the picker keeps ownership linear.
 */

export type InteractiveSelectorLease = {
  release(): void;
};

let activeLease: symbol | null = null;

export function tryAcquireInteractiveSelectorLease(): InteractiveSelectorLease | null {
  if (activeLease !== null) return null;
  const token = Symbol("interactive-selector-flow");
  activeLease = token;
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      if (activeLease === token) activeLease = null;
    }
  };
}

/** Test-only observability without exposing a way to mutate ownership. */
export function isInteractiveSelectorLeased(): boolean {
  return activeLease !== null;
}
