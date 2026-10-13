---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Feature: Abstract Query Identifier and Variable Name Preservation

## Goal Capsule

- **Objective:** Preserve MongoDB variable bindings and schema field references verbatim in `toAbstractQuery` and `formatAbstractQuery`, preventing variable names and schema definitions from being masked as `<string>`.
- **Product Authority:** `radixxko` (@webergency-utils/mongodb-query-optimizer)
- **Open Blockers:** None

## Product Contract

> **Product Contract preservation:** Product Contract unchanged from brainstorm.

### Summary

Refine the abstract query generator (`toAbstractQuery`) and pretty-printer (`formatAbstractQuery`) so that variable binding identifiers (such as `"as"` in `$map`, `$filter`, `$lookup`, `$graphLookup`, and `"includeArrayIndex"` in `$unwind`) and schema field references (such as field lists in `$unset` and `"field"` in `$getField`/`$setField`) are preserved verbatim as JSON string literals rather than being replaced with `<string>`.

### Problem Frame

When abstracting MongoDB queries for query performance classification and shape indexing, concrete runtime values (like `"dropout"`, `123`, `ISODate(...)`) must be stripped and replaced by type tokens (`<string>`, `<number>`, `<Date>`). 

However, in expressions like `$map: { input: "$contracts", as: "contract", in: "$$contract.status" }`, the string `"contract"` is an identifier variable binding, not arbitrary data. Converting it to `"as": <string>` breaks correlation with the downstream expression `"$$contract.status"`. Similarly, `$unset: ["statuses"]` defines document schema operations (dropping specific fields), where abstracting to `[<string>]` discards vital structural information about which schema fields are removed.

### Key Decisions

- **KD1 (Variable binding preservation):** Strings declaring variable names in `$map.as`, `$filter.as`, `$lookup.as`, `$graphLookup.as`, and `$unwind.includeArrayIndex` must be preserved verbatim.
  *(session-settled: user-directed — chosen over abstracting to `<string>`: user identified that variable bindings must remain concrete to match expressions like `$$contract.status`)*. Governs R1, R2, R3.
- **KD2 (Schema field list preservation):** Field paths in `$unset` (both single string and string array forms) and `"field"` properties in `$getField`, `$setField`, and `$unsetField` represent schema field names, not runtime data, and must be preserved verbatim.
  *(session-settled: user-approved — chosen over abstracting all string arguments: keeps schema field definitions intact while preserving data abstraction)*. Governs R4, R6, R7.
- **KD3 (Deterministic sorting for `$unset` arrays):** Arrays of field names in `$unset` must be sorted alphabetically to guarantee canonical shape equality regardless of input order. Governs R5.
- **KD4 (Runtime data values remain `<string>`):** Literal strings in equality comparisons, `$match` filters, `$switch.then`, `$switch.default`, and collection names (`from`, `coll`) remain abstracted to `<string>`. Governs R8.

### Requirements

#### Variable Bindings

- R1. The generator MUST preserve string values assigned to `"as"` in `$map` and `$filter` expressions verbatim as JSON string literals.
- R2. The generator MUST preserve string values assigned to `"as"` in `$lookup` and `$graphLookup` stages verbatim as JSON string literals.
- R3. The generator MUST preserve string values assigned to `"includeArrayIndex"` in `$unwind` stages verbatim as JSON string literals.

#### Schema Field References

- R4. The generator MUST preserve field path strings in `$unset` stages verbatim, whether specified as a single string or an array of strings.
- R5. The generator MUST sort field names alphabetically when `$unset` specifies an array of field names.
- R6. The generator MUST preserve string values assigned to `"field"` in `$getField`, `$setField`, and `$unsetField` expressions verbatim as JSON string literals.
- R7. The generator MUST preserve string values in `"field"` and `"partitionByFields"` properties in `$densify` and `$fill` stages verbatim.

#### Formatter & Integration

- R8. The formatter `formatAbstractQuery` MUST format preserved identifier string literals verbatim with proper JSON string quotes and indentation in both `'allman'` and `'same-line'` modes.

### Scope Boundaries

- **In Scope:**
  - Preserving variable bindings: `$map.as`, `$filter.as`, `$lookup.as`, `$graphLookup.as`, `$unwind.includeArrayIndex`.
  - Preserving schema field references: `$unset` field paths, `$getField.field`, `$setField.field`, `$unsetField.field`, `$densify.field`/`partitionByFields`, `$fill.field`/`partitionByFields`.
  - Canonical alphabetical sorting of `$unset` field arrays.
  - Multi-style formatting support for preserved identifiers.
- **Out of Scope:**
  - Collection names in `$lookup.from`, `$unionWith.coll`, `$out`, and `$merge` (remain abstracted to `<string>`).
  - Literal data values in comparisons or stage payloads (remain abstracted to `<string>`).
  - Modification of optimizer rewrite passes or rule manifests.

### Key Flows

- F1. Variable correlation in expressions:
  - **Trigger:** Pipeline contains a `$map` or `$filter` with variable binding `"as": "contract"` referenced downstream as `"$$contract.status"`.
  - **Steps:** `toAbstractQuery` identifies `"as"` within `$map`/`$filter` context; preserves `"contract"` verbatim; preserves `"$$contract.status"` verbatim.
  - **Outcome:** The generated shape retains the variable name binding intact: `{"$map":{"as":"contract","in":"$$contract.status",...}}`.
  - **Covers:** R1, R8.

- F2. Schema field exclusion in `$unset`:
  - **Trigger:** Pipeline drops fields via `$unset: ["statuses", "temp"]` or `$unset: "statuses"`.
  - **Steps:** `toAbstractQuery` identifies `$unset` stage; preserves field names verbatim; sorts array elements alphabetically.
  - **Outcome:** Canonical shape outputs `{"$unset":["statuses","temp"]}` or `{"$unset":"statuses"}`.
  - **Covers:** R4, R5, R8.

### Acceptance Examples

- AE1. Array mapping variable preservation:
  - **Given:** `{ $map: { input: "$contracts", as: "contract", in: "$$contract.status" } }`
  - **When:** `toAbstractQuery` is called.
  - **Then:** Shape is `{"$map":{"as":"contract","in":"$$contract.status","input":"$contracts"}}`.
  - **Covers:** R1.

- AE2. Array filtering variable preservation:
  - **Given:** `{ $filter: { input: "$items", as: "item", cond: { $gt: ["$$item.price", 100] } } }`
  - **When:** `toAbstractQuery` is called.
  - **Then:** Shape is `{"$filter":{"as":"item","cond":{"$gt":["$$item.price",<number>]},"input":"$items"}}`.
  - **Covers:** R1.

- AE3. Lookup and Unwind alias preservation:
  - **Given:** `[{ $lookup: { from: "users", as: "user", pipeline: [] } }, { $unwind: { path: "$user", includeArrayIndex: "userIndex" } }]`
  - **When:** `toAbstractQuery` is called.
  - **Then:** Shape is `[{"$lookup":{"as":"user","from":<string>,"pipeline":[]}},{"$unwind":{"includeArrayIndex":"userIndex","path":"$user"}}]`.
  - **Covers:** R2, R3.

- AE4. Unset field list preservation and canonical sorting:
  - **Given:** `{ $unset: ["temp", "statuses"] }`
  - **When:** `toAbstractQuery` is called.
  - **Then:** Shape is `{"$unset":["statuses","temp"]}`.
  - **Covers:** R4, R5.

- AE5. Dynamic field access operators:
  - **Given:** `{ $getField: { field: "zip", input: "$address" } }`
  - **When:** `toAbstractQuery` is called.
  - **Then:** Shape is `{"$getField":{"field":"zip","input":"$address"}}`.
  - **Covers:** R6.

### Outstanding Questions

None. All product questions were settled during Phase 1.3 collaborative dialogue.

---

## Planning Contract

### Technical Context

- **Source Location:** `src/abstract-query.ts` manages AST traversal, abstraction rules, tokenization, and pretty-printing.
- **Lexical Context:** `toAbstractQueryInternal` takes `(query: unknown, context: AbstractionContext = {})`. Currently, `AbstractionContext` only tracks `isExpression?: boolean` and `inPipeline?: boolean`.
- **String Handling:** Currently, line 199 in `src/abstract-query.ts` checks:
  ```typescript
  if( typeof query === 'string' )
  {
      if( context.isExpression && query.startsWith( '$' ))
      {
          return JSON.stringify( query );
      }
      return '<string>';
  }
  ```
  Any non-`$` string in an expression or query defaults to `'<string>'`.
- **Formatting AST:** The tokenizer recognizes quotes (`"..."`) and emits `{ type: 'LITERAL', value: str }`. The AST parser treats string literals as `kind: 'literal'`, and `formatAst` outputs `node.value`. Scalar arrays consisting solely of literals are formatted inline (`[<el>, <el>]`), while object properties and multi-line structures are formatted with configurable indentation.

### Key Technical Decisions

- **KTD1 (Context-driven Identifier Flag):** Expand `AbstractionContext` to include `isIdentifier?: boolean`, `parentOperator?: string`, and `parentStage?: string`.
  - When `context.isIdentifier` is true, strings are serialized via `JSON.stringify(query)` rather than converted to `<string>`.
  - *Rationale:* Keeps `toAbstractQueryInternal` purely functional and recursive without global mutable state. Governs U1.
- **KTD2 (Parent-Key Contextual Dispatch):** During object property traversal:
  - If parent key is `$unset`: mark child context with `isIdentifier: true`. When child is an array of strings, sort alphabetically before formatting.
  - If child key is `'as'` inside `$map`, `$filter`, `$lookup`, or `$graphLookup`: mark child context with `isIdentifier: true`.
  - If child key is `'includeArrayIndex'` inside `$unwind`: mark child context with `isIdentifier: true`.
  - If child key is `'field'` inside `$getField`, `$setField`, `$unsetField`, or `$densify`: mark child context with `isIdentifier: true`.
  - If child key is `'partitionByFields'` inside `$densify` or `$fill`: mark child context with `isIdentifier: true`.
  - *Rationale:* Directly implements R1–R7 with zero performance overhead and deterministic behavior. Governs U1, U2.

### High-Level Technical Design

```
                     toAbstractQuery(query)
                               │
               toAbstractQueryInternal(query, context)
                               │
              ┌────────────────┴────────────────┐
              ▼                                 ▼
         Type: Object                      Type: String
              │                                 │
   Is key an identifier field?         Is context.isIdentifier?
   (as, includeArrayIndex,             Or (isExpression && startsWith('$'))?
    $unset, field, etc.)                        │
              │                                ┌┴───────────────┐
              ▼                                ▼                ▼
    Set isIdentifier: true               JSON.stringify()    '<string>'
    Recursive child traversal
```

### Risk Management & Failure Modes

- **Risk 1: Accidental over-preservation of literal strings.** If `isIdentifier` leaks into sub-expressions (e.g. `in:` within `$map` or `cond:` within `$filter`), concrete data values might not be abstracted.
  - *Mitigation:* `isIdentifier` is scoped strictly to the immediate leaf value of the identifier property; complex nested sub-expressions (`in`, `cond`, `pipeline`) reset `isIdentifier: false`.
- **Risk 2: Breaking existing tests or query shape equivalence.** Existing tests for `$lookup` or `$unwind` without `as` or with default behavior must remain fully compatible.
  - *Mitigation:* Run the full 42-file test suite (968 tests) before and after changes.

### Assumptions

- Field names in `$unset` are always valid BSON string path representations or arrays of strings. Non-string array elements in `$unset` fallback to standard recursive abstraction.

---

## Implementation Units

### U1. Contextual Lexical Analysis & Identifier Preservation in toAbstractQuery

- **Goal:** Update `AbstractionContext` and object/array traversal in `toAbstractQueryInternal` to preserve variable bindings and schema field references.
- **Requirements:** R1, R2, R3, R4, R5, R6, R7
- **Dependencies:** None
- **Files:** `src/abstract-query.ts`
- **Approach:**
  1. Add `isIdentifier?: boolean`, `parentOperator?: string`, and `parentKey?: string` to `AbstractionContext`.
  2. In `toAbstractQueryInternal` string handling:
     ```typescript
     if( typeof query === 'string' )
     {
         if( context.isIdentifier || ( context.isExpression && query.startsWith( '$' )))
         {
             return JSON.stringify( query );
         }
         return '<string>';
     }
     ```
  3. In object traversal, check the property key and current parent context:
     - When `key === '$unset'`:
       - If `val` is a string: serialize with `{ ...childContext, isIdentifier: true }`.
       - If `val` is an array: map each element with `isIdentifier: true` and sort alphabetically: `elements.sort((a,b) => a.localeCompare(b))`.
     - When `key === 'as'` and parent operator/stage is `$map`, `$filter`, `$lookup`, or `$graphLookup`:
       `childContext = { ...childContext, isIdentifier: true };`
     - When `key === 'includeArrayIndex'` and parent stage is `$unwind`:
       `childContext = { ...childContext, isIdentifier: true };`
     - When `key === 'field'` and parent operator is `$getField`, `$setField`, `$unsetField`, or `$densify`:
       `childContext = { ...childContext, isIdentifier: true };`
     - When `key === 'partitionByFields'` and parent operator is `$densify` or `$fill`:
       `childContext = { ...childContext, isIdentifier: true };`
  4. Ensure recursive scopes for expression bodies (`in`, `cond`, `pipeline`) explicitly reset `isIdentifier: false`.
- **Test Scenarios:**
  - Covers AE1: `{ $map: { input: "$contracts", as: "contract", in: "$$contract.status" } }` preserves `"as": "contract"` and `"in": "$$contract.status"`.
  - Covers AE2: `{ $filter: { input: "$items", as: "item", cond: { $gt: ["$$item.price", 100] } } }` preserves `"as": "item"`.
  - Covers AE3: `{ $lookup: { from: "users", as: "user", pipeline: [] } }` preserves `"as": "user"` while abstracting `from: <string>`.
  - Covers AE3: `{ $unwind: { path: "$user", includeArrayIndex: "userIndex" } }` preserves `"includeArrayIndex": "userIndex"`.
  - Covers AE4: `{ $unset: ["temp", "statuses"] }` yields sorted `{"$unset":["statuses","temp"]}`.
  - Covers AE5: `{ $getField: { field: "zip", input: "$address" } }` preserves `"field": "zip"`.

### U2. AST Pretty-Printer Support for Identifier Literals

- **Goal:** Verify and ensure that `formatAbstractQuery` formats preserved identifier string literals verbatim in both `'allman'` and `'same-line'` styles with correct indentation.
- **Requirements:** R8
- **Dependencies:** U1
- **Files:** `src/abstract-query.ts`
- **Approach:**
  1. Inspect tokenizer and AST parser in `src/abstract-query.ts`. Confirm that double-quoted string literals in both object property values and array elements are correctly emitted as AST `literal` nodes.
  2. Verify that scalar arrays of string identifiers (such as `["statuses", "temp"]`) format inline: `["statuses", "temp"]`.
  3. Verify that Allman and same-line formatting rules format multi-line structures containing preserved identifiers cleanly without token leakage.
- **Test Scenarios:**
  - Formats `$map` expression in Allman style with `"as": "contract"`.
  - Formats `$unset` stage with array of field strings in same-line style with custom tab size.

### U3. Test Suite Expansion & Full Regression Verification

- **Goal:** Add comprehensive tests covering all new identifier preservation behaviors and verify zero regressions across the entire project test suite.
- **Requirements:** R1–R8
- **Dependencies:** U1, U2
- **Files:** `tests/abstract-query.test.ts`
- **Approach:**
  1. Add tests in `tests/abstract-query.test.ts` for:
     - `$map` and `$filter` variable bindings.
     - `$lookup` and `$graphLookup` `as` fields.
     - `$unwind` with `includeArrayIndex`.
     - `$unset` with single string and multiple unsorted strings.
     - `$getField`, `$setField`, `$unsetField`.
     - Full complex aggregation pipeline from real-world query with `$map`, `$switch`, `$group`, `$sortArray`, and `$unset`.
  2. Run `npm run typecheck`, `npm test`, and `npm run build`.
- **Test Scenarios:**
  - The complete user-provided aggregation pipeline produces:
    - `"as": "contract"` (preserved)
    - `"in": "$$contract.status"` (preserved)
    - `"$unset": ["statuses"]` (preserved)
    - All other runtime data strings abstracted to `<string>`
    - All dates abstracted to `<Date>`
  - Zero test failures across all 42 test suites.

---

## Verification Contract

### Automated Verification

```bash
# 1. Typecheck source and test files
npm run typecheck

# 2. Run dedicated abstract-query unit tests
npx vitest run tests/abstract-query.test.ts

# 3. Run full project test suite
npm test

# 4. Verify build and type definitions
npm run build
```

---

## Definition of Done

1. `toAbstractQuery` preserves variable names (`as`, `includeArrayIndex`) and schema field references (`$unset`, `$getField`, etc.) as quoted JSON strings.
2. Literal values in comparisons, filters, and collection names remain properly abstracted to `<string>`.
3. Array elements in `$unset` are sorted alphabetically for canonical shape consistency.
4. `formatAbstractQuery` formats preserved identifiers cleanly in both Allman and same-line styles.
5. All automated tests in `tests/abstract-query.test.ts` and the full regression test suite pass with 0 errors.
