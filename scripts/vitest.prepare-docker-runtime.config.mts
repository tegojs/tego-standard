import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/prepare-docker-runtime.test.ts'],
  },
});
