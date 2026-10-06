import { relatePaths } from '../analyzer/paths.js';
import { projectionVisibility } from '../analyzer/projections.js';
import { analyzeStage } from '../analyzer/semantics.js';
import { isPlainObject } from '../utils.js';
import { getSingleStageEntry } from './helpers.js';

export interface TopKPushdownProof
{
    readonly sortIndex: number;
    readonly targetIndex: number;
    readonly sliceLength: number;
}

const TOP_K_PASSIVE_OPERATORS = new Set([
    '$lookup',
    '$addFields',
    '$set',
    '$unset',
]);

export function arePathsDisjoint(
    left: Iterable<string>,
    right: Iterable<string>
): boolean
{
    for( const leftPath of left )
    {
        for( const rightPath of right )
        {
            if( relatePaths( leftPath, rightPath ) !== 'disjoint' )
            {
                return false;
            }
        }
    }

    return true;
}

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
    pipeline: readonly any[],
    sortIndex: number
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
    stage: unknown,
    sortKeys: readonly string[]
): boolean
{
    const entry = getSingleStageEntry( stage );
    if( !entry || !TOP_K_PASSIVE_OPERATORS.has( entry[ 0 ] ))
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
    pipeline: readonly any[],
    sortIndex: number
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

    let targetIndex = sortIndex;
    for( let i = sortIndex - 1; i >= 0; i-- )
    {
        if( !canTopKPushAcrossStage( pipeline[ i ], sortKeys ))
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
        sliceLength: follower.sliceLength,
    };
}
