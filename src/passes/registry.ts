import { isFilterContradiction } from '../analyzer/filters';
import { withCandidateFilterRuleProfile } from '../filter-rule-registry';
import { GuaranteeContext, OptimizerOptions, resolvePipelineGuarantees } from '../guarantees';
import { containsValue, hasCycle, isEqual, isPlainObject } from '../utils';
import { AdjacentAddFieldMergingPass } from './adjacent-addfield-merging';
import { AddFieldPushdownPass } from './add-field-pushdown';
import { AdjacentMatchMergingPass } from './adjacent-match-merging';
import { AdjacentProjectMergingPass } from './adjacent-project-merging';
import { BucketFilterPushdownPass } from './bucket-filter-pushdown';
import { ComplexProjectionDeferralPass } from './complex-projection-deferral';
import { CoveredProjectionSynthesisPass } from './covered-projection-synthesis';
import { DeadAssignmentEliminationPass } from './dead-assignment-elimination';
import { ExprMatchNormalizationPass } from './expr-match-normalization';
import { ExpressionSimplificationPass } from './expression-simplification';
import { FacetPrefixHoistingPass } from './facet-prefix-hoisting';
import { FilterOptimizationPass } from './filter-optimization';
import { GroupFilterPushdownPass } from './group-filter-pushdown';
import { LimitSkipCoalescingPass } from './limit-skip-coalescing';
import { MatchPushdownPass } from './match-pushdown';
import { HeuristicMatchPushdownPass } from './heuristic-match-pushdown';
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
    'expression-simplification',
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
    'facet-prefix-hoisting',
    'stage-priority-reorder',
    'redundant-projection-elimination',
    'covered-projection-synthesis',
    'dead-assignment-elimination',
] as const);

export type PipelineTransformationId =
    typeof registeredPipelineTransformationIds[number];

const activePipelineTransformationIds: readonly PipelineTransformationId[] = Object.freeze([
    'filter-optimization',
    'adjacent-match-merging',
    'group-filter-pushdown',
    'bucket-filter-pushdown',
    'unwind-prefilter',
    'redundant-sort-elimination',
    'sort-by-count-simplification',
    'limit-skip-coalescing',
    'expression-simplification',
    'match-pushdown',
    'heuristic-match-pushdown',
    'limit-advance',
    'add-field-pushdown',
    'top-k-pushdown',
    'unused-field-pruning',
    'covered-projection-synthesis',
    'dead-assignment-elimination',
    'adjacent-project-merging',
    'adjacent-add-field-merging',
    'lookup-delay',
    'redundant-lookup-elimination',
    'sort-project-commute',
    'complex-projection-deferral',
    'facet-prefix-hoisting'
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
    'bucket-filter-pushdown': () => new BucketFilterPushdownPass(),
    'unwind-prefilter': () => new UnwindPrefilterPass(),
    'redundant-sort-elimination': () => new RedundantSortEliminationPass(),
    'sort-by-count-simplification': () => new SortByCountSimplificationPass(),
    'limit-skip-coalescing': () => new LimitSkipCoalescingPass(),
    'expression-simplification': () => new ExpressionSimplificationPass(),
    'match-pushdown': () => new MatchPushdownPass(),
    'heuristic-match-pushdown': () => new HeuristicMatchPushdownPass(),
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

const STAGE_TYPE_BITS: Readonly<Record<string, number>> = Object.freeze({
    $match          : 1 << 0,
    $project        : 1 << 1,
    $addFields      : 1 << 2,
    $set            : 1 << 3,
    $unset          : 1 << 4,
    $group          : 1 << 5,
    $sort           : 1 << 6,
    $limit          : 1 << 7,
    $skip           : 1 << 8,
    $lookup         : 1 << 9,
    $unwind         : 1 << 10,
    $bucket         : 1 << 11,
    $bucketAuto     : 1 << 12,
    $count          : 1 << 13,
    $sortByCount    : 1 << 14,
    $facet          : 1 << 15,
    $unionWith      : 1 << 16,
    $replaceRoot    : 1 << 17,
    $replaceWith    : 1 << 18
});

const STAGE_UNKNOWN_BIT = 1 << 30;
const passMaskCache = new WeakMap<PipelinePass, number>();

function getPassStageMask( pass: PipelinePass ): number
{
    const cached = passMaskCache.get( pass );

    if( cached !== undefined ){ return cached }

    if( !pass.stageTypes || pass.stageTypes.length === 0 )
    {
        passMaskCache.set( pass, 0 );

        return 0;
    }

    let mask = 0;

    for( const t of pass.stageTypes )
    {
        mask |= STAGE_TYPE_BITS[ t ] ?? STAGE_UNKNOWN_BIT;
    }

    passMaskCache.set( pass, mask );

    return mask;
}

function collectStageMask( pipeline: readonly any[] ): number
{
    let mask = 0;

    for( let i = 0; i < pipeline.length; i++ )
    {
        const stage = pipeline[ i ];

        if( isPlainObject( stage ))
        {
            for( const key in stage )
            {
                if( key.startsWith( '$' ))
                {
                    mask |= STAGE_TYPE_BITS[ key ] ?? STAGE_UNKNOWN_BIT;
                }
            }
        }
    }

    return mask;
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
    readonly pipeline  : any[];
    readonly modified  : boolean;
    readonly converged : boolean;
}

const convergedSubpipelinesByContext = new WeakMap<GuaranteeContext, WeakSet<readonly any[]>>();

function getConvergedSubpipelineSet( context: GuaranteeContext ): WeakSet<readonly any[]>
{
    let set = convergedSubpipelinesByContext.get( context );

    if( set === undefined )
    {
        set = new WeakSet<readonly any[]>();
        convergedSubpipelinesByContext.set( context, set );
    }

    return set;
}

function sweepChildSubpipeline(
    subpipeline : any[],
    passes      : readonly PipelinePass[],
    context     : GuaranteeContext
): any[]
{
    const convergedSet = passes === activePipelinePasses
        ? getConvergedSubpipelineSet( context )
        : undefined;

    if( convergedSet !== undefined && convergedSet.has( subpipeline ))
    {
        return subpipeline;
    }

    const sweepResult = applyGlobalSweepWithDirty( subpipeline, passes, context );

    if( !sweepResult.modified || pipelinesShallowEqual( sweepResult.pipeline, subpipeline ))
    {
        if( convergedSet !== undefined )
        {
            convergedSet.add( subpipeline );
        }

        return subpipeline;
    }

    return sweepResult.pipeline;
}

function optimizeStageChildrenForSweep(
    stage   : any,
    passes  : readonly PipelinePass[],
    context : GuaranteeContext
): any
{
    if( !isPlainObject( stage ))
    {
        return stage;
    }

    if( !( '$facet' in stage ) && !( '$lookup' in stage ) && !( '$unionWith' in stage ))
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
                const optimizedSub = sweepChildSubpipeline( subpipeline, passes, context );

                if( optimizedSub !== subpipeline )
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
        const optimizedLookupPipeline = sweepChildSubpipeline( lookup.pipeline, passes, context );

        if( optimizedLookupPipeline !== lookup.pipeline )
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
        const optimizedUnionPipeline = sweepChildSubpipeline( unionWith.pipeline, passes, context );

        if( optimizedUnionPipeline !== unionWith.pipeline )
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
    let nonFilterModified = false;
    let current = pipeline;

    for( let i = 0; i < pipeline.length; i++ )
    {
        const origStage = pipeline[ i ];
        const optStage = optimizeStageChildrenForSweep( origStage, passes, context );

        if( optStage !== origStage )
        {
            if( current === pipeline )
            {
                current = [ ...pipeline ];
            }

            current[ i ] = optStage;
            modified = true;
            nonFilterModified = true;
        }
    }

    let stageMask = collectStageMask( current );

    for( let pIdx = 0; pIdx < passes.length; pIdx++ )
    {
        const pass = passes[ pIdx ]!;
        const passMask = getPassStageMask( pass );

        if( passMask !== 0 && ( stageMask & passMask ) === 0 )
        {
            continue;
        }

        const next = pass.execute( current, context );

        if( !pipelinesShallowEqual( current, next ))
        {
            modified = true;

            if( pIdx > 0 || pass.name !== 'filter-optimization' )
            {
                nonFilterModified = true;
            }

            current = next;
            stageMask = collectStageMask( current );
        }
    }

    if(( stageMask & STAGE_TYPE_BITS.$unionWith! ) !== 0 )
    {
        const withoutDeadUnionWith = current.filter(( stage ) => !isDeadUnionWithStage( stage, context ));

        if( withoutDeadUnionWith.length !== current.length )
        {
            current = withoutDeadUnionWith;
            modified = true;
            nonFilterModified = true;
        }
    }

    if(( stageMask & STAGE_TYPE_BITS.$match! ) !== 0 )
    {
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
                        nonFilterModified = true;
                    }

                    break;
                }
            }
        }
    }

    return {
        pipeline  : current,
        modified,
        converged : !nonFilterModified && passes === activePipelinePasses
    };
}

function isDeadUnionWithStage( stage: any, context: GuaranteeContext ): boolean
{
    if( context.strictErrors || !stage || typeof stage !== 'object' || Array.isArray( stage ))
    {
        return false;
    }

    const unionWith = stage.$unionWith;

    if(
        !unionWith
        || typeof unionWith !== 'object'
        || Array.isArray( unionWith )
        || typeof unionWith.coll !== 'string'
        || unionWith.coll.length === 0
        || !Array.isArray( unionWith.pipeline )
        || unionWith.pipeline.length === 0
    )
    {
        return false;
    }

    const firstSubStage = unionWith.pipeline[ 0 ];

    return Boolean(
        firstSubStage
        && typeof firstSubStage === 'object'
        && !Array.isArray( firstSubStage )
        && firstSubStage.$match
        && isFilterContradiction( firstSubStage.$match )
        && !hasUnionWithAfter( unionWith.pipeline, 0 )
    );
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
    if( !Array.isArray( pipeline ) || hasCycle( pipeline ))
    {
        return pipeline;
    }

    const currentInitial = [ ...pipeline ];

    if( passes.length === 0 )
    {
        return currentInitial;
    }

    if( !Number.isSafeInteger( sweepBudget ) || sweepBudget <= 0 )
    {
        return currentInitial;
    }

    let current: any[] = currentInitial;

    try
    {
        const context = resolvePipelineGuarantees( pipeline, options );
        const history: any[][] = [ current ];

        for( let sweep = 0; sweep < sweepBudget; sweep++ )
        {
            const sweepResult = applyGlobalSweepWithDirty(
                current,
                passes,
                context
            );

            if( !sweepResult.modified || ( sweepResult.converged && sweep + 1 < sweepBudget ))
            {
                return sweepResult.pipeline;
            }

            const next = sweepResult.pipeline;

            if( isEqual( current, next ))
            {
                return next;
            }

            if( sweep > 0 && containsValue( history, next ))
            {
                return [ ...pipeline ];
            }

            history.push( next );
            current = next;
        }

        return [ ...pipeline ];
    }
    catch
    {
        return [ ...pipeline ];
    }
}

const activePipelinePasses: readonly PipelinePass[] = Object.freeze(
    resolveCandidatePasses( activePipelineTransformationIds )
);

const defaultCandidatePipelinePasses: readonly PipelinePass[] = Object.freeze(
    resolveCandidatePasses( candidatePipelineProfile )
);

export function optimizePipelineWithProductionRegistry( pipeline: any, options?: OptimizerOptions ): any
{
    return optimizePipelineWithPasses(
        pipeline,
        activePipelinePasses,
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
    const passes = selectedTransformationIds === candidatePipelineProfile
        ? defaultCandidatePipelinePasses
        : resolveCandidatePasses(selectedTransformationIds);
    const run = () => optimizePipelineWithPasses( pipeline, passes, DEFAULT_GLOBAL_SWEEP_BUDGET, options );

    if (selectedFilterRuleIds)
    {
        return withCandidateFilterRuleProfile(run, selectedFilterRuleIds);
    }

    return withCandidateFilterRuleProfile(run);
}
