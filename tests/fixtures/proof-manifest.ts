import type { FilterRuleId } from '../../src/filter-rule-registry.js';
import type {
    PipelineTransformationId,
} from '../../src/passes/registry.js';

export type StrictModeBehavior = 'preserved' | 'constrained' | 'skipped';

export interface GateMixedShapeCaseIds
{
    readonly default: string;
    readonly strictFieldOrder: string;
    readonly strictErrors: string;
}

export interface GateRecord
{
    readonly status: 'active' | 'inactive';
    readonly proofRecheckNote?: string;
    readonly mixedShapeCaseIds?: GateMixedShapeCaseIds;
    readonly strictModeBehavior?: StrictModeBehavior;
    readonly reason?: string;
}

export interface TransformationProofEvidence<Id extends string>
{
    readonly transformationId: Id;
    readonly focused: readonly string[];
    readonly interaction: readonly string[];
    readonly nested: readonly string[];
    readonly mongodbFixtures: readonly string[];
    readonly gate: GateRecord;
}

export function validateGateRecord( entry: TransformationProofEvidence<string> ): void
{
    if( !entry.gate )
    {
        throw new Error( `Transformation ${entry.transformationId} lacks a gate record` );
    }

    if( entry.gate.status === 'active' )
    {
        if( !entry.gate.proofRecheckNote || entry.gate.proofRecheckNote.trim().length === 0 )
        {
            throw new Error( `Active transformation ${entry.transformationId} lacks a proofRecheckNote` );
        }

        if(
            !entry.gate.mixedShapeCaseIds
            || !entry.gate.mixedShapeCaseIds.default
            || !entry.gate.mixedShapeCaseIds.strictFieldOrder
            || !entry.gate.mixedShapeCaseIds.strictErrors
        )
        {
            throw new Error( `Active transformation ${entry.transformationId} lacks complete mixedShapeCaseIds` );
        }

        if(
            !entry.gate.strictModeBehavior
            || ![ 'preserved', 'constrained', 'skipped' ].includes( entry.gate.strictModeBehavior )
        )
        {
            throw new Error( `Active transformation ${entry.transformationId} lacks valid strictModeBehavior` );
        }
    }
}

function evidence<Id extends string>(
    transformationId: Id,
    focused: string,
    interaction: string,
    nested: string,
    mongodbFixture: string,
    gate: GateRecord = Object.freeze( { status: 'inactive', reason: 'inactive, pending audit' } ),
): TransformationProofEvidence<Id>
{
    return Object.freeze({
        transformationId,
        focused: Object.freeze([focused]),
        interaction: Object.freeze([interaction]),
        nested: Object.freeze([nested]),
        mongodbFixtures: Object.freeze([mongodbFixture]),
        gate: Object.freeze(gate),
    });
}

export const filterProofManifest: readonly TransformationProofEvidence<FilterRuleId>[] = Object.freeze([
    evidence(
        'simplify-equality',
        'filter-explicit-regex-equality-contained',
        'u9-generated-top-level-filter-optimization',
        'u9-generated-nested-filter-optimization',
        'u4-pipeline-top-level-filter-rules',
        {
            status: 'inactive',
            reason: 'Implicit equality matches array elements where explicit BSON equality does not; inactive pending exhaustive polymorphic array traversal proofs.'
        }
    ),
    evidence(
        'simplify-singleton-in',
        'u4-filter-singleton-in-exotic-values',
        'u9-generated-top-level-adjacent-match-merging',
        'u9-generated-nested-adjacent-match-merging',
        'u4-pipeline-nested-lookup-filters',
        {
            status: 'inactive',
            reason: 'Singleton $in with regex or nested arrays has distinct BSON regex and multikey semantics compared to implicit equality; inactive pending multikey safety proofs.'
        }
    ),
    evidence(
        'flatten-conjunctions',
        'u4-filter-valid-logical-flattening',
        'u9-generated-top-level-limit-skip-coalescing',
        'u9-generated-nested-limit-skip-coalescing',
        'u4-filter-invalid-empty-and',
        {
            status: 'inactive',
            reason: 'Flattening $and conjunctions alters evaluation order and short-circuit error semantics under strictErrors; inactive pending error containment proof.'
        }
    ),
    evidence(
        'flatten-disjunctions',
        'u4-filter-invalid-empty-or',
        'u9-generated-top-level-match-pushdown',
        'u9-generated-nested-match-pushdown',
        'u4-filter-invalid-empty-or',
        {
            status: 'inactive',
            reason: 'Flattening $or disjunctions alters index planner candidate selection and branch short-circuit evaluation order under strictErrors; inactive pending index-awareness audit.'
        }
    ),
    evidence(
        'simplify-conjunction-identities',
        'u4-filter-invalid-empty-and',
        'u9-generated-top-level-limit-advance',
        'u9-generated-nested-limit-advance',
        'u4-filter-invalid-empty-and',
        {
            status: 'inactive',
            reason: 'Dropping empty or contradictory conjunctions drops clauses that may contain un-evaluated error-prone expressions under strictErrors; inactive pending error guard integration.'
        }
    ),
    evidence(
        'simplify-disjunction-identities',
        'filter-match-all-or-contained',
        'u9-generated-top-level-unused-field-pruning',
        'u9-generated-nested-unused-field-pruning',
        'u4-filter-match-all-or-with-sibling',
        {
            status: 'inactive',
            reason: 'Removing contradictory disjunction branches can suppress execution errors under strictErrors when other branches fail to match; inactive pending error containment proof.'
        }
    ),
    evidence(
        'deduplicate-conjunctions',
        'u4-filter-distinct-regex-conjunction',
        'u9-generated-top-level-adjacent-project-merging',
        'u9-generated-nested-adjacent-project-merging',
        'u4-filter-multikey-embedded-document-order',
        {
            status: 'inactive',
            reason: 'Deduplicating conjunction expressions suppresses duplicate error-prone expressions under strictErrors; inactive pending error safety proof.'
        }
    ),
    evidence(
        'merge-conjunctions',
        'filter-logical-field-order-contained',
        'u9-generated-top-level-adjacent-add-field-merging',
        'u9-generated-nested-adjacent-add-field-merging',
        'u4-pipeline-adjacent-multikey-matches',
        {
            status: 'inactive',
            reason: 'Merging conjunctions into root object alters document field order and multikey duplicate path semantics; inactive pending field-order and multikey proof.'
        }
    ),
]);

export const pipelineProofManifest: readonly TransformationProofEvidence<PipelineTransformationId>[] = Object.freeze([
    evidence(
        'expr-match-normalization',
        'feat-expr-match-normalization-focused',
        'u9-generated-top-level-expr-match-normalization',
        'u9-generated-nested-expr-match-normalization',
        'feat-expr-match-normalization-oracle',
        {
            status: 'inactive',
            reason: '$expr equality compares array values as discrete types, whereas MQL equality automatically traverses array elements; rewriting to MQL expands result sets on polymorphic data.'
        }
    ),
    evidence(
        'filter-optimization',
        'u4-pipeline-top-level-filter-rules',
        'u9-generated-top-level-filter-optimization',
        'u9-generated-nested-filter-optimization',
        'pipeline-invalid-empty-logical-array-contained',
        {
            status: 'inactive',
            reason: 'Filter optimization pass delegates to the filter rule registry; inactive pending standalone filter rule gating across mixed-shape pipelines.'
        }
    ),
    evidence(
        'adjacent-match-merging',
        'u4-pipeline-adjacent-multikey-matches',
        'u9-generated-top-level-adjacent-match-merging',
        'u9-generated-nested-adjacent-match-merging',
        'u4-pipeline-nested-facet-filters',
        {
            status: 'inactive',
            reason: 'Merging adjacent $match stages across multikey or dotted paths alters array element independent matching semantics; blocked by multikey traversal safety.'
        }
    ),
    evidence(
        'group-filter-pushdown',
        'feat-group-filter-pushdown-focused',
        'u9-generated-top-level-group-filter-pushdown',
        'u9-generated-nested-group-filter-pushdown',
        'feat-group-filter-pushdown-oracle',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: pushes ID prefilters before group; preserves null/array group semantics in MQL; restricts computed ID pushdown to null-rejecting string ops; constrained under strictErrors when group stage may error.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-group-filter-pushdown',
                strictFieldOrder: 'mixed-shape-group-filter-pushdown',
                strictErrors: 'mixed-shape-group-filter-pushdown'
            },
            strictModeBehavior: 'constrained'
        }
    ),
    evidence(
        'bucket-filter-pushdown',
        'feat-bucket-filter-pushdown-focused',
        'u9-generated-top-level-bucket-filter-pushdown',
        'u9-generated-nested-bucket-filter-pushdown',
        'feat-bucket-filter-pushdown-oracle',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: converts _id bucket equality/in conditions into $gte/$lt range prefilters; validates boundaries monotonicity and primitive types; constrained under strictErrors when bucket stage lacks default.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-bucket-filter-pushdown',
                strictFieldOrder: 'mixed-shape-bucket-filter-pushdown',
                strictErrors: 'mixed-shape-bucket-filter-pushdown'
            },
            strictModeBehavior: 'constrained'
        }
    ),
    evidence(
        'unwind-prefilter',
        'feat-unwind-prefilter-focused',
        'u9-generated-top-level-unwind-prefilter',
        'u9-generated-nested-unwind-prefilter',
        'feat-unwind-prefilter-oracle',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: shape-tolerant superset prefilter avoiding $elemMatch on unwound root; dotted path handles objects and scalar arrays; escape branch covers nested arrays; qualifying predicates forbid missing/null matches; preserved across strict modes for error-free stages.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-ae3-object-unwind',
                strictFieldOrder: 'mixed-shape-ae3-object-unwind',
                strictErrors: 'mixed-shape-ae4-scalar-array-exists'
            },
            strictModeBehavior: 'preserved'
        }
    ),
    evidence(
        'redundant-sort-elimination',
        'feat-redundant-sort-elimination-focused',
        'u9-generated-top-level-redundant-sort-elimination',
        'u9-generated-nested-redundant-sort-elimination',
        'feat-redundant-sort-elimination-oracle',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: eliminates redundant sorts before adjacent sort, order-agnostic group, count, and sortByCount; preserves BSON comparison order across polymorphic types and arrays; preserved across strict modes as sort is error-free.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-redundant-sort-elimination',
                strictFieldOrder: 'mixed-shape-redundant-sort-elimination',
                strictErrors: 'mixed-shape-redundant-sort-elimination'
            },
            strictModeBehavior: 'preserved'
        }
    ),
    evidence(
        'sort-by-count-simplification',
        'feat-sort-by-count-simplification-focused',
        'u9-generated-top-level-sort-by-count-simplification',
        'u9-generated-nested-sort-by-count-simplification',
        'feat-sort-by-count-simplification-oracle',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: collapses exact pattern { $group: { _id: expr, count: { $sum: 1 } } }, { $sort: { count: -1 } } to native MongoDB $sortByCount alias. Preserves exact field order (_id, count) and error characteristics across all types.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-sort-by-count-simplification',
                strictFieldOrder: 'mixed-shape-sort-by-count-simplification',
                strictErrors: 'mixed-shape-sort-by-count-simplification'
            },
            strictModeBehavior: 'preserved'
        }
    ),
    evidence(
        'limit-skip-coalescing',
        'u9-limit-skip-safe-top-level',
        'u9-generated-top-level-limit-skip-coalescing',
        'u9-generated-nested-limit-skip-coalescing',
        'u9-limit-skip-preservation-barriers',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: merges adjacent strict-integer $limit (min) and $skip (safe sum) stages. No field order, document mutation, or error alterations.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-limit-skip-coalescing',
                strictFieldOrder: 'mixed-shape-limit-skip-coalescing',
                strictErrors: 'mixed-shape-limit-skip-coalescing'
            },
            strictModeBehavior: 'preserved'
        }
    ),
    evidence(
        'match-pushdown',
        'u5-match-project-alias-top-level',
        'u9-generated-top-level-match-pushdown',
        'u9-generated-nested-match-pushdown',
        'u5-match-nested-facet-safe',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: rewrites alias references across projections and addFields; checks path-disjointness and field visibility; constrained under strictErrors when crossed stage may error.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-match-pushdown',
                strictFieldOrder: 'mixed-shape-match-pushdown',
                strictErrors: 'mixed-shape-match-pushdown'
            },
            strictModeBehavior: 'constrained'
        }
    ),
    evidence(
        'heuristic-match-pushdown',
        'feat-heuristic-match-pushdown-focused',
        'u9-generated-top-level-heuristic-match-pushdown',
        'u9-generated-nested-heuristic-match-pushdown',
        'feat-heuristic-match-pushdown-oracle',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: hoists deterministic computed-field filter conjuncts across costly stages ($lookup, $graphLookup, $function) using temporary shadow fields; unsets shadow fields before downstream readers; rejects dotted keys and __heuristic_ fields; constrained under strictErrors when crossed stage may error.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-heuristic-match-pushdown',
                strictFieldOrder: 'mixed-shape-heuristic-match-pushdown',
                strictErrors: 'mixed-shape-heuristic-match-pushdown'
            },
            strictModeBehavior: 'constrained'
        }
    ),
    evidence(
        'limit-advance',
        'u5-limit-passive-top-level',
        'u9-generated-top-level-limit-advance',
        'u9-generated-nested-limit-advance',
        'u5-limit-nested-lookup-safe',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: hoists limit and skip stages across passive stages ($project, $addFields, $set, $unset); constrained under strictErrors when crossed stage may error.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-limit-advance',
                strictFieldOrder: 'mixed-shape-limit-advance',
                strictErrors: 'mixed-shape-limit-advance'
            },
            strictModeBehavior: 'constrained'
        }
    ),
    evidence(
        'add-field-pushdown',
        'feat-add-field-pushdown-focused',
        'u9-generated-top-level-add-field-pushdown',
        'u9-generated-nested-add-field-pushdown',
        'feat-add-field-pushdown-oracle',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: shape-tolerant, blocks sibling reads on split, blocks $$ROOT/$$CURRENT reads on split, constrained under strictFieldOrder when crossed stage adds fields and under strictErrors when crossed stage may error.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-ae1-sibling-read',
                strictFieldOrder: 'mixed-shape-ae2-field-order',
                strictErrors: 'mixed-shape-ae1-sibling-read'
            },
            strictModeBehavior: 'constrained'
        }
    ),
    evidence(
        'top-k-pushdown',
        'feat-top-k-pushdown-focused',
        'u9-generated-top-level-top-k-pushdown',
        'u9-generated-nested-top-k-pushdown',
        'feat-top-k-pushdown-oracle',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: sort semantics preserved across BSON types and arrays since crossed passive stages do not modify sort keys; constrained under strictErrors when crossed stage may error.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-ae5-toint-error',
                strictFieldOrder: 'mixed-shape-ae5-toint-error',
                strictErrors: 'mixed-shape-ae5-toint-error'
            },
            strictModeBehavior: 'constrained'
        }
    ),
    evidence(
        'unused-field-pruning',
        'u6-dead-write-unset-top-level',
        'u9-generated-top-level-unused-field-pruning',
        'u9-generated-nested-unused-field-pruning',
        'u6-nested-facet-safe-rewrites',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: eliminates overwritten or unobserved added/set fields before projections/unsets; under strictErrors, error-prone stages cannot be removed.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-unused-field-pruning',
                strictFieldOrder: 'mixed-shape-unused-field-pruning',
                strictErrors: 'mixed-shape-unused-field-pruning'
            },
            strictModeBehavior: 'constrained'
        }
    ),
    evidence(
        'adjacent-project-merging',
        'u6-project-merge-inclusion-top-level',
        'u9-generated-top-level-adjacent-project-merging',
        'u9-generated-nested-adjacent-project-merging',
        'u6-project-resurrection-empty-output-barrier',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: merges adjacent pure flag projections (inclusion and exclusion) without resurrection or empty projections; pure projections are error-free and preserve document field order.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-adjacent-project-merging',
                strictFieldOrder: 'mixed-shape-adjacent-project-merging',
                strictErrors: 'mixed-shape-adjacent-project-merging'
            },
            strictModeBehavior: 'preserved'
        }
    ),
    evidence(
        'adjacent-add-field-merging',
        'u6-add-set-merge-top-level',
        'u9-generated-top-level-adjacent-add-field-merging',
        'u9-generated-nested-adjacent-add-field-merging',
        'u6-add-set-current-getfield-barrier',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: merges adjacent disjoint addFields/set stages; checks path-disjointness, prevents second stage from reading first writes or colliding hierarchically; preserves field order and error behavior.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-adjacent-add-field-merging',
                strictFieldOrder: 'mixed-shape-adjacent-add-field-merging',
                strictErrors: 'mixed-shape-adjacent-add-field-merging'
            },
            strictModeBehavior: 'preserved'
        }
    ),
    evidence(
        'lookup-delay',
        'u7-lookup-delay-sort-unset-resource-barrier',
        'u9-generated-top-level-lookup-delay',
        'u9-generated-nested-lookup-delay',
        'u7-lookup-delay-match-error-timing-barrier',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: delays simple equality lookups past sort, limit, skip, and match; alias movement respects strictFieldOrder when crossing field-adding stages; sub-pipeline and crossed stage error checks enforce strictErrors.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-lookup-delay',
                strictFieldOrder: 'mixed-shape-lookup-delay',
                strictErrors: 'mixed-shape-lookup-delay'
            },
            strictModeBehavior: 'constrained'
        }
    ),
    evidence(
        'redundant-lookup-elimination',
        'u7-redundant-lookup-discarded-project',
        'u9-generated-top-level-redundant-lookup-elimination',
        'u9-generated-nested-redundant-lookup-elimination',
        'u7-redundant-lookup-discarded-project',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: eliminates simple equality lookups whose alias is immediately discarded by following stage; under strictErrors, error-prone stages cannot be removed.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-redundant-lookup-elimination',
                strictFieldOrder: 'mixed-shape-redundant-lookup-elimination',
                strictErrors: 'mixed-shape-redundant-lookup-elimination'
            },
            strictModeBehavior: 'constrained'
        }
    ),
    evidence(
        'sort-project-commute',
        'u5-sort-project-retained-keys',
        'u9-generated-top-level-sort-project-commute',
        'u9-generated-nested-sort-project-commute',
        'u5-sort-project-retained-keys',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: moves simple flag project before adjacent sort when every sort key stays visible; pure flag projections are error-free and preserve document field order.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-sort-project-commute',
                strictFieldOrder: 'mixed-shape-sort-project-commute',
                strictErrors: 'mixed-shape-sort-project-commute',
            },
            strictModeBehavior: 'preserved',
        },
    ),
    evidence(
        'complex-projection-deferral',
        'u6-add-field-deferral-sort',
        'u9-generated-top-level-complex-projection-deferral',
        'u9-generated-nested-complex-projection-deferral',
        'u6-add-field-deferral-sort',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: delays deterministic addFields/set past adjacent sort when sort keys do not overlap written fields; field order is preserved; constrained under strictErrors when addFields stage may error.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-complex-projection-deferral',
                strictFieldOrder: 'mixed-shape-complex-projection-deferral',
                strictErrors: 'mixed-shape-complex-projection-deferral',
            },
            strictModeBehavior: 'constrained',
        },
    ),
    evidence(
        'facet-prefix-hoisting',
        'feat-facet-prefix-hoisting-focused',
        'u9-generated-top-level-facet-prefix-hoisting',
        'u9-generated-nested-facet-prefix-hoisting',
        'feat-facet-prefix-hoisting-oracle',
        {
            status: 'active',
            proofRecheckNote: 'Proof audited: hoists identical deterministic prefix stages out of facet branches; preserves cardinality and branch field structure; constrained under strictErrors when candidate stage may error.',
            mixedShapeCaseIds: {
                default: 'mixed-shape-facet-prefix-hoisting',
                strictFieldOrder: 'mixed-shape-facet-prefix-hoisting',
                strictErrors: 'mixed-shape-facet-prefix-hoisting',
            },
            strictModeBehavior: 'constrained',
        },
    ),
]);
