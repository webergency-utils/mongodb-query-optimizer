import { withCandidateFilterRuleProfile } from '../filter-rule-registry';
import { deepClone, structuralFingerprint } from '../utils';
import { AdjacentAddFieldMergingPass } from './adjacent-addfield-merging';
import { AdjacentMatchMergingPass } from './adjacent-match-merging';
import { AdjacentProjectMergingPass } from './adjacent-project-merging';
import { ComplexProjectionDeferralPass } from './complex-projection-deferral';
import { ExprMatchNormalizationPass } from './expr-match-normalization';
import { FacetPrefixHoistingPass } from './facet-prefix-hoisting';
import { FilterOptimizationPass } from './filter-optimization';
import { GroupFilterPushdownPass } from './group-filter-pushdown';
import { LimitSkipCoalescingPass } from './limit-skip-coalescing';
import { MatchPushdownPass } from './match-pushdown';
import {
    LimitAdvancePass,
    LookupDelayPass,
} from './ordering-stability';
import { RedundantLookupEliminationPass } from './redundant-lookup-elimination';
import { RedundantProjectionEliminationPass } from './redundant-projection-elimination';
import { SortProjectCommutePass } from './sort-project-commute';
import { StagePriorityReorderPass } from './stage-priority-reorder';
import { PipelinePass } from './types';
import { UnusedFieldPruningPass } from './unused-field-pruning';
import { UnwindPrefilterPass } from './unwind-prefilter';

type PipelinePassFactory = () => PipelinePass;

const registeredPipelineTransformationIds = Object.freeze([
    'expr-match-normalization',
    'filter-optimization',
    'adjacent-match-merging',
    'group-filter-pushdown',
    'unwind-prefilter',
    'limit-skip-coalescing',
    'match-pushdown',
    'limit-advance',
    'unused-field-pruning',
    'adjacent-project-merging',
    'adjacent-add-field-merging',
    'lookup-delay',
    'redundant-lookup-elimination',
    'sort-project-commute',
    'complex-projection-deferral',
    'facet-prefix-hoisting',
    'stage-priority-reorder',
    'redundant-projection-elimination',
] as const);

export type PipelineTransformationId =
    typeof registeredPipelineTransformationIds[number];

const activePipelineTransformationIds: readonly PipelineTransformationId[] = Object.freeze([
    'expr-match-normalization',
    'filter-optimization',
    'adjacent-match-merging',
    'group-filter-pushdown',
    'unwind-prefilter',
    'limit-skip-coalescing',
    'match-pushdown',
    'limit-advance',
    'unused-field-pruning',
    'adjacent-project-merging',
    'adjacent-add-field-merging',
    'lookup-delay',
    'redundant-lookup-elimination',
    'sort-project-commute',
    'complex-projection-deferral',
    'facet-prefix-hoisting',
]);

const containedPipelineTransformationIds: readonly PipelineTransformationId[] = Object.freeze([
    'stage-priority-reorder',
    'redundant-projection-elimination',
]);

export interface PipelineTransformationRegistryStatus
{
    readonly registered: readonly PipelineTransformationId[];
    readonly active: readonly PipelineTransformationId[];
    readonly contained: readonly PipelineTransformationId[];
}

const pipelineTransformationRegistryStatus: PipelineTransformationRegistryStatus = Object.freeze({
    registered: registeredPipelineTransformationIds,
    active: activePipelineTransformationIds,
    contained: containedPipelineTransformationIds,
});

const candidatePipelineTransformationRegistry: Readonly<
    Record<PipelineTransformationId, PipelinePassFactory>
> = Object.freeze({
    'expr-match-normalization': () => new ExprMatchNormalizationPass(),
    'filter-optimization': () => new FilterOptimizationPass(),
    'adjacent-match-merging': () => new AdjacentMatchMergingPass(),
    'group-filter-pushdown': () => new GroupFilterPushdownPass(),
    'unwind-prefilter': () => new UnwindPrefilterPass(),
    'limit-skip-coalescing': () => new LimitSkipCoalescingPass(),
    'match-pushdown': () => new MatchPushdownPass(),
    'limit-advance': () => new LimitAdvancePass(),
    'lookup-delay': () => new LookupDelayPass(),
    'redundant-lookup-elimination': () => new RedundantLookupEliminationPass(),
    'sort-project-commute': () => new SortProjectCommutePass(),
    'stage-priority-reorder': () => new StagePriorityReorderPass(),
    'complex-projection-deferral': () => new ComplexProjectionDeferralPass(),
    'unused-field-pruning': () => new UnusedFieldPruningPass(),
    'adjacent-project-merging': () => new AdjacentProjectMergingPass(),
    'adjacent-add-field-merging': () => new AdjacentAddFieldMergingPass(),
    'facet-prefix-hoisting': () => new FacetPrefixHoistingPass(),
    'redundant-projection-elimination': () => new RedundantProjectionEliminationPass(),
});

const candidatePipelineProfile: readonly PipelineTransformationId[] =
    registeredPipelineTransformationIds;
const DEFAULT_GLOBAL_SWEEP_BUDGET = 100;

function resolveCandidatePasses(
    selectedTransformationIds: readonly string[],
): readonly PipelinePass[]
{
    const factories: PipelinePassFactory[] = [];

    for (const id of selectedTransformationIds)
    {
        const factory = (
            candidatePipelineTransformationRegistry as Record<
                string,
                PipelinePassFactory | undefined
            >
        )[id];

        if (!factory)
        {
            throw new Error(`Pipeline transformation is not registered: ${id}`);
        }

        factories.push(factory);
    }

    return instantiatePasses(factories);
}

function instantiatePasses(
    registry: readonly PipelinePassFactory[],
): readonly PipelinePass[]
{
    return registry.map((createPass) => createPass());
}

/**
 * Package-private immutable registry introspection for proof-manifest tests.
 */
export function getPipelineTransformationRegistryStatus(): PipelineTransformationRegistryStatus
{
    return pipelineTransformationRegistryStatus;
}

function optimizeStageChildrenForSweep(
    stage: any,
    passes: readonly PipelinePass[],
): any
{
    if (!stage || typeof stage !== "object" || Array.isArray(stage))
    {
        return stage;
    }

    let current = stage;
    const facet = current.$facet;

    if (facet && typeof facet === "object")
    {
        const optimizedFacet: Record<string, any> = {};

        for (const [name, subpipeline] of Object.entries(facet))
        {
            optimizedFacet[name] = Array.isArray(subpipeline)
                ? applyGlobalSweep(subpipeline, passes)
                : subpipeline;
        }

        current = {
            ...current,
            $facet: optimizedFacet,
        };
    }

    const lookup = current.$lookup;
    if (
        lookup
        && typeof lookup === "object"
        && !Array.isArray(lookup)
        && Array.isArray(lookup.pipeline)
    )
    {
        current = {
            ...current,
            $lookup: {
                ...lookup,
                pipeline: applyGlobalSweep(lookup.pipeline, passes),
            },
        };
    }

    const unionWith = current.$unionWith;
    if (
        unionWith
        && typeof unionWith === "object"
        && !Array.isArray(unionWith)
        && Array.isArray(unionWith.pipeline)
    )
    {
        current = {
            ...current,
            $unionWith: {
                ...unionWith,
                pipeline: applyGlobalSweep(unionWith.pipeline, passes),
            },
        };
    }

    return current;
}

function applyGlobalSweep(
    pipeline: any[],
    passes: readonly PipelinePass[],
): any[]
{
    let current = pipeline.map((stage) =>
        optimizeStageChildrenForSweep(stage, passes),
    );

    for (const pass of passes)
    {
        current = pass.execute(current);
    }

    return current;
}

/**
 * Package-private scheduler seam for deterministic custom-pass and budget tests.
 * The package root intentionally does not export it.
 */
export function optimizePipelineWithPasses(
    pipeline: any,
    passes: readonly PipelinePass[],
    sweepBudget = DEFAULT_GLOBAL_SWEEP_BUDGET,
): any
{
    if (!Array.isArray(pipeline))
    {
        return pipeline;
    }

    const pristine = deepClone(pipeline);
    if (passes.length === 0)
    {
        return pristine;
    }

    if (!Number.isSafeInteger(sweepBudget) || sweepBudget <= 0)
    {
        return pristine;
    }

    let current = deepClone(pristine);
    let currentFingerprint = structuralFingerprint(current);
    const history = new Set<string>([currentFingerprint]);

    for (let sweep = 0; sweep < sweepBudget; sweep++)
    {
        const next = applyGlobalSweep(current, passes);
        const nextFingerprint = structuralFingerprint(next);

        if (nextFingerprint === currentFingerprint)
        {
            return next;
        }

        if (history.has(nextFingerprint))
        {
            return pristine;
        }

        history.add(nextFingerprint);
        current = next;
        currentFingerprint = nextFingerprint;
    }

    return pristine;
}

export function optimizePipelineWithProductionRegistry(pipeline: any): any
{
    return optimizePipelineWithPasses(
        pipeline,
        resolveCandidatePasses(activePipelineTransformationIds),
    );
}

/**
 * Package-private candidate seam. The package root intentionally does not export it.
 */
export function optimizePipelineWithCandidateProfile(
    pipeline: any,
    selectedTransformationIds: readonly string[] = candidatePipelineProfile,
    selectedFilterRuleIds?: readonly string[],
): any
{
    const passes = resolveCandidatePasses(selectedTransformationIds);
    const run = () => optimizePipelineWithPasses(pipeline, passes);

    if (selectedFilterRuleIds)
    {
        return withCandidateFilterRuleProfile(run, selectedFilterRuleIds);
    }

    return withCandidateFilterRuleProfile(run);
}
