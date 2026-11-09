import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Піднімає PostgreSQL 16.15 (Testcontainers) один раз на весь прогін; Kafka — лише kafka.test.ts.
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Точки входу лише збирають залежності й запускають процес; адаптер Kafka перевіряє kafka.test.ts
      // (без Docker його пропускають, тож у поріг покриття він не входить).
      exclude: ['src/server.ts', 'src/migrate.ts', 'src/kafka/platformatic.ts'],
      reporter: ['text', 'text-summary'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
    },
  },
});
