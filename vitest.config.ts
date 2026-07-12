import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Live-node suites share one RPC (SENTINEL_TEST_RPC): snapshot/revert is
    // global node state, so test files must not run concurrently against it.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
