// Renderer tests use React's createRoot + act directly rather than a testing
// library that sets this flag. Keep it scoped to the jsdom Vitest project.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

import { aroundAll, aroundEach } from "vitest";
import { getActWarningGuard } from "./act-warning-guard";

const guard = getActWarningGuard();
guard.install();
// Vitest parses hook parameters as fixture names and requires destructuring.
aroundAll((runSuite, {}, suite) => guard.owners.run(suite, runSuite));
aroundEach((runTest, { task }) => guard.owners.run(task, runTest));
