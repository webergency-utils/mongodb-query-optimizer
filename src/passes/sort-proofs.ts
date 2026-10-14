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
    '$lookup',
    '$unwind'
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

export function isDeadSortBeforeSample( currentStage: unknown, nextStage: unknown ): boolean
{
    const sortSpec = getStageSpec( currentStage, '$sort' );
    if( !sortSpec ){ return false }

    const sampleSpec = getStageSpec<Record<string, any>>( nextStage, '$sample' );
    if( !sampleSpec ){ return false }

    return (
        typeof sampleSpec.size === 'number'
        && Number.isSafeInteger( sampleSpec.size )
        && sampleSpec.size >= 0
    );
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

    if( isDeadSortBeforeSample( currentStage, nextStage )){ return true }

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

    let crossedUnwind = false;

    for( let j = sortIndex + 1; j < pipeline.length; j++ )
    {
        const candidate = pipeline[ j ];

        if(
            j > sortIndex + 1
            && !crossedUnwind
            && isAdjacentSort( currentStage, candidate )
            && proveRedundantDownstreamSortInPipeline( pipeline, j, context )
        )
        {
            return false;
        }

        const isKilledByCandidate = crossedUnwind
            ? (
                isDeadSortBeforeGroup( currentStage, candidate )
                || isDeadSortBeforeBucket( currentStage, candidate )
                || isDeadSortBeforeCount( currentStage, candidate )
                || isDeadSortBeforeSortByCount( currentStage, candidate )
                || isDeadSortBeforeSample( currentStage, candidate )
            )
            : proveRedundantSortElimination( currentStage, candidate, context );

        if( isKilledByCandidate )
        {
            return true;
        }

        if( !isOrderInsensitiveIntermediateStage( candidate, context ))
        {
            return false;
        }

        if( getSingleStageEntry( candidate )![ 0 ] === '$unwind' )
        {
            crossedUnwind = true;
        }
    }

    return false;
}

function parseNumericSortEntries( stage: unknown ): Array<[ string, 1 | -1 ]> | null
{
    const sortSpec = getStageSpec<Record<string, any>>( stage, '$sort' );
    if( !sortSpec ){ return null }

    const entries = Object.entries( sortSpec );
    if( entries.length === 0 ){ return null }

    const result: Array<[ string, 1 | -1 ]> = [];

    for( const [ key, dir ] of entries )
    {
        if( dir !== 1 && dir !== -1 ){ return null }
        result.push([ key, dir ]);
    }

    return result;
}

function doesStageTouchSortField(
    semantics : ReturnType<typeof analyzeStage>,
    sortKey   : string
): boolean
{
    if( semantics.projection && semantics.projection.mode === 'inclusion' )
    {
        const rootField = sortKey.split( '.' )[ 0 ]!;
        const kept = (
            semantics.projection.includedPaths.has( sortKey )
            || semantics.projection.includedPaths.has( rootField )
            || ( rootField === '_id' && semantics.projection.id !== 'excluded' )
        );
        if( !kept ){ return true }
    }

    const touchedSets = [
        semantics.modifies,
        semantics.removes
    ];

    for( const fieldSet of touchedSets )
    {
        for( const touched of fieldSet )
        {
            if(
                touched === sortKey
                || sortKey.startsWith( `${ touched }.` )
                || touched.startsWith( `${ sortKey }.` )
            )
            {
                return true;
            }
        }
    }

    return false;
}

export function proveRedundantDownstreamSortInPipeline(
    pipeline  : readonly unknown[],
    sortIndex : number,
    context?  : GuaranteeContext
): boolean
{
    const currentStage = pipeline[ sortIndex ];
    if( context && !canRemoveStage( currentStage, context ))
    {
        return false;
    }

    const downstreamEntries = parseNumericSortEntries( currentStage );
    if( !downstreamEntries )
    {
        return false;
    }

    for( let i = sortIndex - 1; i >= 0; i-- )
    {
        const earlierStage = pipeline[ i ];
        const earlierEntries = parseNumericSortEntries( earlierStage );

        if( earlierEntries )
        {
            if( earlierEntries.length < downstreamEntries.length )
            {
                return false;
            }

            for( let k = 0; k < downstreamEntries.length; k++ )
            {
                if(
                    earlierEntries[ k ]![ 0 ] !== downstreamEntries[ k ]![ 0 ]
                    || earlierEntries[ k ]![ 1 ] !== downstreamEntries[ k ]![ 1 ]
                )
                {
                    return false;
                }
            }

            return true;
        }

        const semantics = analyzeStage( earlierStage );
        const entry = getSingleStageEntry( earlierStage );

        if(
            !entry
            || entry[ 0 ] === '$unwind'
            || semantics.malformed
            || semantics.unknown
            || semantics.order !== 'preserves'
        )
        {
            return false;
        }

        for( const [ key ] of downstreamEntries )
        {
            if( doesStageTouchSortField( semantics, key ))
            {
                return false;
            }
        }
    }

    return false;
}
