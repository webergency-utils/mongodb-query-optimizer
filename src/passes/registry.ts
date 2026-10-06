import { isFilterContradiction } from '../analyzer/filters';
import { withCandidateFilterRuleProfile } from '../filter-rule-registry';
import { GuaranteeContext, OptimizerOptions, resolvePipelineGuarantees } from '../guarantees';
import { deepClone, structuralFingerprint } from '../utils';
import { AdjacentAddFieldMergingPass } from './adjacent-addfield-merging';
import { AddFieldPushdownPass } from './add-field-pushdown';
import { AdjacentMatchMergingPass } from './adjacent-match-merging';
import { AdjacentProjectMergingPass } from './adjacent-project-merging';
import { BucketFilterPushdownPass } from './bucket-filter-pushdown';
import { ComplexProjectionDeferralPass } from './complex-projection-deferral';
import { CoveredProjectionSynthesisPass } from './covered-projection-synthesis';
import { DeadAssignmentEliminationPass } from './dead-assignment-elimination';
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
import { RedundantSortEliminationPass } from './redundant-sort-elimination';
import { SortByCountSimplificationPass } from './sort-by-count-simplification';
import { SortProjectCommutePass } from './sort-project-commute';
import { StagePriorityReorderPass } from './stage-priority-reorder';
import { PipelinePass } from './types';
import { TopKPushdownPass } from './top-k-pushdown';
import { UnusedFieldPruningPass } from './unused-field-pruning';
import { UnwindPrefilterPass } from './unwind-prefilter';

type PipelinePassFactory = () => PipelinePass;

const registeredPipelineTransformationIds = Object.freeze([
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
    'facet-prefix-hoisting',
    'stage-priority-reorder',
    'redundant-projection-elimination',
    'covered-projection-synthesis',
    'dead-assignment-elimination',
] as const);

export type PipelineTransformationId =
    typeof registeredPipelineTransformationIds[number];

const activePipelineTransformationIds: readonly PipelineTransformationId[] = Object.freeze([
    'group-filter-pushdown',
    'bucket-filter-pushdown',
    'unwind-prefilter',
    'redundant-sort-elimination',
    'sort-by-count-simplification',
    'limit-skip-coalescing',
    'match-pushdown',
    'limit-advance',
    'add-field-pushdown',
    'top-k-pushdown',
    'unused-field-pruning',
    'adjacent-project-merging',
    'adjacent-add-field-merging',
    'lookup-delay'
]);

const containedPipelineTransformationIds: readonly PipelineTransformationId[] = Object.freeze([
    'stage-priority-reorder',
    'redundant-projection-elimination',
    'covered-projection-synthesis',
    'dead-assignment-elimination',
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
    'bucket-filter-pushdown': () => new BucketFilterPushdownPass(),
    'unwind-prefilter': () => new UnwindPrefilterPass(),
    'redundant-sort-elimination': () => new RedundantSortEliminationPass(),
    'sort-by-count-simplification': () => new SortByCountSimplificationPass(),
    'limit-skip-coalescing': () => new LimitSkipCoalescingPass(),
    'match-pushdown': () => new MatchPushdownPass(),
    'limit-advance': () => new LimitAdvancePass(),
    'add-field-pushdown': () => new AddFieldPushdownPass(),
    'top-k-pushdown': () => new TopKPushdownPass(),
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
    'covered-projection-synthesis': () => new CoveredProjectionSynthesisPass(),
    'dead-assignment-elimination': () => new DeadAssignmentEliminationPass(),
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

function collectStageTypes( pipeline: readonly any[] ): Set<string>
{
    const types = new Set<string>();

    for( const stage of pipeline )
    {
        if( stage && typeof stage === 'object' && !Array.isArray( stage ))
        {
            for( const key of Object.keys( stage ))
            {
                if( key.startsWith( '$' ))
                {
                    types.add( key );
                }
            }
        }
    }

    return types;
}

function pipelinesShallowEqual( a: readonly any[], b: readonly any[] ): boolean
{
    if( a === b ){ return true }
    if( a.length !== b.length ){ return false }

    for( let i = 0; i < a.length; i++ )
    {
        if( a[ i ] !== b[ i ] ){ return false }
    }

    return true;
}

interface SweepResult
{
    readonly pipeline : any[];
    readonly modified : boolean;
}

function optimizeStageChildrenForSweep(
    stage   : any,
    passes  : readonly PipelinePass[],
    context : GuaranteeContext
): any
{
    if( !stage || typeof stage !== 'object' || Array.isArray( stage ))
    {
        return stage;
    }

    let current = stage;
    const facet = current.$facet;

    if( facet && typeof facet === 'object' && !Array.isArray( facet ))
    {
        let facetModified = false;
        const optimizedFacet: Record<string, any> = {};

        for( const [ name, subpipeline ] of Object.entries( facet ))
        {
            if( Array.isArray( subpipeline ))
            {
                const optimizedSub = applyGlobalSweep( subpipeline, passes, context );

                if( !pipelinesShallowEqual( optimizedSub, subpipeline ))
                {
                    facetModified = true;
                }

                optimizedFacet[ name ] = optimizedSub;
            }
            else
            {
                optimizedFacet[ name ] = subpipeline;
            }
        }

        if( facetModified )
        {
            current = {
                ...current,
                $facet : optimizedFacet
            };
        }
    }

    const lookup = current.$lookup;

    if(
        lookup
        && typeof lookup === 'object'
        && !Array.isArray( lookup )
        && Array.isArray( lookup.pipeline )
    )
    {
        const optimizedLookupPipeline = applyGlobalSweep( lookup.pipeline, passes, context );

        if( !pipelinesShallowEqual( optimizedLookupPipeline, lookup.pipeline ))
        {
            current = {
                ...current,
                $lookup : {
                    ...lookup,
                    pipeline : optimizedLookupPipeline
                }
            };
        }
    }

    const unionWith = current.$unionWith;

    if(
        unionWith
        && typeof unionWith === 'object'
        && !Array.isArray( unionWith )
        && Array.isArray( unionWith.pipeline )
    )
    {
        const optimizedUnionPipeline = applyGlobalSweep( unionWith.pipeline, passes, context );

        if( !pipelinesShallowEqual( optimizedUnionPipeline, unionWith.pipeline ))
        {
            current = {
                ...current,
                $unionWith : {
                    ...unionWith,
                    pipeline : optimizedUnionPipeline
                }
            };
        }
    }

    return current;
}

function applyGlobalSweepWithDirty(
    pipeline : any[],
    passes   : readonly PipelinePass[],
    context  : GuaranteeContext
): SweepResult
{
    let modified = false;
    const childOptimized: any[] = [];

    for( let i = 0; i < pipeline.length; i++ )
    {
        const origStage = pipeline[ i ];
        const optStage = optimizeStageChildrenForSweep( origStage, passes, context );

        if( optStage !== origStage )
        {
            modified = true;
        }

        childOptimized.push( optStage );
    }

    let current = childOptimized;
    let stageTypes = collectStageTypes( current );

    for( const pass of passes )
    {
        if( pass.stageTypes && !pass.stageTypes.some(( t ) => stageTypes.has( t )))
        {
            continue;
        }

        const next = pass.execute( current, context );

        if( !pipelinesShallowEqual( current, next ))
        {
            modified = true;
            current = next;
            stageTypes = collectStageTypes( current );
        }
    }

    for( let i = 0; i < current.length; i++ )
    {
        const stage = current[ i ];

        if( stage && typeof stage === 'object' && !Array.isArray( stage ) && stage.$match )
        {
            if( isFilterContradiction( stage.$match ) && !hasUnionWithAfter( current, i ))
            {
                if( current.length > i + 1 )
                {
                    current = current.slice( 0, i + 1 );
                    modified = true;
                }

                break;
            }
        }
    }

    return {
        pipeline : current,
        modified
    };
}

function hasUnionWithAfter( pipeline: readonly any[], fromIndex: number ): boolean
{
    for( let i = fromIndex + 1; i < pipeline.length; i++ )
    {
        if( pipeline[ i ] && typeof pipeline[ i ] === 'object' && '$unionWith' in pipeline[ i ] )
        {
            return true;
        }
    }

    return false;
}

function applyGlobalSweep(
    pipeline : any[],
    passes   : readonly PipelinePass[],
    context  : GuaranteeContext
): any[]
{
    return applyGlobalSweepWithDirty( pipeline, passes, context ).pipeline;
}

/**
 * Package-private scheduler seam for deterministic custom-pass and budget tests.
 * The package root intentionally does not export it. Options are resolved once here,
 * so a top-level `$out` or `$merge` forces strict errors for every level.
 */
export function optimizePipelineWithPasses(
    pipeline    : any,
    passes      : readonly PipelinePass[],
    sweepBudget = DEFAULT_GLOBAL_SWEEP_BUDGET,
    options?    : OptimizerOptions
): any
{
    if( !Array.isArray( pipeline ))
    {
        return pipeline;
    }

    const pristine = deepClone( pipeline );

    if( passes.length === 0 )
    {
        return pristine;
    }

    if( !Number.isSafeInteger( sweepBudget ) || sweepBudget <= 0 )
    {
        return pristine;
    }

    const context = resolvePipelineGuarantees( pipeline, options );
    let current = deepClone( pristine );
    let currentFingerprint: string | null = null;
    let history: Set<string> | null = null;

    for( let sweep = 0; sweep < sweepBudget; sweep++ )
    {
        const sweepResult = applyGlobalSweepWithDirty( current, passes, context );

        if( !sweepResult.modified )
        {
            return sweepResult.pipeline;
        }

        if( currentFingerprint === null )
        {
            currentFingerprint = structuralFingerprint( current );
            history = new Set<string>([ currentFingerprint ]);
        }

        const next = sweepResult.pipeline;
        const nextFingerprint = structuralFingerprint( next );

        if( nextFingerprint === currentFingerprint )
        {
            return next;
        }

        if( history!.has( nextFingerprint ))
        {
            return pristine;
        }

        history!.add( nextFingerprint );
        current = next;
        currentFingerprint = nextFingerprint;
    }

    return pristine;
}

export function optimizePipelineWithProductionRegistry( pipeline: any, options?: OptimizerOptions ): any
{
    return optimizePipelineWithPasses(
        pipeline,
        resolveCandidatePasses( activePipelineTransformationIds ),
        DEFAULT_GLOBAL_SWEEP_BUDGET,
        options
    );
}

/**
 * Package-private candidate seam. The package root intentionally does not export it.
 */
export function optimizePipelineWithCandidateProfile(
    pipeline: any,
    selectedTransformationIds: readonly string[] = candidatePipelineProfile,
    selectedFilterRuleIds?: readonly string[],
    options?: OptimizerOptions,
): any
{
    const passes = resolveCandidatePasses(selectedTransformationIds);
    const run = () => optimizePipelineWithPasses( pipeline, passes, DEFAULT_GLOBAL_SWEEP_BUDGET, options );

    if (selectedFilterRuleIds)
    {
        return withCandidateFilterRuleProfile(run, selectedFilterRuleIds);
    }

    return withCandidateFilterRuleProfile(run);
}
