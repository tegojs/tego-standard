import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/docker-version-propagation.test.mjs'],
  },
});
