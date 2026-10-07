import {
    optimizePipelineWithCandidateProfile,
    type PipelineTransformationId
} from '../../src/passes/registry.js';
import {
    optimizeFilterWithCandidateProfile
} from '../../src/filter-optimizer.js';
import type { FilterRuleId } from '../../src/filter-rule-registry.js';
import type { OptimizerOptions } from '../../src/guarantees.js';

export const PRE_GATE_PIPELINE_TRANSFORMATION_IDS: readonly PipelineTransformationId[] = Object.freeze(
[
    'expr-match-normalization',
    'filter-optimization',
    'adjacent-match-merging',
    'group-filter-pushdown',
    'bucket-filter-pushdown',
    'unwind-prefilter',
    'redundant-sort-elimination',
    'sort-by-count-simplification',
    'limit-skip-coalescing',
    'match-pushdown',
    'heuristic-match-pushdown',
    'limit-advance',
    'add-field-pushdown',
    'top-k-pushdown',
    'unused-field-pruning',
    'adjacent-project-merging',
    'adjacent-add-field-merging',
    'lookup-delay',
    'redundant-lookup-elimination',
    'sort-project-commute',
    'complex-projection-deferral',
    'facet-prefix-hoisting'
] );

export const PRE_GATE_FILTER_RULE_IDS: readonly FilterRuleId[] = Object.freeze(
[
    'simplify-equality',
    'simplify-singleton-in',
    'flatten-conjunctions',
    'flatten-disjunctions',
    'simplify-conjunction-identities',
    'simplify-disjunction-identities',
    'deduplicate-conjunctions',
    'merge-conjunctions'
] );

export function optimizePipeline<T = any>( pipeline: any[], options?: OptimizerOptions ): T[]
{
    return optimizePipelineWithCandidateProfile(
        pipeline,
        PRE_GATE_PIPELINE_TRANSFORMATION_IDS,
        PRE_GATE_FILTER_RULE_IDS,
        options
    );
}

export function optimizeFilter<T = any>( filter: any, options?: OptimizerOptions ): T
{
    return optimizeFilterWithCandidateProfile(
        filter,
        PRE_GATE_FILTER_RULE_IDS,
        options
    );
}
