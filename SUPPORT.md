# MongoDB Query & Aggregation Pipeline Support Matrix

This document provides a comprehensive reference of MongoDB aggregation pipeline stages, query filter operators, and expression operators supported by `@webergency-utils/mongodb-query-optimizer`.

---

## 1. Support Philosophy & Tiers

The optimizer employs a mathematically sound, lattice-based abstract interpretation engine. Operators and stages are categorized into three distinct support tiers:

| Tier | Classification | Description |
| :--- | :--- | :--- |
| **Tier 1** | **Active Transformation** | Actively rewritten, merged, reordered, pushed down, hoisted, or eliminated by specialized optimization passes. |
| **Tier 2** | **Deep Semantic Modeling** | Formally analyzed for field reads/writes, cardinality, ordering, provenance, determinism, and error behavior. Acts as a transparent or semi-transparent barrier that allows surrounding stages (such as `$match` or dead-assignment pruning) to safely commute across them, or recursively optimizes child subpipelines. |
| **Tier 3** | **Conservative Containment** | Unmodeled or external stages (e.g. `$merge`, `$out`, `$changeStream`, Atlas Search). Handled safely via the lattice "Top" (`conservativeTop`), acting as an impenetrable optimization boundary. Prevents unsafe rewrites without failing the query, allowing prefix and suffix windows to optimize freely. |

---

## 2. Aggregation Pipeline Stages (MongoDB 7.0 / 8.0)

Below is the complete list of all 49 MongoDB aggregation pipeline stages from the latest specification:

| Stage Operator | Support Tier | Optimization Passes / Analyzer Handling | Semantic Behavior & Rationale |
| :--- | :---: | :--- | :--- |
| `$addFields` | **Tier 1** | `match-pushdown`, `adjacent-add-field-merging`, `unused-field-pruning`, `dead-assignment-elimination`, `top-k-pushdown`, `add-field-pushdown` | Transparent: tracks field writes, merges adjacent stages, decomposes and hoists sort/match-dependent fields ahead of joins. |
| `$bucket` | **Tier 1** | `bucket-filter-pushdown` | Pushes boundary/prefilter conditions before partitioning. |
| `$bucketAuto` | **Tier 1** | `bucket-filter-pushdown` | Pushes boundary/prefilter conditions before automated bucketing. |
| `$changeStream` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Real-time event stream; acts as a strict execution barrier. |
| `$changeStreamSplitLargeEvent` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Stream fragment handler; acts as a strict execution barrier. |
| `$collStats` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Metadata inspection; preserved verbatim. |
| `$count` | **Tier 1** | `redundant-sort-elimination` | Eliminates preceding non-essential `$sort` stages; outputs a single scalar field. |
| `$currentOp` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Administrative diagnostic stage; preserved verbatim. |
| `$densify` | **Tier 2** | `analyzeDensifyStage` | Expands rows to fill date/numeric gaps; models field writes, ordering, and row expansion. |
| `$documents` | **Tier 2** | `analyzeDocumentsStage` | Introduces literal document streams; models input provenance and field dependencies. |
| `$facet` | **Tier 1** | `facet-prefix-hoisting`, recursive subpipeline sweep | Hoists common stage prefixes out of all branches and optimizes subpipelines independently. |
| `$fill` | **Tier 2** | `analyzeFillStage` | Populates missing or null values via linear interpolation or constant fill; tracks modified fields and order sensitivity. |
| `$geoNear` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Requires geospatial index at pipeline root; preserved verbatim. |
| `$graphLookup` | **Tier 2** | `analyzeGraphLookupStage` | Recursive graph traversal; models foreign collection provenance, array writes, and search depth. |
| `$group` | **Tier 1** | `group-filter-pushdown`, `redundant-sort-elimination`, `covered-projection-synthesis` | Pushes `_id` filters ahead of grouping; eliminates order-independent sorts; tracks accumulator dependencies. |
| `$indexStats` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Metadata inspection; preserved verbatim. |
| `$limit` | **Tier 1** | `limit-skip-coalescing`, `limit-advance`, `lookup-delay`, `top-k-pushdown` | Coalesces adjacent limits/skips; advances limits past order-preserving projections; hoists sort-limit slices before heavy 1:1 stages. |
| `$listClusterCatalog` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Cluster catalog inspection; preserved verbatim. |
| `$listLocalSessions` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Session inspection; preserved verbatim. |
| `$listSampledQueries` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Query sampling diagnostic; preserved verbatim. |
| `$listSearchIndexes` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Atlas Search index inspection; preserved verbatim. |
| `$listSessions` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Session metadata inspection; preserved verbatim. |
| `$lookup` | **Tier 1** | `lookup-delay`, `redundant-lookup-elimination`, subpipeline pushdown, recursive subpipeline sweep, `top-k-pushdown`, `add-field-pushdown` | Delays joins past filters/sorts; eliminates unused joins; splits mixed filters; pushes filters into subpipelines; hoists independent sort/limit slices and pre-computed fields before lookups. |
| `$match` | **Tier 1** | `expr-match-normalization`, `filter-optimization`, `adjacent-match-merging`, `match-pushdown`, `unwind-prefilter` | Central optimization engine: normalizes `$expr`, simplifies boolean algebra, merges matches, and pushes filters upstream. |
| `$merge` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Collection write side-effect; acts as a hard barrier to preserve write timing and ordering. |
| `$out` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Collection replacement side-effect; acts as a hard barrier to preserve write timing and ordering. |
| `$planCacheStats` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Query engine cache diagnostics; preserved verbatim. |
| `$project` | **Tier 1** | `adjacent-project-merging`, `sort-project-commute`, `complex-projection-deferral`, `unused-field-pruning`, `dead-assignment-elimination` | Reshapes documents: merges projections, eliminates unread fields, commutes safe sorts, and defers heavy expressions. |
| `$querySettings` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Query settings metadata; preserved verbatim. |
| `$queryStats` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Query performance statistics; preserved verbatim. |
| `$rankFusion` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Reciprocal rank fusion for search; preserved verbatim. |
| `$redact` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Dynamic recursive security-level filtering; acts as an opaque barrier. |
| `$replaceRoot` | **Tier 2** | `analyzeReplacementStage` | Replaces entire document root; models whole-document rewrite and path destruction. |
| `$replaceWith` | **Tier 2** | `analyzeReplacementStage` | Syntactic alias for `$replaceRoot: { newRoot: expr }`. |
| `$sample` | **Tier 2** | `analyzeSampleStage` | Random document selection; modeled as non-deterministic (`volatile`), preventing unsafe reordering across cardinality. |
| `$score` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Relevance scoring stage; preserved verbatim. |
| `$scoreFusion` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Hybrid search scoring fusion; preserved verbatim. |
| `$search` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Atlas Search query stage; must remain at pipeline root. |
| `$searchMeta` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Atlas Search metadata stage; must remain at pipeline root. |
| `$set` | **Tier 1** | `match-pushdown`, `adjacent-add-field-merging`, `unused-field-pruning`, `dead-assignment-elimination`, `top-k-pushdown`, `add-field-pushdown` | Syntactic alias for `$addFields`. |
| `$setWindowFields` | **Tier 2** | `analyzeWindowStage` | Analytical window computations; tracks partition keys, sort orders, and output field modifications. |
| `$shardedDataDistribution` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Cluster sharding diagnostics; preserved verbatim. |
| `$skip` | **Tier 1** | `limit-skip-coalescing`, `lookup-delay`, `top-k-pushdown` | Coalesces adjacent skips/limits; commutes past alias-independent joins; hoists sort-skip-limit slices. |
| `$sort` | **Tier 1** | `redundant-sort-elimination`, `sort-project-commute`, `match-pushdown`, `limit-advance`, `top-k-pushdown` | Commutes past filters and independent projections; eliminates overwritten or duplicate sorts; hoists Top-K slices before joins and computed fields. |
| `$sortByCount` | **Tier 1** | `sort-by-count-simplification` | Canonicalizes `$sortByCount: expr` into standard `$group` + `$sort` for downstream optimization. |
| `$unionWith` | **Tier 2** | Recursive subpipeline sweep | Inter-collection union; recursively optimizes inner pipelines and tracks multi-stream concatenation. |
| `$unset` | **Tier 1** | `match-pushdown`, `redundant-lookup-elimination`, `unused-field-pruning`, `top-k-pushdown` | Tracks field deletions; pushes disjoint filters backwards across field removals; hoists disjoint Top-K slices. |
| `$unwind` | **Tier 1** | `unwind-prefilter`, `match-pushdown` (disjoint), subpipeline pushdown | Synthesizes prefilters; moves disjoint filters across unwind; pushes array filters into subpipeline joins. |
| `$vectorSearch` | **Tier 3** | `conservativeTop` (Opaque Barrier) | Atlas Vector Search stage; must remain at pipeline root. |

---

## 3. Why Must the Optimizer Know About Operators?

An optimizer cannot safely treat expressions as black boxes. Knowing the exact semantics of every expression and filter operator is essential for four fundamental reasons:

### A. Field Dependency Extraction & Dead Code Elimination
To reorder or prune stages, the optimizer must compute the exact read-set of every expression:
- If `$project: { fullName: { $concat: ['$first', ' ', '$last'] } }` is analyzed, the optimizer knows it reads `first` and `last`.
- If an operator is unrecognized, the analyzer must conservatively assume it reads `'*'` (the entire document), which paralyzes stage movement and prevents dead-assignment elimination.

### B. Determinism & Volatility Isolation
Some operators yield different outputs across evaluations or depend on ambient cluster state:
- Non-deterministic operators (`$rand`, `$sampleRate`) and dynamic variables (`$$NOW`, `$$CLUSTER_TIME`) cannot be freely duplicated, deferred, or pushed across cardinality stages (like `$unwind`), as evaluating them $N$ times alters the query outcome.
- Pure operators (`$add`, `$concat`, `$toUpper`) can be safely precomputed, deduplicated, or commuted.

### C. Error Safety & Partial Functions
In MongoDB, some operators are **total** (never throw on unexpected types, e.g. `$eq`, `$and`, `$or`), whereas others are **partial / may-error** (e.g. `$divide` by zero, `$substr` on integers, `$arrayElemAt` on non-arrays):
- If a pipeline has `{ $match: { age: { $gt: 0 } } }, { $project: { ratio: { $divide: [100, '$age'] } } }`, pushing `$project` before `$match` would cause division-by-zero crashes on documents where `age == 0`!
- The analyzer tracks `errors: 'none-known' | 'may-error'` to prevent hoisting error-prone calculations past their protecting guard filters.

### D. Algebraic Simplification & Index Exploitation
- **Filter Normalization**: Expression forms like `$match: { $expr: { $eq: ['$status', 'active'] } }` prevent MongoDB from using multikey or single-field b-tree indexes. The optimizer transforms them into native index-friendly query filters (`$match: { status: 'active' }`).
- **Boolean Simplification**: Operators like `$and`, `$or`, `$not`, and `$in` undergo boolean reduction (De Morgan's laws, duplicate elimination, singleton absorption, and contradiction removal).

---

## 4. Query Filter Operators Matrix

These operators appear inside `$match` stages or standard `.find()` queries:

| Operator Category | Operators | Support Tier | Optimizer Action / Pass |
| :--- | :--- | :---: | :--- |
| **Logical** | `$and`, `$or`, `$nor`, `$not` | **Tier 1** | Flattened, deduplicated, simplified for identity values, merged via `filter-optimization`. |
| **Comparison** | `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin` | **Tier 1** | Simplified (single-item `$in` to `$eq`), normalized from `$expr`, pushed down across stages. |
| **Element & Array** | `$exists`, `$type`, `$size`, `$all`, `$elemMatch` | **Tier 1** | Analyzed for exact field dependencies; synthesized in `unwind-prefilter` and pushed in `lookup-delay`. |
| **Evaluation** | `$expr` | **Tier 1** | Deconstructed and normalized into native indexable query filters via `expr-match-normalization`. |
| **Regex** | `$regex`, `$options` | **Tier 2** | Validated for rewrite safety; preserved and pushed as field filters. |
| **Evaluation (Guarded)** | `$where`, `$text`, `$jsonSchema` | **Tier 2** | Modeled as whole-document dependencies; cannot commute past field modifications. |
| **Evaluation (Volatile)** | `$rand` | **Tier 2** | Modeled as non-deterministic (`volatile`); cannot commute across cardinality changes. |
| **Geospatial** | `$geoWithin`, `$geoIntersects`, `$near`, `$nearSphere`, `$box`, `$center`, `$centerSphere`, `$polygon`, `$maxDistance`, `$minDistance` | **Tier 2** | Field dependency tracked; pushed across independent passive stages. |
| **Bitwise** | `$bitsAllClear`, `$bitsAllSet`, `$bitsAnyClear`, `$bitsAnySet` | **Tier 2** | Field dependency tracked; pushed across independent passive stages. |
| **Metadata** | `$comment` | **Tier 2** | Preserved verbatim without blocking optimizations. |

---

## 5. Aggregation Expression Operators Matrix (115+ Operators)

Recognized and analyzed in `src/analyzer/expressions.ts`:

### A. Boolean & Logical Operators
| Operator | Support Tier | Semantics & Optimization |
| :--- | :---: | :--- |
| `$and`, `$or`, `$not` | **Tier 1** | Total function, deterministic. Normalized to native filter logic when inside `$expr`. |
| `$allElementsTrue`, `$anyElementTrue` | **Tier 2** | Set truth evaluation; deterministic, dependency tracked. |

### B. Comparison Operators
| Operator | Support Tier | Semantics & Optimization |
| :--- | :---: | :--- |
| `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$cmp` | **Tier 1** | Total function, deterministic. Normalized to query filter syntax when comparing path to literal. |

### C. Arithmetic Operators
| Operator | Support Tier | Semantics & Optimization |
| :--- | :---: | :--- |
| `$abs`, `$add`, `$ceil`, `$exp`, `$floor`, `$ln`, `$log`, `$log10`, `$multiply`, `$pow`, `$round`, `$sqrt`, `$subtract`, `$trunc` | **Tier 2** | Modeled with `errors: 'may-error'` on non-numeric inputs. Dependencies extracted. |
| `$divide`, `$mod` | **Tier 2** | Modeled with `errors: 'may-error'` (division-by-zero protection prevents unsafe hoist). |

### D. Trigonometric Operators
| Operator | Support Tier | Semantics & Optimization |
| :--- | :---: | :--- |
| `$acos`, `$acosh`, `$asin`, `$asinh`, `$atan`, `$atan2`, `$atanh`, `$cos`, `$cosh`, `$degreesToRadians`, `$radiansToDegrees`, `$sin`, `$sinh`, `$tan`, `$tanh` | **Tier 2** | Modeled: deterministic, numeric dependency tracked, potential type errors tracked. |

### E. Array Expression Operators
| Operator | Support Tier | Semantics & Optimization |
| :--- | :---: | :--- |
| `$arrayElemAt`, `$arrayToObject`, `$concatArrays`, `$first`, `$firstN`, `$in`, `$indexOfArray`, `$isArray`, `$last`, `$lastN`, `$maxN`, `$minN`, `$objectToArray`, `$range`, `$reverseArray`, `$size`, `$slice`, `$sortArray`, `$zip` | **Tier 2** | Deterministic array evaluation; dependencies tracked. |
| `$filter`, `$map`, `$reduce` | **Tier 1** | Scoped variable evaluation: creates isolated variable scopes (`$$this`, `$$value`), preventing outer variable shadowing collisions. |

### F. String Expression Operators
| Operator | Support Tier | Semantics & Optimization |
| :--- | :---: | :--- |
| `$concat`, `$indexOfBytes`, `$indexOfCP`, `$ltrim`, `$regexFind`, `$regexFindAll`, `$regexMatch`, `$replaceAll`, `$replaceOne`, `$rtrim`, `$split`, `$strcasecmp`, `$strLenBytes`, `$strLenCP`, `$substr`, `$substrBytes`, `$substrCP`, `$toLower`, `$toString`, `$toUpper`, `$trim` | **Tier 2** | Modeled: string path dependencies extracted, error behavior tracked for non-string operands. |

### G. Date Expression Operators
| Operator | Support Tier | Semantics & Optimization |
| :--- | :---: | :--- |
| `$dateAdd`, `$dateDiff`, `$dateFromParts`, `$dateFromString`, `$dateSubtract`, `$dateToParts`, `$dateToString`, `$dateTrunc`, `$dayOfMonth`, `$dayOfWeek`, `$dayOfYear`, `$hour`, `$isoDayOfWeek`, `$isoWeek`, `$isoWeekYear`, `$millisecond`, `$minute`, `$month`, `$second`, `$week`, `$year` | **Tier 2** | Modeled: date dependencies extracted, formatting errors tracked. |

### H. Conditional Expression Operators
| Operator | Support Tier | Semantics & Optimization |
| :--- | :---: | :--- |
| `$cond`, `$switch` | **Tier 2** | Branch-aware dependency tracking; preserves guarded evaluation. |
| `$ifNull` | **Tier 1** | Total function, null-coalescing. Analyzed for null-rejection in group pushdown proofs. |

### I. Object & Field Operators
| Operator | Support Tier | Semantics & Optimization |
| :--- | :---: | :--- |
| `$getField`, `$setField`, `$unsetField` | **Tier 1** | Precise dynamic path analysis: extracts literal path arguments to resolve field mutations and dependencies. |
| `$mergeObjects` | **Tier 2** | Object composition; tracks multi-object dependencies and shallow field overwrites. |

### J. Type Conversion & Type Inspection Operators
| Operator | Support Tier | Semantics & Optimization |
| :--- | :---: | :--- |
| `$convert`, `$isNumber`, `$toBool`, `$toDate`, `$toDecimal`, `$toDouble`, `$toInt`, `$toLong`, `$toObjectId`, `$toString`, `$type` | **Tier 2** | Modeled: type dependencies tracked, error-handling attributes (`onError`, `onNull`) tracked. |

### K. Group & Window Accumulator Operators
| Operator | Support Tier | Semantics & Optimization |
| :--- | :---: | :--- |
| `$avg`, `$count`, `$first`, `$last`, `$max`, `$min`, `$mergeObjects`, `$push`, `$addToSet`, `$stdDevPop`, `$stdDevSamp`, `$sum`, `$top`, `$bottom`, `$topN`, `$bottomN`, `$firstN`, `$lastN`, `$maxN`, `$minN`, `$median`, `$percentile` | **Tier 1** | Analyzed inside `$group` and `$setWindowFields`. Tracks field dependencies and order-sensitivity (e.g. `$first` / `$last` retain preceding sorts, whereas `$sum` / `$avg` render preceding sorts redundant). |

### L. Window-Specific Analytical Operators
| Operator | Support Tier | Semantics & Optimization |
| :--- | :---: | :--- |
| `$denseRank`, `$documentNumber`, `$expMovingAvg`, `$integral`, `$linearFill`, `$locf`, `$rank`, `$shift`, `$derivative` | **Tier 2** | Evaluated within `$setWindowFields`; order-dependent across partition windows. |

### M. User-Defined Code & Escape Hatches
| Operator | Support Tier | Semantics & Optimization |
| :--- | :---: | :--- |
| `$function`, `$accumulator` | **Tier 2** | Custom JavaScript execution. Explicitly marked as **non-deterministic (`volatile`)** and **error-possible (`may-error`)**. Arguments passed in `args` are strictly extracted as dependencies; prevents unsafe stage reordering or dead-code elimination. |

---

## 6. Variables & Execution Scopes

The optimizer tracks document and execution scopes to prevent name collisions and variable leakage:

| Variable | Scope Type | Optimizer Treatment |
| :--- | :--- | :--- |
| `$$ROOT`, `$$CURRENT` | Document Scope | Modeled as full document read (`*`); acts as an immovable barrier for field pruning. |
| `$$NOW`, `$$CLUSTER_TIME` | Cluster / Ambient | Modeled as ambient runtime dependencies; safe to evaluate but not foldable to static constants. |
| `$$DESCEND`, `$$PRUNE`, `$$KEEP` | Redact Flow | System control flags for `$redact`. |
| `$$REMOVE` | Field Deletion | Analyzed in projection expressions as field unsetting. |
| `$$SEARCH_META` | Search Metadata | Read-only metadata introduced by Atlas Search. |
| User Variables (`$$var`) | Scoped (`$let`, `$map`, etc.) | Isolated into lexical scopes in `ScopedDependencies.variables`; does not collide with document field paths. |
