# Constraints

These constraints bound what `optimizeFilter` and `optimizePipeline` may change.

## Lookup execution

`$lookup` cannot fail.

Missing `from`, authorization failures, BSON size limits, and other join execution errors are out of scope. If a lookup does fail, that failed execution is a different result from a successful pipeline. The optimizer therefore does not preserve lookup error occurrence or timing.

Under this constraint, a simple equality `$lookup` may move past an adjacent `$match`, `$sort`, `$limit`, or `$skip` that does not read, write, modify, or remove the lookup alias.

A no-failure constraint on other stages would waive error occurrence, error text, and error timing the same way. That still does not license generic pipeline reordering.

## Generic reordering

Stages do not have a global safe order.

Assuming stages do not fail, or treating a failure as a different result, only removes error-observability obligations. Adjacent swaps must still preserve the successful document stream: membership, multiplicity, field presence, field values, and observable order.

Generic priority reordering fails that obligation. The same `$addFields` then `$unset` leaks `transient` if swapped. `$addFields` then an inclusion `$project` keeps a computed field that the original pipeline dropped. `$lookup` then `$project: { name: 1 }` drops the alias if delayed, or drops the join key if the project moves first. `$unwind` or `$group` next to `$limit` changes which rows exist. `$sort` then `$project` can change order when the sort key is not kept.

Those are successful-result differences, not a different error for the same pipeline. A preferred stage list, priority bubble, or `canSwap` heuristic is not a proof of that.

Enabled pair-specific rewrites that preserve successful results:

- Dead `$addFields` / `$set` writes killed by a later `$unset`, overwrite, or simple `$project` when every stage in between does not observe those writes. A read of the write, an exclusion `$project` (it depends on `*`), `$$ROOT` / `$$CURRENT`, `$facet` / `$lookup`, and unknown stages still block.
- Simple equality `$lookup` removed when the next stage discards the alias
- `$sort` then simple `$project` swapped when every sort key stays visible
- Deterministic `$addFields` / `$set` delayed past `$sort` when the sort keys do not overlap the writes

`$unwind` or `$group` next to `$limit` still cannot move: they change which rows exist. Generic `stage-priority-reorder` stays contained.
