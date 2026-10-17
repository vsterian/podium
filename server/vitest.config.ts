import { defineConfig } from "vitest/config";

// The server suite also runs the simulator's tests (scripts/), which import server code.
// testSetup.ts keeps the tests' own servers on loopback (issue #137; see docs/GOTCHAS.md).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "../scripts/**/*.test.ts", "../reporters/**/*.test.mjs"],
    setupFiles: ["src/testSetup.ts"],
  },
});
