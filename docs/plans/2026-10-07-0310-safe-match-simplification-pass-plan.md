---
title: "feat: Activate safe recursive $match simplification and adjacent match merging"
date: "2026-10-07"
type: "feat"
artifact_contract: "ce-unified-plan/v1"
artifact_readiness: "implementation-ready"
product_contract_source: "ce-plan-bootstrap"
execution: "code"
---

## Goal Capsule

### Objective
Enable safe, recursive `$match` pipeline simplification and adjacent `$match` stage merging in `@webergency-utils/mongodb-query-optimizer` without compromising MongoDB multikey array semantics, field ordering, or runtime error observability.

### Means
1. Certify and activate a strictly safe subset of filter normalization rules in `src/filter-rule-registry.ts`:
   - `flatten-conjunctions`
   - `flatten-disjunctions`
   - `deduplicate-conjunctions` (with deterministic hashing)
   - `simplify-conjunction-identities` (eliminating `{}` tautologies and single-branch unwrapping)
   - `simplify-disjunction-identities` (deduplication and tautology short-circuiting)
2. Keep dangerous multikey rules permanently inactive:
   - `merge-conjunctions` (which collapses conditions on the same field into single subdocuments, altering multikey array element semantics)
   - Unsafe regex/complex-type conversions in `simplify-equality`
3. Activate `adjacent-match-merging` in `src/passes/adjacent-match-merging.ts` by fusing adjacent `$match` stages exclusively into `$and` arrays without collapsing multikey field boundaries.
4. Activate `filter-optimization` in `src/passes/filter-optimization.ts` to run the recursive safe filter sweep across all `$match` stages in aggregation pipelines.
5. Update proof manifests in `tests/fixtures/proof-manifest.ts` to audit and activate these transformations.
6. Verify 100% branch coverage and differential equivalence against live MongoDB 8 across all modes (`default`, `strictFieldOrder`, `strictErrors`).

### Authority Hierarchy
1. Document stream equivalence guarantee (R1): Output documents must match unoptimized queries across membership, multiplicity, field values, and order.
2. Multikey array safety (R4): Never collapse `$and` branches into a single subdocument on potentially multikey paths.
3. Error fidelity (R3): Under `strictErrors: true`, do not eliminate or reorder branches that may throw runtime errors.
4. Field order fidelity (R2): Under `strictFieldOrder: true`, preserve exact BSON key ordering.

---

## Product Contract

### Problem Frame
MongoDB users and ORM interceptors frequently produce redundant, deeply-nested, or repeated `$match` stages:
- Chained `$match` stages (e.g. `[ { $match: { a: 1 } }, { $match: { b: 2 } } ]`)
- Redundant `$and` nesting (e.g. `{ $and: [ { $and: [ { a: 1 } ] }, { a: 1 } ] }`)
- Repeated identical filter branches from query composition frameworks (e.g. `{ $or: [ { status: 'active' }, { status: 'active' } ] }`)
- Empty identity filters (e.g. `{ $and: [ {}, { status: 'active' } ] }`)

Currently, `filter-optimization` and `adjacent-match-merging` are held inactive in the production pipeline pass registry because previous iterations attempted aggressive multikey condition merging (`merge-conjunctions`), which is unsafe on multikey arrays. By extracting and activating only the provably sound structural normalization rules, we can safely eliminate redundant branches and merge `$match` stages without changing query semantics.

### Requirements

- R1. The optimizer must recursively simplify `$match` stages across nested `$and`, `$or`, `$nor`, and `$elemMatch` blocks.
- R2. Conjunctions and disjunctions with duplicate identical branches (`A && A`, `A || A`) must collapse to a single branch `A`, provided `A` is deterministic.
- R3. Nested associative logical operators must be flattened:
  - `{ $and: [ { $and: [ A, B ] }, C ] }` $\rightarrow$ `{ $and: [ A, B, C ] }`
  - `{ $or: [ { $or: [ A, B ] }, C ] }` $\rightarrow$ `{ $or: [ A, B, C ] }`
- R4. Tautological empty identity filters (`{}`) must be eliminated from `$and`, and single-branch `$and` or `$or` arrays must be unwrapped (`{ $and: [ A ] }` $\rightarrow$ `A`).
- R5. Consecutive `$match` stages in a pipeline must merge into a single `$match` containing an `$and` conjunction of the individual stages:
  - `[ { $match: A }, { $match: B } ]` $\rightarrow$ `[ { $match: { $and: [ A, B ] } } ]` (or simplified form if A or B is `{}` or identical).
- R6. Multikey Array Invariant: The optimizer must NEVER merge separate `$and` branches for the same field into a single subdocument (i.e. `{ $and: [ { tags: { $gt: 5 } }, { tags: { $lt: 10 } } ] }` must NOT be merged to `{ tags: { $gt: 5, $lt: 10 } }`).
- R7. Strict Errors Invariant: Under `{ strictErrors: true }`, any branch containing potentially error-throwing expressions (`$expr`, partial type casts, non-deterministic functions) must not be eliminated or reordered.
- R8. Strict Field Order Invariant: Under `{ strictFieldOrder: true }`, exact BSON key order must be strictly preserved.
- R9. Zero Runtime Dependencies: All changes must use native TypeScript and existing internal analyzer helpers.

### Scope Boundaries
- **In Scope**:
  - Activating safe filter rules in `src/filter-rule-registry.ts`.
  - Activating `filter-optimization` and `adjacent-match-merging` in `src/passes/registry.ts`.
  - Guarding rules against multikey condition merging.
  - Adding proof manifest entries in `tests/fixtures/proof-manifest.ts`.
  - Adding unit and differential tests for multikey arrays, nested logic, and error modes.
- **Out of Scope**:
  - Activating `merge-conjunctions` (remains inactive).
  - Normalizing `$expr` comparisons to top-level MQL (`expr-match-normalization` remains inactive).
  - Schema-aware multikey index inference.

---

## Planning Contract

### Key Technical Decisions

- KTD1: **Safe Filter Rule Profile**: Activate exactly 5 rules in `activeFilterRuleIds` in `src/filter-rule-registry.ts`:
  1. `flatten-conjunctions`
  2. `flatten-disjunctions`
  3. `deduplicate-conjunctions`
  4. `simplify-conjunction-identities`
  5. `simplify-disjunction-identities`
  Keep `merge-conjunctions`, `simplify-equality`, and `simplify-singleton-in` inactive in production `activeFilterRuleIds` until type/regex audits are complete.

- KTD2: **Deterministic Deduplication**: In `deduplicate-conjunctions` and `simplify-disjunction-identities`, only deduplicate branches when `isDeterministicExpression(branch)` is true, preventing non-deterministic expressions (`$rand`, dynamic functions) from having their evaluation count changed.

- KTD3: **Adjacent Match Merging Strategy**: In `AdjacentMatchMergingPass`, merge consecutive `$match` stages into `{ $match: { $and: [ M1, M2, ... ] } }`. When passed to `optimizeFilterWithContext`, the active safe rules will flatten nested `$and` arrays and deduplicate identical conditions without ever collapsing field subdocuments.

- KTD4: **Registry Pipeline Pass Order**: Register `adjacent-match-merging` and `filter-optimization` in `activePipelineTransformationIds` in `src/passes/registry.ts`:
  - `adjacent-match-merging` runs early (merging adjacent filters before predicate pushdown).
  - `filter-optimization` runs after merging and before `match-pushdown`.

- KTD5: **Strict Errors Safety Guard**: In `applyFilterDocumentSweep` or individual rule definitions, if `context.options?.strictErrors === true`, bypass elimination of branches that contain non-trivial `$expr` or partial operators.

---

## High-Level Technical Design

```
Raw Pipeline:
[
  { $match: { $and: [ { tags: { $gt: 5 } }, { tags: { $gt: 5 } } ] } },
  { $match: { status: "active" } },
  { $match: { tags: { $lt: 10 } } }
]
               │
               ▼
1. Adjacent Match Merging:
   Fuses adjacent $match stages into single $and:
   { $match: { $and: [
       { $and: [ { tags: { $gt: 5 } }, { tags: { $gt: 5 } } ] },
       { status: "active" },
       { tags: { $lt: 10 } }
   ] } }
               │
               ▼
2. Flatten Conjunctions:
   Flattens nested $and arrays:
   { $match: { $and: [
       { tags: { $gt: 5 } },
       { tags: { $gt: 5 } },
       { status: "active" },
       { tags: { $lt: 10 } }
   ] } }
               │
               ▼
3. Deduplicate Conjunctions:
   Eliminates identical structural hashes:
   { $match: { $and: [
       { tags: { $gt: 5 } },
       { status: "active" },
       { tags: { $lt: 10 } }
   ] } }
               │
               ▼
(Notice: { tags: { $gt: 5 } } and { tags: { $lt: 10 } } remain separate $and branches,
 preserving exact multikey array matching across different array elements!)
```

---

## Implementation Units

### U1. Safe Filter Rule Profile Activation & Determinism Guard
- **Goal**: Enable the 5 provably safe filter rules in `src/filter-rule-registry.ts` and guard deduplication against non-deterministic expressions and strictErrors.
- **Requirements**: R1, R2, R3, R4, R6, R7, R8
- **Files**:
  - `src/filter-rule-registry.ts`
  - `tests/filter-optimizer.test.ts`
- **Approach**:
  1. Update `activeFilterRuleIds` in `src/filter-rule-registry.ts` to include:
     `'flatten-conjunctions'`, `'flatten-disjunctions'`, `'deduplicate-conjunctions'`, `'simplify-conjunction-identities'`, `'simplify-disjunction-identities'`.
  2. In `deduplicate-conjunctions` and `simplify-disjunction-identities`, verify branch determinism using internal AST analyzer helpers before dropping duplicates.
  3. Ensure under `strictErrors: true`, branches with partial `$expr` errors are not discarded.
- **Test Scenarios**:
  - Deduplicate identical scalar branches: `{ $and: [ { a: 1 }, { a: 1 } ] }` $\rightarrow$ `{ a: 1 }`.
  - Deduplicate identical multikey range branches: `{ $and: [ { tags: { $gt: 5 } }, { tags: { $gt: 5 } } ] }` $\rightarrow$ `{ tags: { $gt: 5 } }`.
  - Flatten nested conjunctions: `{ $and: [ { $and: [ { a: 1 }, { b: 2 } ] }, { c: 3 } ] }` $\rightarrow$ `{ $and: [ { a: 1 }, { b: 2 }, { c: 3 } ] }`.
  - Strip empty identity: `{ $and: [ {}, { a: 1 } ] }` $\rightarrow$ `{ a: 1 }`.
  - Preserve separate multikey branches: `{ $and: [ { tags: { $gt: 5 } }, { tags: { $lt: 10 } } ] }` must remain separate branches in `$and`.

### U2. Adjacent Match Merging Hardening
- **Goal**: Harden `AdjacentMatchMergingPass` in `src/passes/adjacent-match-merging.ts` to fuse consecutive `$match` stages safely.
- **Requirements**: R5, R6, R7, R8
- **Files**:
  - `src/passes/adjacent-match-merging.ts`
  - `tests/adjacent-match-merging.test.ts`
- **Approach**:
  1. Inspect consecutive `$match` stages.
  2. Combine them into `{ $match: { $and: [ ...matches ] } }`.
  3. Apply `optimizeFilterWithContext` with the safe rule profile so nested `$and` arrays are flattened and duplicates removed.
  4. Ensure 100% branch coverage and Radixxko formatting.
- **Test Scenarios**:
  - Two adjacent matches: `[ { $match: { a: 1 } }, { $match: { b: 2 } } ]` $\rightarrow$ `[ { $match: { $and: [ { a: 1 }, { b: 2 } ] } } ]`.
  - Two identical matches: `[ { $match: { a: 1 } }, { $match: { a: 1 } } ]` $\rightarrow$ `[ { $match: { a: 1 } } ]`.
  - Adjacent match separated by `$sort` or `$project` does NOT merge across the boundary.

### U3. Register Passes in Production Pipeline Registry & Update Manifests
- **Goal**: Add `adjacent-match-merging` and `filter-optimization` to active pipeline transformations in `src/passes/registry.ts`, update `pre-gate-optimizer.ts`, and update proof manifests.
- **Requirements**: R1, R5, R8, R9
- **Files**:
  - `src/passes/registry.ts`
  - `tests/helpers/pre-gate-optimizer.ts`
  - `tests/fixtures/proof-manifest.ts`
  - `tests/registry-proof-manifest.test.ts`
- **Approach**:
  1. Add `adjacent-match-merging` and `filter-optimization` to `activePipelineTransformationIds` in `src/passes/registry.ts`.
  2. Update `tests/fixtures/proof-manifest.ts` marking `adjacent-match-merging`, `filter-optimization`, and the 5 active filter rules as `status: 'active'`.
  3. Update `tests/registry-proof-manifest.test.ts` expectations.
- **Test Scenarios**:
  - Proof manifest audit test passes for all active rules and passes.
  - Active transformation registry test verifies immutable registration order.

### U4. Integration Differential Verification on Live MongoDB 8
- **Goal**: Verify exact result equivalence across all 3 modes (`default`, `strictFieldOrder`, `strictErrors`) on live MongoDB 8.
- **Requirements**: R1, R4, R6, R7, R8
- **Files**:
  - `tests/fixtures/semantic-cases.ts`
  - `tests/fixtures/mixed-shape-cases.ts`
  - `tests/fixtures/random-pipelines.ts`
  - `vitest.config.ts`
- **Approach**:
  1. Add semantic test cases for adjacent match merging and recursive filter simplification with multikey arrays, nested documents, and nulls.
  2. Add mixed-shape differential test cases.
  3. Ensure 100% branch threshold in `vitest.config.ts`.
  4. Run `npm test` and `npm run test:integration` against MongoDB 8.
- **Test Scenarios**:
  - Multikey array differential: documents with `tags: [ 3, 12 ]` match `{ $and: [ { tags: { $gt: 5 } }, { tags: { $lt: 10 } } ] }` identically before and after optimization.
  - Real-world differential: `test.query` and `test.full.query` execute with 100% identical document streams.

### U5. Documentation Updates
- **Goal**: Document safe `$match` simplification and adjacent `$match` merging rules in `CONSTRAINTS.md`, `README.md`, and `SUPPORT.md`.
- **Requirements**: R6, R7, R8
- **Files**:
  - `CONSTRAINTS.md`
  - `README.md`
  - `SUPPORT.md`
- **Approach**:
  1. Document multikey array safety boundary: why `$and` branches are preserved rather than merged into single subdocuments.
  2. Document the 5 active safe filter rules and adjacent match merging.
  3. Update pass counts (22 active passes).
- **Test Scenarios**:
  - `npm run test:all` passes cleanly.

---

## Verification Contract

### Commands
- `npm run typecheck`: Must pass with 0 errors.
- `npm test`: All unit test suites pass (912+ tests).
- `npm run test:coverage`: 100% branch coverage threshold on all audited files.
- `npm run test:integration`: All differential tests pass on live MongoDB 8.
- `npm run build`: tsup builds CJS/ESM/DTS cleanly.

---

## Definition of Done

1. 5 provably safe filter normalization rules active in `src/filter-rule-registry.ts`.
2. `adjacent-match-merging` and `filter-optimization` active in `src/passes/registry.ts`.
3. Zero multikey condition merging bugs: multikey arrays verified in differential testing on MongoDB 8.
4. Proof manifests updated and passing in `tests/registry-proof-manifest.test.ts`.
5. 100% branch coverage on all modified/audited files.
6. Clean `npm run test:all`.
