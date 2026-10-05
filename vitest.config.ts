import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      thresholds: {
        "src/analyzer/expressions.ts": { branches: 100 },
        "src/analyzer/filters.ts": { branches: 100 },
        "src/analyzer/paths.ts": { branches: 100 },
        "src/analyzer/projections.ts": { branches: 100 },
        "src/analyzer/semantics.ts": { branches: 100 },
        "src/passes/bucket-filter-pushdown.ts": { branches: 100 },
        "src/passes/bucket-pushdown-proofs.ts": { branches: 100 },
        "src/passes/expr-match-normalization.ts": { branches: 100 },
        "src/passes/expr-normalization-proofs.ts": { branches: 100 },
        "src/passes/facet-prefix-hoisting.ts": { branches: 100 },
        "src/passes/facet-proofs.ts": { branches: 100 },
        "src/passes/group-filter-pushdown.ts": { branches: 100 },
        "src/passes/group-pushdown-proofs.ts": { branches: 100 },
        "src/passes/limit-skip-coalescing.ts": { branches: 100 },
        "src/passes/movement-proofs.ts": { branches: 100 },
        "src/passes/projection-proofs.ts": { branches: 100 },
        "src/passes/redundant-sort-elimination.ts": { branches: 100 },
        "src/passes/sort-by-count-proofs.ts": { branches: 100 },
        "src/passes/sort-by-count-simplification.ts": { branches: 100 },
        "src/passes/sort-proofs.ts": { branches: 100 },
        "src/passes/unwind-prefilter.ts": { branches: 100 },
        "src/passes/unwind-proofs.ts": { branches: 100 },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/**/*.integration.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/**/*.integration.test.ts"],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
