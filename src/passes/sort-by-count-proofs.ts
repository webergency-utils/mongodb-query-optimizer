import { deepClone } from '../utils.js';

export interface SortByCountSimplificationProof
{
    sortByCountStage: { $sortByCount: any }
}

function isPlainObject( value: unknown ): value is Record<string, any>
{
    if( !value || typeof value !== 'object' || Array.isArray( value ))
    {
        return false;
    }
    const proto = Object.getPrototypeOf( value );

    return proto === Object.prototype || proto === null;
}

export function proveSortByCountSimplification(
    currentStage: unknown,
    nextStage: unknown
): SortByCountSimplificationProof | null
{
    if( !isPlainObject( currentStage ) || !isPlainObject( nextStage ))
    {
        return null;
    }

    const currentKeys = Object.keys( currentStage );
    if( currentKeys.length !== 1 || currentKeys[0] !== '$group' )
    {
        return null;
    }

    const nextKeys = Object.keys( nextStage );
    if( nextKeys.length !== 1 || nextKeys[0] !== '$sort' )
    {
        return null;
    }

    const groupSpec = currentStage.$group;
    const sortSpec = nextStage.$sort;

    if( !isPlainObject( groupSpec ) || !isPlainObject( sortSpec ))
    {
        return null;
    }

    const groupFieldKeys = Object.keys( groupSpec );
    if( groupFieldKeys.length !== 2 )
    {
        return null;
    }

    if( !('_id' in groupSpec) || !('count' in groupSpec ))
    {
        return null;
    }

    const countAcc = groupSpec.count;
    if( !isPlainObject( countAcc ))
    {
        return null;
    }

    const isSumOne = countAcc.$sum === 1;
    const isCountEmpty = (
        '$count' in countAcc
        && isPlainObject( countAcc.$count )
        && Object.keys( countAcc.$count ).length === 0
    );

    if( !isSumOne && !isCountEmpty )
    {
        return null;
    }

    const sortFieldKeys = Object.keys( sortSpec );
    if( sortFieldKeys.length !== 1 || sortFieldKeys[0] !== 'count' )
    {
        return null;
    }

    if( sortSpec.count !== -1 )
    {
        return null;
    }

    return {
        sortByCountStage: {
            $sortByCount: deepClone( groupSpec._id )
        }
    };
}
