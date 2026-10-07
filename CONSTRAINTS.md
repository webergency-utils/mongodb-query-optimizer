# Correctness Constraints & Guarantees

These constraints define the formal correctness guarantees and boundary conditions that govern `@webergency-utils/mongodb-query-optimizer`.

---

## 1. Core Equivalence Guarantee (R1)

Under MongoDB semantics, any optimized query filter or aggregation pipeline produced by this package must preserve exact document stream equivalence with the original form:

1. **Membership**: The set of documents returned by the optimized query or pipeline is identical to the original.
2. **Multiplicity**: The count and duplicate multiplicity of documents match exactly across all pipeline stages.
3. **Field Presence & Values**: All projected, computed, joined, or grouped field values match original values across all BSON data types (scalars, objects, arrays, dates, ObjectIds, binary, nulls, and missing fields).
4. **Observable Order**: Deterministic sort orders are strictly preserved. When an explicit `$sort` is present, the final sequence of documents is preserved.

---

## 2. Field Order Guarantee (R2)

- **Default Mode (`strictFieldOrder: false`)**:
  - In MongoDB and JSON, document field order within a BSON document is generally considered relaxed. However, certain operations (such as composite key equality or hashing) may be sensitive to key order.
  - In default mode, transformations may reorder adjacent fields (e.g. hoisting a computed sort key ahead of a `$lookup` join) when it improves query execution speed.
- **Strict Mode (`strictFieldOrder: true`)**:
  - Every transformation must preserve the exact byte-level BSON key order of every document in the stream.
  - Passes that would change field order (such as `add-field-pushdown` moving fields past `$lookup`, or `lookup-delay` moving joined arrays relative to other fields) automatically step aside and preserve the original stage structure.

---

## 3. Error Observability Guarantee (R3, R6)

- **Default Mode (`strictErrors: false`)**:
  - In read-only analytics queries, if an unselected or dropped document would trigger a runtime evaluation error in a partial expression (e.g. `$toInt` on a string, `$divide` by zero, or `$arrayElemAt` on a non-array), the optimizer may allow selective filters or `$limit` stages to discard that row earlier.
  - As a result, a query that would have failed due to an error on an irrelevant row may succeed under optimization.
- **Strict Mode (`strictErrors: true`)**:
  - Error occurrence, error timing, and error conditions are strictly preserved.
  - No filter or limit may be advanced past an expression that is not proven error-free (`errors !== 'none-known'`).
  - Partial functions, type conversions, division, string slicing, and user-defined JavaScript (`$function`, `$accumulator`) act as strict barriers against stage reordering or dead-code elimination.

---

## 4. Write-Path Safety & Side-Effect Protection (R5)

Pipelines that perform collection writes or external side effects must never risk partial writes, altered write timing, or masked runtime errors:

- **Automatic Strict Errors**: Any aggregation pipeline containing write stages (`$out` or `$merge`) automatically elevates to `strictErrors: true`.
- **Barrier Containment**: Write stages act as impenetrable optimization barriers. No stage may commute past `$out` or `$merge`.
- **Write-Path Advice**: For update and delete filters (such as `updateOne`, `updateMany`, `deleteOne`, `deleteMany` in Mongoose or native drivers), callers are strongly advised to specify `{ strictErrors: true }` to guarantee identical match criteria and avoid unintended side-effect elimination.

---

## 5. Polymorphic Schema Safety (R4)

MongoDB is inherently schema-flexible. Collections frequently contain polymorphic documents where a single field path may hold different BSON types across documents:
- A field may be a scalar in some documents, an array in others, an object, or missing entirely.
- Transformations must **never assume homogeneous types**:
  - In `unwind-prefilter`, unwinding `$items` must account for documents where `items` is an object or scalar, as well as nested arrays (`items: [[{ ... }]]`). The injected prefilter uses a shape-safe `$or` guard rather than a naive `$elemMatch`.
  - In `top-k-pushdown`, sort keys that are arrays in some documents and scalars in others follow MongoDB's BSON type comparison ordering without assuming scalar comparisons.
  - Grouping keys and join keys must safely handle missing, null, or heterogeneously-typed values without crashing or producing invalid syntax.

---

## 6. Lookup Execution & Join Safety

Unlike unconstrained generic query rewrites:
- A simple `$lookup` cannot be unconditionally moved or eliminated.
- **`lookup-delay`**: Delays `$lookup` execution past non-dependent filter and sort stages only when:
  1. The filter or sort does not reference the lookup's target `as` alias.
  2. The join alias is not required for document ordering.
  3. Under `strictErrors: true`, the lookup subpipeline is proven error-free.
  4. Under `strictFieldOrder: true`, delaying the lookup does not alter the relative order of fields in the resulting document.
- **`redundant-lookup-elimination`**: Eliminates a `$lookup` stage only when downstream stages (`$project`, `$unset`) definitively discard the join alias without any intermediate stage reading it, and the lookup subpipeline cannot throw errors under the active error policy.

---

## 7. Configuration Options API (R7)

Both public optimizer entry points accept an optional `OptimizerOptions` configuration object:

```typescript
export interface OptimizerOptions
{
    readonly strictFieldOrder?: boolean;
    readonly strictErrors?: boolean;
}
```

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `strictFieldOrder` | `boolean` | `false` | When `true`, preserves exact BSON document key ordering across all stages. |
| `strictErrors` | `boolean` | `false` | When `true`, preserves exact runtime error occurrence and timing. Automatically enabled for pipelines with `$out` or `$merge`. |

---

## 8. Contained Passes & Registry Invariants (R10–R14)

The optimizer registry distinguishes between **active** transformations (mathematically verified, accompanied by formal proof manifests, and verified across all BSON types in differential testing) and **contained / inactive** transformations:

1. **`stage-priority-reorder` (Contained)**:
   - Stages in a MongoDB aggregation pipeline do not form a total-order lattice.
   - Pairwise stage commutation must remain strictly proof-driven. Global priority bubble reordering is permanently contained.
2. **`redundant-projection-elimination` (Contained)**:
   - Arbitrary projection removal without full schema knowledge is lossy in MongoDB. It remains contained until schema-aware typing is available.
3. **`expr-match-normalization` (Inactive in Production)**:
   - Normalizing `$expr` comparisons to top-level query operators requires rigorous array traversal safety guarantees to avoid changing match semantics over multikey arrays. It is held inactive in production pending complete array-path proofs.
4. **`filter-optimization` & `adjacent-match-merging` (Active in Production)**:
   - **Provably Safe Filter Normalization**: The production filter optimizer safely activates 5 structural normalization rules:
     - `flatten-conjunctions`: Flattens nested associative `$and` arrays (`{ $and: [ { $and: [ A, B ] }, C ] }` $\rightarrow$ `{ $and: [ A, B, C ] }`).
     - `flatten-disjunctions`: Flattens nested associative `$or` arrays (`{ $or: [ { $or: [ A, B ] }, C ] }` $\rightarrow$ `{ $or: [ A, B, C ] }`).
     - `deduplicate-conjunctions`: Eliminates duplicate branches in `$and` arrays using deterministic structural BSON hashing.
     - `simplify-conjunction-identities`: Eliminates empty identity filters (`{}`) and unwraps single-branch `$and` arrays (`{ $and: [ A ] }` $\rightarrow$ `A`).
     - `simplify-disjunction-identities`: Short-circuits `$or` containing empty filter tautologies (`{ $or: [ {}, A ] }` $\rightarrow$ `{}`), eliminates duplicate branches, and unwraps single-condition disjunctions (`{ $or: [ A ] }` $\rightarrow$ `A`).
   - **Multikey Array Safety Invariant**: In MongoDB, `{ tags: { $gt: 5, $lt: 10 } }` requires a *single* array element to satisfy both bounds simultaneously. In contrast, `{ $and: [ { tags: { $gt: 5 } }, { tags: { $lt: 10 } } ] }` or two consecutive `$match` stages can be satisfied by *two distinct* array elements (e.g. `tags: [3, 12]`). Therefore, the optimizer **NEVER** collapses separate `$and` branches for the same field path into a single subdocument. The `merge-conjunctions` rule is permanently held inactive in production.
   - **Adjacent Match Merging**: `adjacent-match-merging` fuses consecutive `$match` stages into a single `{ $match: { $and: [ ...matches ] } }`. Subsequent safe filter normalization flattens nested conjunctions and deduplicates identical conditions, while preserving separate conditions on the same field in distinct `$and` branches.
   - **Error and Determinism Guards**: All filter rewrites are strictly guarded by `isFilterRewriteSafe`, which guarantees that non-deterministic expressions (`$rand`, `$sampleRate`), partial error-throwing functions, or unknown operator shapes are never rewritten or dropped.

---

## 9. Heuristic Shadow Pushdown Constraints

When an aggregation pipeline contains a consumer stage—either a Top-K slice (`$sort` + `$limit`) in `top-k-pushdown` or a selective filter (`$match`) in `heuristic-match-pushdown`—that references computed fields produced downstream of heavy execution barriers, the optimizer may hoist the consumer earlier in the pipeline using temporary shadow fields named `__heuristic_${fieldName}` (with collision-avoidance suffixes `__heuristic_${fieldName}_0`, etc.). The shadow fields are subsequently removed with an explicit `{ $unset: ... }` stage before any barrier or downstream consumer.

### 9.1 Shared Shadow Proof Machinery (`shadow-proofs.ts`)
Both `top-k-pushdown` and `heuristic-match-pushdown` share the unified shadow proof machinery in `src/passes/shadow-proofs.ts`:
- **Single-Provider Hoisting**: Each computed key must be defined by a single upstream `$addFields`/`$set` stage (`providerStageIndex`).
- **Per-Key Range Rule**: The provider stage `P` must strictly precede the consumer stage `C` (`P < C`). Every intermediate stage in the range `[P + 1, C - 1]` must preserve document cardinality (`semantics.cardinality === 'preserves'`) and must neither modify, unset, nor re-alias the provider's input keys or the generated shadow field.
  - In `heuristic-match-pushdown`, pushed stages may cross preserving stages or upstream `$match` stages (`semantics.operator === '$match'`), but may never cross `$limit`, `$skip`, or other non-match cardinality modifiers.
- **Dotted-Key Rejection Rule (KTD3)**: Computed fields with dotted path keys (e.g. `user.profile.age` or `stats.scores`) are strictly rejected. Only top-level field identifiers can be hoisted via shadow fields.
- **Profitability Gate**: Hoisting via shadow fields introduces extra re-computation stages and temporary allocations. Pushdown is strictly gated to ensure profitability:
  - The range between the hoisted position and the original consumer position must contain at least one heavy stage.
  - Heavy stages include `$lookup`, `$graphLookup`, or `$function`.
  - Stages such as `$accumulator` or standard arithmetic projections are omitted from qualifying as heavy stages on their own. If no heavy stage is crossed, pushdown is skipped.
- **`strictErrors` Whole-Range Rule**: Under `{ strictErrors: true }`, early evaluation or moving filters/slices ahead of intermediate stages must not mask or alter runtime error evaluation. Pushdown is allowed only when every stage in the spanned range `[hoistIndex, consumerIndex]` is proven error-free (`semantics.errors === 'none-known'`).
- **Recomputation After `$unset` (KTD10)**: The hoisted consumer acts as an early filter or slice. Downstream, before the original consumer position, an explicit `$unset` purges all temporary shadow fields. If downstream stages still require the original computed field name, the original provider stage continues to provide the field without collision.
- **Native Match Preservation (KTD8)**: For `heuristic-match-pushdown`, pushed `$match` stages preserve their native query operator syntax against the shadow field (e.g. `{ __heuristic_total: { $gt: 10 } }`) rather than rewriting into `$expr`, maintaining index accessibility and standard match execution semantics.

### 9.2 Strict Determinism Verification (KTD5)
Because heuristic pushdown evaluates expressions early on candidate documents and re-evaluates them on surviving documents:
- **Mandatory Complete Determinism**: All expressions defining shadow fields must be strictly deterministic across document streams:
  - **Prohibited Operators**: `$rand`, `$sampleRate`, and any non-deterministic expression operator.
  - **Prohibited System Variables**: `$$NOW`, `$$CLUSTER_TIME`, and dynamic temporal context variables.
  - **Prohibited JavaScript APIs**: When evaluating user-defined JavaScript functions in `$function`, the optimizer inspects both the argument expressions and the function body string.
    - Argument expressions are checked for determinism with `$function` replaced by deterministic placeholders.
    - The JavaScript function `body` is checked against a strict token blocklist: references to `Date`, `new Date()`, `Date.now()`, `performance.now()`, `Math.random()`, `crypto`, and dynamic non-deterministic globals immediately disqualify the stage.
  - Any non-deterministic component halts shadow pushdown immediately.

### 9.3 Field Ordering Invariant
Under strict mode (`strictFieldOrder: true`), heuristic shadow transformations are disabled to preserve exact byte-for-byte BSON document key ordering.

---

## 10. Expression Simplification Constraints (`expression-simplification`)

The `expression-simplification` pass simplifies constant boolean conditions and redundant filter-size patterns across aggregation pipeline stages (`$addFields`, `$set`, `$project`, `$group`, `$match`).

### 10.1 Constant Folding Rules
- **Conjunctions (`$and`)**:
  - Empty conjunctions `{ $and: [] }` or conjunctions where every operand is a truthy constant (e.g. `{ $and: [ {}, {} ] }` or `{ $and: [ true, 1 ] }`) fold to `true`.
  - If any operand is a falsy constant (e.g. `false`, `0`, `null`), the conjunction folds to `false`.
  - Truthy constant operands are stripped from multi-operand conjunctions when remaining non-constant operands exist.
- **Disjunctions (`$or`)**:
  - Empty disjunctions `{ $or: [] }` fold to `false`.
  - If any operand is a truthy constant, the disjunction folds to `true`.
  - Falsy constant operands are stripped from multi-operand disjunctions when remaining non-constant operands exist.

### 10.2 Filter-to-Size Simplification
When an expression specifies `$size` over a `$filter` stage:
```typescript
{
    $size:
    {
        $filter:
        {
            input: expr,
            as: varName,
            cond: alwaysTrueCondition
        }
    }
}
```
If the filter's `cond` expression simplifies to a constant truthy value (such as `true` or an always-true folded `$and`), every element in `input` is guaranteed to pass the filter. The expression simplifies directly to:
```typescript
{
    $size: expr
}
```

### 10.3 Error Observability & Strict Errors (KTD9)
MongoDB's `$filter` and `$size` operators exhibit specific runtime error behavior:
- On scalar (non-array) inputs, `$filter` produces an error (e.g. `PlanExecutor error during aggregation :: caused by :: input to $filter must be an array not string`).
- Simplifying `$size: { $filter: { ... } }` to `$size: input` on non-array or missing inputs could alter the exact error code or timing.
- **Strict Error Guard**: The `expression-simplification` pass is automatically bypassed whenever `options.strictErrors === true`. Constant folding and filter simplifications are applied only in `default` and `strictFieldOrder` modes.

