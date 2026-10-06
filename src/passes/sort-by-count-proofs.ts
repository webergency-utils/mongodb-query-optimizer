import { deepClone, isEmptyObject, isPlainObject } from '../utils.js';
import { getStageSpec } from './helpers.js';

export interface SortByCountSimplificationProof
{
    sortByCountStage: { $sortByCount: any }
}

export function proveSortByCountSimplification(
    currentStage : unknown,
    nextStage    : unknown
): SortByCountSimplificationProof | null
{
    const groupSpec = getStageSpec<Record<string, any>>( currentStage, '$group' );
    const sortSpec = getStageSpec<Record<string, any>>( nextStage, '$sort' );

    if( !groupSpec || !sortSpec )
    {
        return null;
    }

    const groupFieldKeys = Object.keys( groupSpec );
    if( groupFieldKeys.length !== 2 )
    {
        return null;
    }

    if( !( '_id' in groupSpec ) || !( 'count' in groupSpec ))
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
        && isEmptyObject( countAcc.$count )
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
        sortByCountStage : {
            $sortByCount : deepClone( groupSpec._id )
        }
    };
}
