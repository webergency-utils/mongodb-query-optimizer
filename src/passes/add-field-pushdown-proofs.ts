import { analyzeExpression } from '../analyzer/expressions.js';
import { relatePaths } from '../analyzer/paths.js';
import { analyzeStage } from '../analyzer/semantics.js';
import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { isPlainObject } from '../utils.js';
import { canMoveStageAcrossStage } from './guarantee-guards.js';
import { getSingleStageEntry } from './helpers.js';

export interface AddFieldPushdownProof
{
    readonly sourceIndex     : number;
    readonly targetIndex     : number;
    readonly operator        : '$addFields' | '$set';
    readonly pushedFields    : Record<string, unknown>;
    readonly remainingFields : Record<string, unknown> | null;
}

const PASSIVE_PRECEDING_OPERATORS = new Set([
    '$lookup',
    '$unset'
]);

export function arePathsDisjoint(
    left  : Iterable<string>,
    right : Iterable<string>
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

export function canPushFieldAcrossStage(
    fieldKey           : string,
    expression         : unknown,
    precedingStage     : unknown,
    context            : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT,
    downstreamPipeline : readonly unknown[] = []
): boolean
{
    const precedingEntry = getSingleStageEntry( precedingStage );

    if( !precedingEntry || !PASSIVE_PRECEDING_OPERATORS.has( precedingEntry[ 0 ] ))
    {
        return false;
    }

    const movingStage = { $addFields: { [ fieldKey ]: expression } };

    if( !canMoveStageAcrossStage( movingStage, precedingStage, 'earlier', context, downstreamPipeline ))
    {
        return false;
    }

    const precedingSemantics = analyzeStage( precedingStage );

    if( precedingSemantics.malformed )
    {
        return false;
    }

    if(
        precedingSemantics.dependencies.unknown
        || precedingSemantics.dependencies.local.has( '*' )
    )
    {
        return false;
    }

    const exprSummary = analyzeExpression( expression );

    if(
        exprSummary.unknown
        || exprSummary.dependencies.unknown
        || exprSummary.dependencies.local.has( '*' )
    )
    {
        return false;
    }

    if(
        !arePathsDisjoint( exprSummary.dependencies.local, precedingSemantics.writes )
        || !arePathsDisjoint( exprSummary.dependencies.local, precedingSemantics.modifies )
        || !arePathsDisjoint( exprSummary.dependencies.local, precedingSemantics.removes )
    )
    {
        return false;
    }

    const fieldKeyList = [ fieldKey ];

    if(
        !arePathsDisjoint( fieldKeyList, precedingSemantics.dependencies.local )
        || !arePathsDisjoint( fieldKeyList, precedingSemantics.writes )
        || !arePathsDisjoint( fieldKeyList, precedingSemantics.modifies )
        || !arePathsDisjoint( fieldKeyList, precedingSemantics.removes )
    )
    {
        return false;
    }

    return true;
}

export function collectDownstreamDemandedKeys(
    pipeline  : readonly any[],
    fromIndex : number
): Set<string>
{
    const demanded = new Set<string>();

    for( let i = fromIndex + 1; i < pipeline.length; i++ )
    {
        const stage = pipeline[ i ];
        const entry = getSingleStageEntry( stage );

        if( !entry ){ continue; }

        if( entry[ 0 ] === '$sort' && isPlainObject( entry[ 1 ] ))
        {
            for( const sortKey of Object.keys( entry[ 1 ] ))
            {
                demanded.add( sortKey );
            }
        }
        else if( entry[ 0 ] === '$match' )
        {
            const semantics = analyzeStage( stage );

            if( !semantics.dependencies.unknown )
            {
                for( const path of semantics.dependencies.local )
                {
                    demanded.add( path );
                }
            }
        }
    }

    return demanded;
}

export function proveAddFieldPushdown(
    pipeline   : readonly any[],
    stageIndex : number,
    context    : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): AddFieldPushdownProof | null
{
    if( stageIndex <= 0 || stageIndex >= pipeline.length )
    {
        return null;
    }

    const currentStage = pipeline[ stageIndex ];
    const entry = getSingleStageEntry( currentStage );

    if(
        !entry
        || ( entry[ 0 ] !== '$addFields' && entry[ 0 ] !== '$set' )
        || !isPlainObject( entry[ 1 ] )
    )
    {
        return null;
    }

    const operator = entry[ 0 ] as '$addFields' | '$set';
    const spec = entry[ 1 ];
    const allKeys = Object.keys( spec );

    if( allKeys.length === 0 )
    {
        return null;
    }

    const demandedKeys = collectDownstreamDemandedKeys( pipeline, stageIndex );

    if( demandedKeys.size === 0 )
    {
        return null;
    }

    const candidateKeys = allKeys.filter(( key ) => demandedKeys.has( key ));

    if( candidateKeys.length === 0 )
    {
        return null;
    }

    const downstreamPipeline = pipeline.slice( stageIndex + 1 );
    let furthestTarget = stageIndex;
    const pushableKeys: string[] = [];

    for( const key of candidateKeys )
    {
        const expr = spec[ key ];
        let target = stageIndex;

        for( let i = stageIndex - 1; i >= 0; i-- )
        {
            if( !canPushFieldAcrossStage( key, expr, pipeline[ i ], context, downstreamPipeline ))
            {
                break;
            }

            target = i;
        }

        if( target < stageIndex )
        {
            pushableKeys.push( key );

            if( target < furthestTarget )
            {
                furthestTarget = target;
            }
        }
    }

    if( pushableKeys.length === 0 )
    {
        return null;
    }

    const validPushKeys: string[] = [];

    for( const key of pushableKeys )
    {
        const expr = spec[ key ];
        let canReachFurthest = true;

        for( let i = stageIndex - 1; i >= furthestTarget; i-- )
        {
            if( !canPushFieldAcrossStage( key, expr, pipeline[ i ], context, downstreamPipeline ))
            {
                canReachFurthest = false;

                break;
            }
        }

        if( canReachFurthest )
        {
            validPushKeys.push( key );
        }
    }

    const pushedFields: Record<string, unknown> = {};

    for( const key of validPushKeys )
    {
        pushedFields[ key ] = spec[ key ];
    }

    const remainingKeys = allKeys.filter(( key ) => !validPushKeys.includes( key ));
    let remainingFields: Record<string, unknown> | null = null;

    if( remainingKeys.length > 0 )
    {
        for( const remKey of remainingKeys )
        {
            const remExpr = spec[ remKey ];
            const remExprSummary = analyzeExpression( remExpr );

            if(
                remExprSummary.unknown
                || remExprSummary.dependencies.unknown
                || remExprSummary.dependencies.local.has( '*' )
            )
            {
                return null;
            }

            if( !arePathsDisjoint( remExprSummary.dependencies.local, validPushKeys ))
            {
                return null;
            }
        }

        remainingFields = {};

        for( const key of remainingKeys )
        {
            remainingFields[ key ] = spec[ key ];
        }
    }

    return {
        sourceIndex: stageIndex,
        targetIndex: furthestTarget,
        operator,
        pushedFields,
        remainingFields
    };
}
