// Renderer tests use React's createRoot + act directly rather than a testing
// library that sets this flag. Keep it scoped to the jsdom Vitest project.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;
