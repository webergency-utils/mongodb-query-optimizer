# Test notes

## Rules

- Unit tests live in `tests/`, not `src/tests/`.
- Integration files are only `tests/**/*.integration.test.ts`.
- Assert successful-result rewrites at the public proof and pass boundary, not private helpers.
- Positive cases must change the pipeline; negative cases must leave it unchanged.
- Lookup plus `$unwind` is a multiplicity barrier even when the alias is later discarded.
- `$unwind` or `$group` next to `$limit` is a cardinality barrier.
- `$sort` then `$project` commutes only when every sort key stays visible.
- Non-adjacent dead-write pruning may cross only stages that do not observe the write. Exclusion `$project`, whole-document reads, `$facet` / `$lookup`, and unknown stages are barriers. `$unwind` / `$group` that do not read the write do not block.

## Anti-Patterns

- Do not re-enable `stage-priority-reorder` to get extra swaps.
- Do not treat a different server error as proof that two successful pipelines are equivalent.
- Do not prune `$project` inclusion entries just because a later project drops them.
- Do not eliminate `$graphLookup` or pipeline-form `$lookup` without a dedicated proof.

## Mocking Conventions

- Do not mock MongoDB for these rewrite tests. Use proof functions, isolated passes, and `optimizePipeline`.
- Use the in-memory mock executor only through existing `verifyPipelineEquivalence` helpers.
