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

// 3. Generate canonical abstract query shapes and pretty-print in Allman style
import { formatAbstractQuery, toAbstractQuery } from '@webergency-utils/mongodb-query-optimizer';

const shape = toAbstractQuery(optimizedPipeline);
// '[{"$match":{"status":<string>,"tenantId":<string>}},{"$project":{"email":1,"name":1}}]'

const formatted = formatAbstractQuery(shape, { format: 'allman' });
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
      │  Proof-Guarded Pass  │ (24 active pipeline passes, rigorous correctness proofs)
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
1. `adjacent-match-merging`: Fuses consecutive `$match` stages into `$and` conjunctions while strictly preserving multikey array semantics.
2. `filter-optimization`: Recursively applies provably safe boolean filter normalization rules (`flatten-conjunctions`, `flatten-disjunctions`, `deduplicate-conjunctions`, `simplify-conjunction-identities`, `simplify-disjunction-identities`), numeric and `Date` interval bound tightening, `$not` normalization over `$in`/`$nin`/`$eq`/`$ne`, set-difference and equality-negation algebra (`$in`/`$eq` vs `$nin`/`$ne`), contradiction detection, `$nin` array deduplication, and elimination of no-op `{ $match: {} }` stages.
3. `add-field-pushdown`: Decomposes `$addFields`/`$set` and safely pushes sort/match-dependent expressions across `$lookup`, `$unset`, and intermediate disjoint `$addFields`/`$set` or exclusion `$project` stages.
4. `top-k-pushdown`: Advances `$sort` and `$limit` slices ahead of 1:1 compute and lookup stages (including stepping across simple and computed sort-key-preserving `$project` stages and deterministic shadow-field hoisting from `$addFields`, `$set`, and computed `$project` stages) while respecting error guards.
5. `lookup-delay`: Delays equality and pipeline-form `$lookup` joins past non-dependent filter, sort, limit, and skip stages, splits post-lookup `$match` conjuncts, and pushes filters and head limits (`$unwind` + `$limit: N` or `$skip: S` + `$limit: L`, `$first`, `$arrayElemAt: [..., 0]`, `$slice: [..., N]`) into lookup subpipelines when downstream consumers only reference prefix elements (strictly inhibiting limit pushdown when operators like `$last` are used).
6. `unwind-prefilter`: Injects shape-safe `$or` prefilters before `$unwind` (for both dotted subfields and direct array-element predicates, including across `$and` conjunctions) to discard non-matching documents without dropping polymorphic types or nested arrays.
7. `redundant-sort-elimination`: Eliminates empty `$sort` stages and dead `$sort` stages before adjacent or order-insensitive-separated `$sort`, `$count`, `$sortByCount`, and order-agnostic `$group`, `$bucket`, and `$bucketAuto` stages (including across `$unwind` before order-agnostic collapsing stages).
8. `sort-by-count-simplification`: Converts verbose `$group` + `$sort` count patterns into canonical `$sortByCount`.
9. `limit-skip-coalescing`: Combines adjacent `$limit` and `$skip` stages into minimal offsets and counts, normalizes `{ $limit: L }, { $skip: S }` ($L > S > 0$) into `{ $skip: S }, { $limit: L - S }`, and eliminates no-op `{ $skip: 0 }` stages.
10. `expression-simplification`: Folds and short-circuits constant boolean, conditional, comparison, math, membership, and string expressions (`$and`, `$or` including single-element boolean unwrapping, `$not` including double-negation over boolean operators, `$cond` including idempotent branch folding, `$switch`, `$ifNull`, `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$cmp`, `$in`, `$add`, `$subtract`, `$multiply`, `$divide`, `$mod`, `$abs`, `$ceil`, `$floor`, `$concat`, `$strLenBytes`, `$strLenCP`, ASCII `$toLower`/`$toUpper`) across `$addFields`, `$set`, `$project`, `$group`, and `$match.$expr`, and simplifies `$size` over `$filter` when conditions are always truthy.
11. `match-pushdown`: Moves selective filter stages ahead of joins, projections, field additions, and unsets, splitting multi-conjunct `$match` stages when only a subset of conjuncts can advance.
12. `heuristic-match-pushdown`: Pushes selective `$match` filters across heavy stages (`$lookup`, `$graphLookup`, `$function`) using deterministic shadow fields (from `$addFields`, `$set`, or computed `$project` providers) with per-key ranges and profitability gates.
13. `limit-advance`: Advances `$limit` and `$skip` ahead of non-cardinality altering projections and stages.
14. `group-filter-pushdown`: Pushes post-`$group` filters before `$group` when grouping by 1-to-1 deterministic keys.
15. `bucket-filter-pushdown`: Pushes selective scalar, `$eq`, `$in`, and range (`$gt`, `$gte`, `$lt`, `$lte`) pre-filters before `$bucket` stages.
16. `unused-field-pruning`: Strips dead fields created in `$addFields`/`$set` when immediately overwritten or discarded by the next stage (including potentially throwing expressions when `strictErrors: false`).
17. `adjacent-project-merging`: Fuses consecutive `$project` and exact top-level `$unset` stages into a single specification.
18. `adjacent-add-field-merging`: Merges adjacent `$addFields` or `$set` stages.
19. `redundant-lookup-elimination`: Drops unused equality and pipeline-form `$lookup` joins whose aliases are discarded by adjacent or multi-stage suffixes (`$unset` or `$project`) without intermediate reads.
20. `sort-project-commute`: Commutes `$project` and exact top-level `$unset` stages ahead of `$sort` when all sort keys remain visible.
21. `complex-projection-deferral`: Pushes complex computed fields downstream past selective filters and sorts, and splits non-sort fields past `$sort` when followed by `$limit` or `$skip`.
22. `facet-prefix-hoisting`: Extracts identical deterministic prefix stages (`$match`, `$project`, `$addFields`, `$set`, `$unset`, `$unwind`, `$lookup`, numeric `$sort`, `$limit`, `$skip`) shared across all branches of a `$facet`.
23. `covered-projection-synthesis`: Inserts an index-only inclusion projection in front of a collapsing stage (`$group`, `$bucket`, `$bucketAuto`, `$sortByCount`) to enable covered index execution, keeping only the fields that stage reads, and trims row-count-neutral prefixes before `$count` and zero-dependency `$group` stages.
24. `dead-assignment-elimination`: Removes top-level (and root-discarded dotted) `$addFields`/`$set` assignments, computed inclusion `$project` fields, and redundant `$unset` specifications whose paths are dropped downstream (by `$unset`, `$project`, `$group`, `$count`, `$sortByCount`, `$bucket`, or `$bucketAuto`) without intermediate reads.

### Inactive & Contained Passes
- `expr-match-normalization`: Inactive in production pending array traversal safety proofs across multikey arrays.
- `stage-priority-reorder`: Contained; aggregation pipeline stages do not form a total-order lattice.
- `redundant-projection-elimination`: Contained; lossy without complete schema knowledge.

### Performance & Zero-Cost Architecture

Every pass is designed for high-throughput query proxy gateways, query compilers, and ORM interceptors:

| Pipeline Pattern | Mean Latency | Throughput | Primary Transformations Applied |
| :--- | :--- | :--- | :--- |
| **Match-Sort-Limit Fast Path** | **~15.5 µs** | **>64,000 ops/sec** | Single-pass match fuse & index path preservation |
| **Multi-Hop Movement** | **~19.3 µs** | **>51,000 ops/sec** | Topological hoist past lookups and projections |
| **Contradiction Short-Circuit** | **~6.1 µs** | **>163,000 ops/sec** | Fast SAT contradiction reduction |
| **Standard 8-Stage Complex Pipeline** | **~98.3 µs** | **>10,000 ops/sec** | Full fixed-point convergence across 24 passes |
| **Complex Boolean Filter Normalization** | **~18.7 µs** | **>53,000 ops/sec** | De Morgan reduction & multikey `$and` merging |
| **5-Stage 3,121-Element `ObjectId` `$in` Pipeline** | **~24.1 µs** | **>41,500 ops/sec** | Linear array deduplication & copy-on-write preservation |

- **0 Runtime Dependencies**: Pure TypeScript with zero runtime overhead (`dependencies: {}`).
- **Compact Footprint**: 364 KB ESM bundle (64 KB gzip) with complete tree-shaking support.
- **Copy-on-Write Reference Sharing**: `optimizePipeline` and `optimizeFilter` return a new root array or object without mutating caller inputs, while sharing unmodified stage, sub-filter, operator-array, and BSON leaf references (`===`) via copy-on-write to avoid upfront deep cloning and intermediate heap churn.
- **BSON-Aware `isEqual` Convergence & Deduplication**: Fixed-point convergence, cycle detection, and clause deduplication use a short-circuiting, key-order-sensitive, cycle-safe BSON `isEqual` comparator paired with `O(1)` primitive `Set` fast paths rather than string serialization.
- **High-Performance Linear Array Deduplication & Analysis**: Value arrays (`$in`/`$nin`/`$all`) are deduplicated and cross-pruned in linear $O(N)$ time with zero string allocations using direct 32-bit integer BSON tables and native `Set` routers (handling 3,000+ `ObjectId`s or scalars in microseconds). The optimizer uses an allocation-free copy-on-write strategy (allocating a shallow clone only upon encountering the first duplicate, and setting `.length` in-place). A 64-element safety cap is maintained specifically for complex arbitrary subdocuments (`MAX_COMPLEX_ARRAY_LENGTH = 64`) and logical AST branch trees (`$and`/`$or`/`$nor`) to guard against $O(N^2)$ deep structural recursion.

### Sound Multikey Array Semantics
In MongoDB, `{ tags: { $gt: 5, $lt: 10 } }` requires a single array element to satisfy both bounds, whereas `{ $and: [{ tags: { $gt: 5 } }, { tags: { $lt: 10 } }] }` can be satisfied by different elements (e.g. `tags: [3, 12]`). The optimizer strictly respects this distinction and never merges potentially multikey range filters into single subdocuments without schema proof.

## Glossary

- **`optimizePipeline`**: Public entry point that executes fixed-point pipeline optimization passes.
- **`optimizeFilter`**: Public entry point that normalizes query filter expressions.
- **`toAbstractQuery`**: Generates a canonical, whitespace-free abstract query shape with type tags, commutative sorting, and preserved structural identifiers.
- **`formatAbstractQuery`**: Formats an abstract query shape or raw query AST into an indented, human-readable string in Allman or same-line bracket style.
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
- `T[]`: A new root aggregation pipeline array (`output !== pipeline`). The original input is never mutated, and unmodified stages, nested sub-filters, large operator arrays (`> 64` items), and BSON leaf values are shared by reference (`===`) via copy-on-write.

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
- `T`: A new root filter document (`output !== filter` for object inputs). The original input is never mutated, and unmodified sub-filters, operator arrays, and BSON leaf values are shared by reference (`===`) via copy-on-write.

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

### `toAbstractQuery(query: unknown, options?: ToAbstractQueryOptions): string`

Generates a canonical, whitespace-free abstract query shape for query classification, caching, and execution fingerprinting.

Replaces literal runtime data with unquoted type placeholders (`<string>`, `<number>`, `<boolean>`, `<Date>`, `<ObjectId>`, `<RegExp>`, `<Binary>`, `<Timestamp>`, `<MinKey>`, `<MaxKey>`), collapses literal arrays into sorted unique type sets, deterministically sorts object keys and commutative logical operator branches (`$or`, `$and`, `$nor`), while preserving variable names (`as`, `$$`), schema field paths (`$unset`, `$getField`), positional indexes (`$arrayElemAt`, `$slice`, `$range`), sort directions (`1`, `-1`), projection flags (`1`, `0`, `true`, `false`), and limit counts (`$limit`, `$skip`, `n`).

#### Parameters
- `query` (`unknown`, required): A MongoDB filter document or aggregation pipeline array.
- `options` (`ToAbstractQueryOptions`, optional): Configuration options (reserved for future extensions).

#### Returns
- `string`: A deterministic, whitespace-free canonical JSON-like shape string.

#### Code Example
```typescript
import { toAbstractQuery } from '@webergency-utils/mongodb-query-optimizer';

const query = {
    $match: {
        status: 'active',
        tags: { $in: ['urgent', 'high-priority'] },
        score: { $gt: 90 }
    }
};

const shape = toAbstractQuery(query);
// '{"$match":{"score":{"$gt":<number>},"status":<string>,"tags":{"$in":[<string>]}}}'
```

---

### `formatAbstractQuery(queryOrShape: unknown, options?: FormatAbstractQueryOptions): string`

Formats an abstract query shape or a raw MongoDB query AST into an indented, human-readable string.

#### Parameters
- `queryOrShape` (`unknown`, required): A query object, aggregation pipeline, or a pre-generated abstract shape string.
- `options` (`FormatAbstractQueryOptions`, optional):
  - `format` (`'allman' | 'same-line'`, default: `'same-line'`): Bracket placement style. `'allman'` places opening brackets on their own line.
  - `tabSize` (`number`, default: `2`): Indentation spaces per level.
  - `maxLineLength` (`number`, default: `80`): Line-length threshold for inlining compact leaf expressions, filter operators, and simple stages on a single line.

#### Returns
- `string`: An indented, human-readable query string.

#### Code Example
```typescript
import { formatAbstractQuery } from '@webergency-utils/mongodb-query-optimizer';

const pipeline = [
    { $match: { deleted: { $ne: true } } },
    { $project: { _id: 0, name: 1 } },
    { $sort: { name: 1 } },
    { $limit: 10 }
];

console.log(formatAbstractQuery(pipeline, { format: 'allman', tabSize: 2 }));
// [
//   {
//     "$match":
//     {
//       "deleted": { "$ne": <boolean> }
//     }
//   },
//   {
//     "$project":
//     {
//       "_id": 0,
//       "name": 1
//     }
//   },
//   { "$sort": { "name": 1 } },
//   { "$limit": 10 }
// ]
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
All custom BSON objects, `Date` instances, `RegExp` literals, and `Buffer` values are preserved by reference (`===`) through copy-on-write and compared structurally via BSON-aware `isEqual`. Regex literals and `BSONRegExp` instances are never collapsed into scalar equality.

### Multikey Array Filters Preserved in `$and`
If you notice that `{ $and: [{ score: { $gt: 5 } }, { score: { $lt: 10 } }] }` is not collapsed into `{ score: { $gt: 5, $lt: 10 } }`, this is intentional: MongoDB multikey array semantics evaluate `$and` across independent array elements, whereas a single subdocument requires a single matching element. Without schema knowledge, collapsing them would alter query results.

## Maintenance

This package is actively maintained.

Bug reports and pull requests are welcome. Security issues and critical
regressions are prioritized. New features are considered when they align
with the package's existing scope.
