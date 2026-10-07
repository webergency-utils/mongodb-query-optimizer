# @webergency-utils/mongodb-query-optimizer

Deterministic, zero-dependency MongoDB query and aggregation pipeline optimizer with formal correctness proofs. It simplifies match filters, merges adjacent stages, pushes down predicates, and hoists common facet prefixes while preserving exact document stream equivalence.

[![npm version](https://img.shields.io/npm/v/%40webergency-utils%2Fmongodb-query-optimizer.svg)](https://www.npmjs.com/package/@webergency-utils/mongodb-query-optimizer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Maintenance](https://img.shields.io/badge/maintenance-active-brightgreen.svg)](#maintenance)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/@webergency-utils/mongodb-query-optimizer?activeTab=dependencies)
[![npm downloads](https://img.shields.io/npm/dm/%40webergency-utils%2Fmongodb-query-optimizer.svg)](https://www.npmjs.com/package/@webergency-utils/mongodb-query-optimizer)
<br>
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/webergency-utils/mongodb-query-optimizer/badge)](https://securityscorecards.dev/viewer/?uri=github.com/webergency-utils/mongodb-query-optimizer)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)](#)
[![CI](https://github.com/webergency-utils/mongodb-query-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/webergency-utils/mongodb-query-optimizer/actions/workflows/ci.yml)
[![CodeQL](https://github.com/webergency-utils/mongodb-query-optimizer/actions/workflows/codeql.yml/badge.svg)](https://github.com/webergency-utils/mongodb-query-optimizer/actions/workflows/codeql.yml)

## TL;DR

```typescript
import { optimizeFilter, optimizePipeline } from '@webergency-utils/mongodb-query-optimizer';

// 1. Optimize an aggregation pipeline
const optimizedPipeline = optimizePipeline([
    { $match: { status: { $eq: 'active' } } },
    { $match: { tenantId: 'acme' } },
    { $lookup: { from: 'orders', localField: '_id', foreignField: 'userId', as: 'orders' } },
    { $project: { name: 1, email: 1 } }
]);

// Result:
// - Adjacent $matches merged into a single $match
// - Redundant $lookup eliminated because 'orders' alias is unused in $project
// [
//   { $match: { status: 'active', tenantId: 'acme' } },
//   { $project: { name: 1, email: 1 } }
// ]

// 2. Optimize a find filter
const optimizedFilter = optimizeFilter({
    $and: [
        { age: { $eq: 30 } },
        { tags: { $in: ['mongodb', 'mongodb'] } },
        { $or: [{ active: true }, { active: true }] }
    ]
});

// Result:
// { age: 30, tags: 'mongodb', active: true }
```

## Installation & Setup

Install via your preferred package manager:

```bash
npm install @webergency-utils/mongodb-query-optimizer
```

Or using pnpm / yarn / bun:

```bash
pnpm add @webergency-utils/mongodb-query-optimizer
# or
yarn add @webergency-utils/mongodb-query-optimizer
# or
bun add @webergency-utils/mongodb-query-optimizer
```

This library has **zero runtime dependencies** (`dependencies: {}`) and works out of the box in Node.js (>= 18) and modern browser runtimes.

## Architecture & Internals

The optimizer evaluates queries and aggregation pipelines purely as Abstract Syntax Trees (ASTs) before sending them to MongoDB. Every transformation is governed by an explicit mathematical proof ensuring equivalence across:
- **Membership**: Exactly the same set of documents is matched.
- **Multiplicity**: Document count and array expansions are strictly identical.
- **Field Presence & Values**: All projected and computed fields match.
- **Observable Order**: Deterministic sort orders are preserved.

```
       Raw Pipeline / Filter
                 │
                 ▼
      ┌──────────────────────┐
      │   AST Semantic Parse │ (Extract paths, field dependencies, purity)
      └──────────┬───────────┘
                 │
                 ▼
      ┌──────────────────────┐
      │  Proof-Guarded Pass  │ (20 active pipeline passes, rigorous correctness proofs)
      └──────────┬───────────┘
                 │
                 ▼
      ┌──────────────────────┐
      │ Fixed-Point Drainage │ (Re-run passes until convergence)
      └──────────┬───────────┘
                 │
                 ▼
     Optimized Pipeline / Filter
```

### Active Pipeline Transformations (Production Registry)
1. `add-field-pushdown`: Decomposes `$addFields`/`$set` and safely pushes sort/match-dependent expressions before `$lookup`.
2. `top-k-pushdown`: Advances `$sort` and `$limit` slices ahead of 1:1 compute stages while respecting error guards.
3. `lookup-delay`: Delays `$lookup` joins past non-dependent filter and sort stages.
4. `unwind-prefilter`: Injects shape-safe `$or` prefilters before `$unwind` to discard non-matching documents without dropping polymorphic types or nested arrays.
5. `redundant-sort-elimination`: Collapses consecutive `$sort` stages where the latter supersedes the earlier.
6. `sort-by-count-simplification`: Converts verbose `$group` + `$sort` count patterns into canonical `$sortByCount`.
7. `limit-skip-coalescing`: Combines adjacent `$limit` and `$skip` stages into minimal offsets and counts.
8. `expression-simplification`: Folds constant boolean conditions and simplifies `$size` over `$filter` when conditions are always truthy.
9. `match-pushdown`: Moves selective filter stages ahead of joins and projections.
10. `heuristic-match-pushdown`: Pushes selective `$match` filters across heavy stages (`$lookup`, `$graphLookup`, `$function`) using deterministic shadow fields with per-key ranges and profitability gates.
11. `limit-advance`: Advances `$limit` ahead of non-cardinality altering projections and stages.
12. `group-filter-pushdown`: Pushes post-`$group` filters before `$group` when grouping by 1-to-1 deterministic keys.
13. `bucket-filter-pushdown`: Pushes selective pre-filters before `$bucket` and `$bucketAuto` stages.
14. `unused-field-pruning`: Strips dead fields created in `$addFields`/`$set` when later stages discard them.
15. `adjacent-project-merging`: Fuses consecutive `$project` stages into a single specification.
16. `adjacent-add-field-merging`: Merges adjacent `$addFields` or `$set` stages.
17. `redundant-lookup-elimination`: Drops unused `$lookup` joins whose aliases are discarded downstream.
18. `sort-project-commute`: Commutes `$sort` ahead of `$project` when all sort keys remain visible.
19. `complex-projection-deferral`: Pushes complex computed fields downstream past selective filters.
20. `facet-prefix-hoisting`: Extracts identical prefix stages shared across all branches of a `$facet`.

### Inactive & Contained Passes
- `expr-match-normalization`: Inactive in production pending array traversal safety proofs across multikey arrays.
- `filter-optimization` & `adjacent-match-merging`: Inactive in production pending full formal verification of filter rules under multikey array and short-circuit evaluation semantics.
- `stage-priority-reorder`: Contained; aggregation pipeline stages do not form a total-order lattice.
- `redundant-projection-elimination`: Contained; lossy without complete schema knowledge.

### Performance & Zero-Cost Architecture

Every pass is designed for high-throughput query proxy gateways, query compilers, and ORM interceptors:

| Pipeline Pattern | Mean Latency | Throughput | Primary Transformations Applied |
| :--- | :--- | :--- | :--- |
| **Match-Sort-Limit Fast Path** | **11.86 µs** | **>84,300 ops/sec** | Single-pass match fuse & index path preservation |
| **Multi-Hop Movement** | **23.68 µs** | **>42,200 ops/sec** | Topological hoist past lookups and projections |
| **Contradiction Short-Circuit** | **21.35 µs** | **~46,800 ops/sec** | Fast SAT contradiction reduction |
| **Standard 8-Stage Complex Pipeline** | **37.77 µs** | **~26,500 ops/sec** | Full fixed-point convergence across 19 passes |
| **Complex Boolean Filter Normalization** | **20.38 µs** | **~49,000 ops/sec** | De Morgan reduction & multikey `$and` merging |

- **0 Runtime Dependencies**: Pure TypeScript with zero runtime overhead (`dependencies: {}`).
- **Compact Footprint**: ~158 KB ESM bundle with complete tree-shaking support.
- **Reference Preservation**: If no optimization applies to a stage or pipeline, original references are preserved, avoiding intermediate heap allocation.

### Sound Multikey Array Semantics
In MongoDB, `{ tags: { $gt: 5, $lt: 10 } }` requires a single array element to satisfy both bounds, whereas `{ $and: [{ tags: { $gt: 5 } }, { tags: { $lt: 10 } }] }` can be satisfied by different elements (e.g. `tags: [3, 12]`). The optimizer strictly respects this distinction and never merges potentially multikey range filters into single subdocuments without schema proof.

## Glossary

- **`optimizePipeline`**: Public entry point that executes fixed-point pipeline optimization passes.
- **`optimizeFilter`**: Public entry point that normalizes query filter expressions.
- **`getStageInfo`**: AST analyzer utility returning metadata and field dependencies for any pipeline stage.
- **`StageSemantics`**: Immutable representation of paths read, written, preserved, or removed by a stage.
- **`FilterRule`**: An atomic rule for simplifying a specific BSON filter pattern.
- **`PipelinePass`**: An atomic pipeline transformation verified by formal soundness proofs.

## API Reference

### `optimizePipeline<T = any>(pipeline: any[], options?: OptimizerOptions): T[]`

Optimizes an array of MongoDB aggregation pipeline stages with formal equivalence guarantees.

#### Parameters
- `pipeline` (`any[]`, required): The MongoDB aggregation pipeline to optimize.
- `options` (`OptimizerOptions`, optional): Configuration options controlling strictness:
  - `strictFieldOrder` (`boolean`, default: `false`): When `true`, preserves exact byte-for-byte BSON document key order.
  - `strictErrors` (`boolean`, default: `false`): When `true`, preserves runtime error occurrence and evaluation timing. Note: pipelines containing write stages (`$out`, `$merge`) automatically elevate to `strictErrors: true`.

#### Returns
- `T[]`: A new, optimized aggregation pipeline array. The original input array is never mutated.

#### Code Example
```typescript
import { optimizePipeline } from '@webergency-utils/mongodb-query-optimizer';

const pipeline = [
    { $match: { active: true } },
    { $match: { role: 'admin' } },
    { $sort: { createdAt: -1 } }
];

const optimized = optimizePipeline(pipeline);
// [
//   { $match: { active: true, role: 'admin' } },
//   { $sort: { createdAt: -1 } }
// ]
```

---

### `optimizeFilter<T = any>(filter: any, options?: OptimizerOptions): T`

Normalizes and simplifies a MongoDB query filter document.

#### Parameters
- `filter` (`any`, required): The query filter to normalize.
- `options` (`OptimizerOptions`, optional): Configuration options controlling strictness:
  - `strictFieldOrder` (`boolean`, default: `false`): Preserves exact BSON document key ordering.
  - `strictErrors` (`boolean`, default: `false`): Preserves runtime error conditions. (Recommended for `updateOne`, `updateMany`, `deleteOne`, `deleteMany` filters).

#### Returns
- `T`: The simplified filter document. If no optimizations apply, a clean structurally equivalent filter is returned.

#### Code Example
```typescript
import { optimizeFilter } from '@webergency-utils/mongodb-query-optimizer';

const filter = {
    $and: [
        { status: { $eq: 'pending' } },
        { tags: { $in: ['urgent', 'urgent'] } }
    ]
};

const optimized = optimizeFilter(filter);
// { status: 'pending', tags: 'urgent' }
```

---

### `getStageInfo(stage: any, index?: number): StageInfo`

Analyzes an aggregation stage and returns structural metadata and field dependencies.

#### Parameters
- `stage` (`any`, required): An aggregation pipeline stage object (e.g. `{ $project: { name: 1 } }`).
- `index` (`number`, optional, default: `0`): The 0-based position of the stage in the pipeline.

#### Returns
- `StageInfo`: An object containing:
  - `operator`: The stage operator string (e.g. `'$match'`, `'$project'`).
  - `usedFields`: Set of field paths read/referenced by the stage.
  - `producedFields`: Set of field paths created by the stage.
  - `modifiedFields`: Set of field paths modified by the stage.
  - `removedFields`: Set of field paths removed by the stage.
  - `isDestructive`: Whether the stage replaces document structure (e.g. `$group`, `$project`).
  - `altersCount`: Whether the stage changes document cardinality.

#### Code Example
```typescript
import { getStageInfo } from '@webergency-utils/mongodb-query-optimizer';

const info = getStageInfo({ $project: { fullName: { $concat: ['$firstName', ' ', '$lastName'] } } });

console.log(info.operator);       // '$project'
console.log(info.usedFields);     // Set { 'firstName', 'lastName' }
console.log(info.producedFields); // Set { 'fullName' }
console.log(info.isDestructive);  // true
```

## Troubleshooting

### Dynamic Expressions (`$rand`, `$function`, `$$NOW`)
The optimizer detects non-deterministic expressions such as `$rand` or `$function` and prevents moving or merging stages that contain them to ensure random generators and timestamp semantics are never compromised.

### Custom BSON Types (ObjectId, Long, Decimal128, RegExp)
All custom BSON objects from the official `mongodb` driver are preserved by structural reference or value clone. Regex literals and `BSONRegExp` instances are never collapsed into scalar equality.

### Multikey Array Filters Preserved in `$and`
If you notice that `{ $and: [{ score: { $gt: 5 } }, { score: { $lt: 10 } }] }` is not collapsed into `{ score: { $gt: 5, $lt: 10 } }`, this is intentional: MongoDB multikey array semantics evaluate `$and` across independent array elements, whereas a single subdocument requires a single matching element. Without schema knowledge, collapsing them would alter query results.

## Maintenance

This package is actively maintained.

Bug reports and pull requests are welcome. Security issues and critical
regressions are prioritized. New features are considered when they align
with the package's existing scope.
