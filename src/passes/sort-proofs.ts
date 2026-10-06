import { isEmptyObject, isPlainObject } from '../utils.js';
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

export function isDeadSortBeforeSortByCount( currentStage: unknown, nextStage: unknown ): boolean
{
    const sortSpec = getStageSpec( currentStage, '$sort' );
    if( !sortSpec ){ return false }

    return isSingleKeyStage( nextStage, '$sortByCount' );
}

export function proveRedundantSortElimination(
    currentStage : unknown,
    nextStage    : unknown
): boolean
{
    if( isAdjacentSort( currentStage, nextStage )){ return true }

    if( isDeadSortBeforeGroup( currentStage, nextStage )){ return true }

    if( isDeadSortBeforeCount( currentStage, nextStage )){ return true }

    if( isDeadSortBeforeSortByCount( currentStage, nextStage )){ return true }

    return false;
}
