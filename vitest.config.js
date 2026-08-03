import { defineConfig } from 'vitest/config';

// Root Vitest config. Test behaviour stays at Vitest defaults (npm run test:unit is
// unaffected); the coverage block only applies when --coverage is passed
// (npm run coverage:unit). The unit half of the merged coverage gate is written here
// as coverage/unit/coverage-final.json and combined with the c8 harness half by
// scripts/coverage-gate.mjs.
export default defineConfig({
  test: {
    // Scope to the engine's own unit tests. `npm run test:unit` passes `test/unit`
    // explicitly, but a bare `vitest run` at the repo root would otherwise also
    // sweep up landing/test/**, which needs the jsdom environment configured in
    // landing/vite.config.js and fails noisily under this config.
    include: ['test/unit/**/*.test.js'],
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.js'],
      reporter: ['json', 'text-summary'],
      reportsDirectory: 'coverage/unit',
    },
  },
});
