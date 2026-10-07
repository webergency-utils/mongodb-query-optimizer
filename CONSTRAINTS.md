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
4. **`filter-optimization` & `adjacent-match-merging` (Inactive in Production)**:
   - Boolean simplification rules for query filters are held inactive in production until every sub-rule is verified against multikey array semantics and short-circuit error behavior.

---

## 9. Heuristic Shadow Sort-Pushdown Constraint

When an aggregation pipeline performs a Top-K slice (`$sort` + `$limit`) on a computed field produced downstream of joins (`$lookup`) or wildcard document consumers (`$$ROOT`), the optimizer may hoist the Top-K slice earlier in the pipeline using a temporary shadow field `__heuristic_${fieldName}`, followed immediately by `{ $unset: "__heuristic_${fieldName}" }` before the barrier.

### Strict Determinism Requirement
Because this transformation evaluates the sort expression early for slicing and recomputes the target field on the surviving documents in its original position:
- **Mandatory Complete Determinism**: The sort expression must be **strictly and completely deterministic**.
  - **Prohibited Operators**: `$rand`, `$sampleRate`, and any pseudo-random generator.
  - **Prohibited Environment Variables**: `$$NOW`, `$$CLUSTER_TIME`, and dynamic temporal context.
  - **Prohibited Dynamic Date/Time Code**: User code (`$function`, `$accumulator`) containing references to dynamic dates/times (such as `Date`, `new Date()`, `Date.now()`, `performance.now()`) or non-deterministic APIs (`Math.random()`, `crypto`).
  - If an expression cannot be proven completely deterministic, heuristic shadow sort-pushdown is **strictly disallowed**.
- **Preservation of Document Fidelity**:
  - The `$unset` stage guarantees that the temporary shadow field is completely purged before any subsequent stage (such as `$lookup` or a JavaScript `$function` consuming `$$ROOT`) observes the document stream.
  - Intermediate stages between the hoisted slice and the original sort stage must be row-preserving (`cardinality === 'preserves'`).
  - Under strict mode (`strictFieldOrder: true`), this heuristic is disabled to preserve exact BSON document key ordering.
