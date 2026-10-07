import { analyzeStage } from '../analyzer/semantics.js';
import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { isPlainObject } from '../utils.js';
import { canMoveStageAcrossStage, pipelineReadsFieldOrder } from './guarantee-guards.js';
import { getSingleStageEntry } from './helpers.js';
import
{
    allocateShadowFieldName,
    arePathsDisjoint,
    findShadowTargetIndex,
    rangeHasCostlyStage,
    resolveShadowProviders,
    validateShadowRange
}
from './shadow-proofs.js';

export { arePathsDisjoint, collectExpressionDependencies, isExpressionCompletelyDeterministic } from './shadow-proofs.js';

export interface TopKPushdownProof
{
    readonly sortIndex   : number;
    readonly targetIndex : number;
    readonly sliceLength : number;
}

export interface HeuristicTopKPushdownProof
{
    readonly sortIndex        : number;
    readonly sliceLength      : number;
    readonly targetIndex      : number;
    readonly shadowAddFields  : Record<string, unknown>;
    readonly shadowSortSpec   : Record<string, unknown>;
    readonly shadowUnsetKeys  : readonly string[];
}

const TOP_K_PASSIVE_OPERATORS = new Set([
    '$lookup',
    '$addFields',
    '$set',
    '$unset'
]);

export function parseSafeSortKeys( sortStage: unknown ): string[] | null
{
    const entry = getSingleStageEntry( sortStage );

    if(
        !entry
        || entry[ 0 ] !== '$sort'
        || !isPlainObject( entry[ 1 ] )
    )
    {
        return null;
    }

    const sortSpec = entry[ 1 ];
    const keys = Object.keys( sortSpec );

    if(
        keys.length === 0
        || Object.values( sortSpec ).some(
            ( direction ) => direction !== 1 && direction !== -1
        )
    )
    {
        return null;
    }

    return keys;
}

export function parseTopKFollower(
    pipeline  : readonly any[],
    sortIndex : number
): { sliceLength: number } | null
{
    if( sortIndex + 1 >= pipeline.length )
    {
        return null;
    }

    const firstFollower = pipeline[ sortIndex + 1 ];
    const firstEntry = getSingleStageEntry( firstFollower );

    if( !firstEntry )
    {
        return null;
    }

    if( firstEntry[ 0 ] === '$limit' )
    {
        const limitVal = firstEntry[ 1 ];

        if( typeof limitVal === 'number' && Number.isSafeInteger( limitVal ) && limitVal > 0 )
        {
            return { sliceLength: 2 };
        }

        return null;
    }

    if( firstEntry[ 0 ] === '$skip' && sortIndex + 2 < pipeline.length )
    {
        const skipVal = firstEntry[ 1 ];

        if( typeof skipVal === 'number' && Number.isSafeInteger( skipVal ) && skipVal >= 0 )
        {
            const secondFollower = pipeline[ sortIndex + 2 ];
            const secondEntry = getSingleStageEntry( secondFollower );

            if( secondEntry && secondEntry[ 0 ] === '$limit' )
            {
                const limitVal = secondEntry[ 1 ];

                if( typeof limitVal === 'number' && Number.isSafeInteger( limitVal ) && limitVal > 0 )
                {
                    return { sliceLength: 3 };
                }
            }
        }
    }

    return null;
}

export function canTopKPushAcrossStage(
    stage              : unknown,
    sortKeys           : readonly string[],
    context            : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT,
    downstreamPipeline : readonly unknown[] = []
): boolean
{
    const entry = getSingleStageEntry( stage );

    if( !entry || !TOP_K_PASSIVE_OPERATORS.has( entry[ 0 ] ))
    {
        return false;
    }

    const sortStage = { $sort: Object.fromEntries( sortKeys.map(( k ) => [ k, 1 ] )) };

    if( !canMoveStageAcrossStage( sortStage, stage, 'earlier', context, downstreamPipeline ))
    {
        return false;
    }

    const semantics = analyzeStage( stage );

    if(
        semantics.unknown
        || semantics.malformed
        || semantics.cardinality !== 'preserves'
        || semantics.order !== 'preserves'
    )
    {
        return false;
    }

    if(
        !arePathsDisjoint( semantics.writes, sortKeys )
        || !arePathsDisjoint( semantics.modifies, sortKeys )
        || !arePathsDisjoint( semantics.removes, sortKeys )
    )
    {
        return false;
    }

    return true;
}

export function proveTopKPushdown(
    pipeline  : readonly any[],
    sortIndex : number,
    context   : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): TopKPushdownProof | null
{
    if( sortIndex <= 0 || sortIndex >= pipeline.length )
    {
        return null;
    }

    const sortKeys = parseSafeSortKeys( pipeline[ sortIndex ] );

    if( !sortKeys )
    {
        return null;
    }

    const follower = parseTopKFollower( pipeline, sortIndex );

    if( !follower )
    {
        return null;
    }

    const downstreamPipeline = pipeline.slice( sortIndex + 1 );
    let targetIndex = sortIndex;

    for( let i = sortIndex - 1; i >= 0; i-- )
    {
        if( !canTopKPushAcrossStage( pipeline[ i ], sortKeys, context, downstreamPipeline ))
        {
            break;
        }

        targetIndex = i;
    }

    if( targetIndex === sortIndex )
    {
        return null;
    }

    return {
        sortIndex,
        targetIndex,
        sliceLength: follower.sliceLength
    };
}

export function proveHeuristicTopKPushdown(
    pipeline   : readonly any[],
    sortIndex  : number,
    context    : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): HeuristicTopKPushdownProof | null
{
    if( sortIndex <= 0 || sortIndex >= pipeline.length || context.strictFieldOrder )
    {
        return null;
    }

    const follower = parseTopKFollower( pipeline, sortIndex );
    const sortKeys = parseSafeSortKeys( pipeline[ sortIndex ] );

    if( !follower || !sortKeys || pipelineReadsFieldOrder( pipeline.slice( sortIndex + 1 )))
    {
        return null;
    }

    const providers = resolveShadowProviders( pipeline, sortIndex, sortKeys, context );

    if( !providers )
    {
        return null;
    }

    const targetIndex = findShadowTargetIndex( pipeline, providers, context, false );

    if(
        targetIndex === null
        || !validateShadowRange( pipeline, targetIndex, sortIndex, providers, context, false )
        || !rangeHasCostlyStage( pipeline, targetIndex, sortIndex, providers )
    )
    {
        return null;
    }

    const sortSpec = getSingleStageEntry( pipeline[ sortIndex ] )![ 1 ] as Record<string, unknown>;
    const shadowAddFields: Record<string, unknown> = {};
    const shadowSortSpec: Record<string, unknown> = {};
    const shadowUnsetKeys: string[] = [];

    for( const key of sortKeys )
    {
        const computed = providers.computed.get( key );

        if( !computed )
        {
            shadowSortSpec[ key ] = sortSpec[ key ];
            continue;
        }

        const shadowKey = allocateShadowFieldName( pipeline, key, new Set( shadowUnsetKeys ));

        shadowAddFields[ shadowKey ] = computed.expr;
        shadowSortSpec[ shadowKey ] = sortSpec[ key ];
        shadowUnsetKeys.push( shadowKey );
    }

    return {
        sortIndex,
        sliceLength: follower.sliceLength,
        targetIndex,
        shadowAddFields,
        shadowSortSpec,
        shadowUnsetKeys
    };
}

