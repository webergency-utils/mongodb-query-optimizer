import { analyzeStage } from '../analyzer/semantics.js';
import { GuaranteeContext } from '../guarantees.js';
import { isEmptyObject, isPlainObject } from '../utils.js';
import { canRemoveStage } from './guarantee-guards.js';
import
{
    getSingleStageEntry,
    getStageSpec,
    isSingleKeyStage
}
from './helpers.js';

const ORDER_AGNOSTIC_ACCUMULATORS = new Set([
    '$sum',
    '$avg',
    '$min',
    '$max',
    '$count',
    '$stdDevPop',
    '$stdDevSamp'
]);

const ORDER_INSENSITIVE_INTERMEDIATE_OPERATORS = new Set([
    '$match',
    '$project',
    '$addFields',
    '$set',
    '$unset',
    '$lookup'
]);

export function isOrderAgnosticGroup( groupStage: unknown ): boolean
{
    const groupSpec = getStageSpec<Record<string, any>>( groupStage, '$group' );
    if( !groupSpec ){ return false }

    for( const [ key, val ] of Object.entries( groupSpec ))
    {
        if( key === '_id' ){ continue }

        if( !isPlainObject( val )){ return false }

        const opKeys = Object.keys( val );
        if( opKeys.length !== 1 ){ return false }

        const op = opKeys[0]!;
        if( !ORDER_AGNOSTIC_ACCUMULATORS.has( op )){ return false }
    }

    return true;
}

export function isEmptySort( stage: unknown ): boolean
{
    const sortSpec = getStageSpec<Record<string, any>>( stage, '$sort' );
    if( !sortSpec ){ return false }

    return isEmptyObject( sortSpec );
}

export function isAdjacentSort( currentStage: unknown, nextStage: unknown ): boolean
{
    const currentSort = getStageSpec<Record<string, any>>( currentStage, '$sort' );
    const nextSort = getStageSpec<Record<string, any>>( nextStage, '$sort' );

    return currentSort !== null && nextSort !== null;
}

export function isDeadSortBeforeGroup( currentStage: unknown, nextStage: unknown ): boolean
{
    const sortSpec = getStageSpec( currentStage, '$sort' );
    if( !sortSpec ){ return false }

    return isOrderAgnosticGroup( nextStage );
}

export function isDeadSortBeforeCount( currentStage: unknown, nextStage: unknown ): boolean
{
    const sortSpec = getStageSpec( currentStage, '$sort' );
    if( !sortSpec ){ return false }

    const entry = getSingleStageEntry( nextStage );
    if( !entry || entry[0] !== '$count' ){ return false }

    const countSpec = entry[1];

    return typeof countSpec === 'string' && countSpec.length > 0;
}

export function isOrderAgnosticBucket( bucketStage: unknown ): boolean
{
    const entry = getSingleStageEntry( bucketStage );
    if( !entry || ( entry[ 0 ] !== '$bucket' && entry[ 0 ] !== '$bucketAuto' ) || !isPlainObject( entry[ 1 ] ))
    {
        return false;
    }

    const spec = entry[ 1 ] as Record<string, any>;
    if( !( 'groupBy' in spec )){ return false }

    if( !( 'output' in spec )){ return true }

    if( !isPlainObject( spec.output )){ return false }

    for( const val of Object.values( spec.output ))
    {
        if( !isPlainObject( val )){ return false }

        const opKeys = Object.keys( val );
        if( opKeys.length !== 1 || !ORDER_AGNOSTIC_ACCUMULATORS.has( opKeys[ 0 ]! ))
        {
            return false;
        }
    }

    return true;
}

export function isDeadSortBeforeBucket( currentStage: unknown, nextStage: unknown ): boolean
{
    const sortSpec = getStageSpec( currentStage, '$sort' );
    if( !sortSpec ){ return false }

    return isOrderAgnosticBucket( nextStage );
}

export function isDeadSortBeforeSortByCount( currentStage: unknown, nextStage: unknown ): boolean
{
    const sortSpec = getStageSpec( currentStage, '$sort' );
    if( !sortSpec ){ return false }

    return isSingleKeyStage( nextStage, '$sortByCount' );
}

export function proveRedundantSortElimination(
    currentStage : unknown,
    nextStage    : unknown,
    context?     : GuaranteeContext
): boolean
{
    if( context && !canRemoveStage( currentStage, context ))
    {
        return false;
    }

    if( isAdjacentSort( currentStage, nextStage )){ return true }

    if( isDeadSortBeforeGroup( currentStage, nextStage )){ return true }

    if( isDeadSortBeforeBucket( currentStage, nextStage )){ return true }

    if( isDeadSortBeforeCount( currentStage, nextStage )){ return true }

    if( isDeadSortBeforeSortByCount( currentStage, nextStage )){ return true }

    return false;
}

function isOrderInsensitiveIntermediateStage(
    stage    : unknown,
    context? : GuaranteeContext
): boolean
{
    const entry = getSingleStageEntry( stage );

    if( !entry || !ORDER_INSENSITIVE_INTERMEDIATE_OPERATORS.has( entry[ 0 ] ))
    {
        return false;
    }

    const semantics = analyzeStage( stage );

    if(
        semantics.malformed
        || semantics.unknown
        || semantics.determinism !== 'deterministic'
        || semantics.observable.determinism !== 'deterministic'
        || semantics.order !== 'preserves'
        || ( context?.strictErrors && semantics.observable.errors !== 'none-known' )
    )
    {
        return false;
    }

    return true;
}

export function proveRedundantSortEliminationInPipeline(
    pipeline  : readonly unknown[],
    sortIndex : number,
    context?  : GuaranteeContext
): boolean
{
    const currentStage = pipeline[ sortIndex ];

    if( !getStageSpec( currentStage, '$sort' ) || ( context && !canRemoveStage( currentStage, context )))
    {
        return false;
    }

    for( let j = sortIndex + 1; j < pipeline.length; j++ )
    {
        const candidate = pipeline[ j ];

        if( proveRedundantSortElimination( currentStage, candidate, context ))
        {
            return true;
        }

        if( !isOrderInsensitiveIntermediateStage( candidate, context ))
        {
            return false;
        }
    }

    return false;
}
