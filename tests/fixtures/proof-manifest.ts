import type { FilterRuleId } from '../../src/filter-rule-registry.js';
import type {
    PipelineTransformationId,
} from '../../src/passes/registry.js';

export interface TransformationProofEvidence<Id extends string>
{
    readonly transformationId: Id;
    readonly focused: readonly string[];
    readonly interaction: readonly string[];
    readonly nested: readonly string[];
    readonly mongodbFixtures: readonly string[];
}

function evidence<Id extends string>(
    transformationId: Id,
    focused: string,
    interaction: string,
    nested: string,
    mongodbFixture: string,
): TransformationProofEvidence<Id>
{
    return Object.freeze({
        transformationId,
        focused: Object.freeze([focused]),
        interaction: Object.freeze([interaction]),
        nested: Object.freeze([nested]),
        mongodbFixtures: Object.freeze([mongodbFixture]),
    });
}

export const filterProofManifest: readonly TransformationProofEvidence<FilterRuleId>[] = Object.freeze([
    evidence(
        'simplify-equality',
        'filter-explicit-regex-equality-contained',
        'u9-generated-top-level-filter-optimization',
        'u9-generated-nested-filter-optimization',
        'u4-pipeline-top-level-filter-rules',
    ),
    evidence(
        'simplify-singleton-in',
        'u4-filter-singleton-in-exotic-values',
        'u9-generated-top-level-adjacent-match-merging',
        'u9-generated-nested-adjacent-match-merging',
        'u4-pipeline-nested-lookup-filters',
    ),
    evidence(
        'flatten-conjunctions',
        'u4-filter-valid-logical-flattening',
        'u9-generated-top-level-limit-skip-coalescing',
        'u9-generated-nested-limit-skip-coalescing',
        'u4-filter-invalid-empty-and',
    ),
    evidence(
        'flatten-disjunctions',
        'u4-filter-invalid-empty-or',
        'u9-generated-top-level-match-pushdown',
        'u9-generated-nested-match-pushdown',
        'u4-filter-invalid-empty-or',
    ),
    evidence(
        'simplify-conjunction-identities',
        'u4-filter-invalid-empty-and',
        'u9-generated-top-level-limit-advance',
        'u9-generated-nested-limit-advance',
        'u4-filter-invalid-empty-and',
    ),
    evidence(
        'simplify-disjunction-identities',
        'filter-match-all-or-contained',
        'u9-generated-top-level-unused-field-pruning',
        'u9-generated-nested-unused-field-pruning',
        'u4-filter-match-all-or-with-sibling',
    ),
    evidence(
        'deduplicate-conjunctions',
        'u4-filter-distinct-regex-conjunction',
        'u9-generated-top-level-adjacent-project-merging',
        'u9-generated-nested-adjacent-project-merging',
        'u4-filter-multikey-embedded-document-order',
    ),
    evidence(
        'merge-conjunctions',
        'filter-logical-field-order-contained',
        'u9-generated-top-level-adjacent-add-field-merging',
        'u9-generated-nested-adjacent-add-field-merging',
        'u4-pipeline-adjacent-multikey-matches',
    ),
]);

export const pipelineProofManifest: readonly TransformationProofEvidence<PipelineTransformationId>[] = Object.freeze([
    evidence(
        'expr-match-normalization',
        'feat-expr-match-normalization-focused',
        'u9-generated-top-level-expr-match-normalization',
        'u9-generated-nested-expr-match-normalization',
        'feat-expr-match-normalization-oracle',
    ),
    evidence(
        'filter-optimization',
        'u4-pipeline-top-level-filter-rules',
        'u9-generated-top-level-filter-optimization',
        'u9-generated-nested-filter-optimization',
        'pipeline-invalid-empty-logical-array-contained',
    ),
    evidence(
        'adjacent-match-merging',
        'u4-pipeline-adjacent-multikey-matches',
        'u9-generated-top-level-adjacent-match-merging',
        'u9-generated-nested-adjacent-match-merging',
        'u4-pipeline-nested-facet-filters',
    ),
    evidence(
        'group-filter-pushdown',
        'feat-group-filter-pushdown-focused',
        'u9-generated-top-level-group-filter-pushdown',
        'u9-generated-nested-group-filter-pushdown',
        'feat-group-filter-pushdown-oracle',
    ),
    evidence(
        'bucket-filter-pushdown',
        'feat-bucket-filter-pushdown-focused',
        'u9-generated-top-level-bucket-filter-pushdown',
        'u9-generated-nested-bucket-filter-pushdown',
        'feat-bucket-filter-pushdown-oracle',
    ),
    evidence(
        'unwind-prefilter',
        'feat-unwind-prefilter-focused',
        'u9-generated-top-level-unwind-prefilter',
        'u9-generated-nested-unwind-prefilter',
        'feat-unwind-prefilter-oracle',
    ),
    evidence(
        'redundant-sort-elimination',
        'feat-redundant-sort-elimination-focused',
        'u9-generated-top-level-redundant-sort-elimination',
        'u9-generated-nested-redundant-sort-elimination',
        'feat-redundant-sort-elimination-oracle',
    ),
    evidence(
        'sort-by-count-simplification',
        'feat-sort-by-count-simplification-focused',
        'u9-generated-top-level-sort-by-count-simplification',
        'u9-generated-nested-sort-by-count-simplification',
        'feat-sort-by-count-simplification-oracle',
    ),
    evidence(
        'limit-skip-coalescing',
        'u9-limit-skip-safe-top-level',
        'u9-generated-top-level-limit-skip-coalescing',
        'u9-generated-nested-limit-skip-coalescing',
        'u9-limit-skip-preservation-barriers',
    ),
    evidence(
        'match-pushdown',
        'u5-match-project-alias-top-level',
        'u9-generated-top-level-match-pushdown',
        'u9-generated-nested-match-pushdown',
        'u5-match-nested-facet-safe',
    ),
    evidence(
        'limit-advance',
        'u5-limit-passive-top-level',
        'u9-generated-top-level-limit-advance',
        'u9-generated-nested-limit-advance',
        'u5-limit-nested-lookup-safe',
    ),
    evidence(
        'unused-field-pruning',
        'u6-dead-write-unset-top-level',
        'u9-generated-top-level-unused-field-pruning',
        'u9-generated-nested-unused-field-pruning',
        'u6-nested-facet-safe-rewrites',
    ),
    evidence(
        'adjacent-project-merging',
        'u6-project-merge-inclusion-top-level',
        'u9-generated-top-level-adjacent-project-merging',
        'u9-generated-nested-adjacent-project-merging',
        'u6-project-resurrection-empty-output-barrier',
    ),
    evidence(
        'adjacent-add-field-merging',
        'u6-add-set-merge-top-level',
        'u9-generated-top-level-adjacent-add-field-merging',
        'u9-generated-nested-adjacent-add-field-merging',
        'u6-add-set-current-getfield-barrier',
    ),
    evidence(
        'lookup-delay',
        'u7-lookup-delay-sort-unset-resource-barrier',
        'u9-generated-top-level-lookup-delay',
        'u9-generated-nested-lookup-delay',
        'u7-lookup-delay-match-error-timing-barrier',
    ),
    evidence(
        'redundant-lookup-elimination',
        'u7-redundant-lookup-discarded-project',
        'u9-generated-top-level-redundant-lookup-elimination',
        'u9-generated-nested-redundant-lookup-elimination',
        'u7-redundant-lookup-discarded-project',
    ),
    evidence(
        'sort-project-commute',
        'u5-sort-project-retained-keys',
        'u9-generated-top-level-sort-project-commute',
        'u9-generated-nested-sort-project-commute',
        'u5-sort-project-retained-keys',
    ),
    evidence(
        'complex-projection-deferral',
        'u6-add-field-deferral-sort',
        'u9-generated-top-level-complex-projection-deferral',
        'u9-generated-nested-complex-projection-deferral',
        'u6-add-field-deferral-sort',
    ),
    evidence(
        'facet-prefix-hoisting',
        'feat-facet-prefix-hoisting-focused',
        'u9-generated-top-level-facet-prefix-hoisting',
        'u9-generated-nested-facet-prefix-hoisting',
        'feat-facet-prefix-hoisting-oracle',
    ),
]);
