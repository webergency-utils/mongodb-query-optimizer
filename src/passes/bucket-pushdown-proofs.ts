import { GuaranteeContext } from '../guarantees.js';
import { deepClone, isPlainObject } from '../utils.js';
import { isStageProvenErrorFree } from './guarantee-guards.js';
import
{
    combineConjuncts,
    decomposeFilterIntoConjuncts,
    getStageSpec
}
from './helpers.js';

export interface BucketFilterPushdownProof
{
    prefilterStage: { $match: Record<string, any> }
    postfilterStage: { $match: Record<string, any> } | null
}

function isOutsideBoundaryRange(
    defaultVal : unknown,
    minBound   : any,
    maxBound   : any
): boolean
{
    if(
        typeof defaultVal !== 'string'
        && typeof defaultVal !== 'number'
        && typeof defaultVal !== 'boolean'
    )
    {
        return false;
    }

    if( typeof defaultVal !== typeof minBound )
    {
        return true;
    }

    return ( defaultVal as any ) < minBound || ( defaultVal as any ) >= maxBound;
}

export function proveBucketFilterPushdown(
    bucketStage: unknown,
    matchStage: unknown,
    context?: GuaranteeContext
): BucketFilterPushdownProof | null
{
    if( context?.strictErrors && !isStageProvenErrorFree( bucketStage ))
    {
        return null;
    }

    const bucketSpec = getStageSpec<Record<string, any>>( bucketStage, '$bucket' );
    const matchSpec = getStageSpec<Record<string, any>>( matchStage, '$match' );

    if( !bucketSpec || !matchSpec )
    {
        return null;
    }

    const groupBy = bucketSpec.groupBy;
    if(
        typeof groupBy !== 'string'
        || !groupBy.startsWith( '$' )
        || groupBy.startsWith( '$$' )
        || groupBy.length <= 1
    )
    {
        return null;
    }

    const sourceField = groupBy.slice( 1 );
    const boundaries = bucketSpec.boundaries;

    if( !Array.isArray( boundaries ) || boundaries.length < 2 )
    {
        return null;
    }

    for( let k = 0; k < boundaries.length - 1; k++ )
    {
        if( boundaries[k] >= boundaries[k + 1] )
        {
            return null;
        }
    }

    const conjuncts = decomposeFilterIntoConjuncts( matchSpec );
    const idConjunctIndex = conjuncts.findIndex(( c ) => '_id' in c && Object.keys( c ).length === 1 );

    if( idConjunctIndex === -1 )
    {
        const orConjunctIndex = conjuncts.findIndex(
            ( c ) => '$or' in c && Object.keys( c ).length === 1 && Array.isArray( c.$or ) && c.$or.length > 0
        );

        if( orConjunctIndex === -1 )
        {
            return null;
        }

        const orBranches = conjuncts[ orConjunctIndex ]!.$or as unknown[];
        const pushedBranches: Record<string, any>[] = [];

        for( const branch of orBranches )
        {
            if( !isPlainObject( branch ))
            {
                return null;
            }

            const branchProof = proveBucketFilterPushdown( bucketStage, { $match: branch }, context );
            if( !branchProof || branchProof.postfilterStage !== null )
            {
                return null;
            }

            pushedBranches.push( branchProof.prefilterStage.$match );
        }

        const remainingOrConjuncts = conjuncts
            .filter(( _c, idx ) => idx !== orConjunctIndex )
            .map(( c ) => deepClone( c ));

        return {
            prefilterStage: { $match: { $or: pushedBranches } },
            postfilterStage: remainingOrConjuncts.length > 0
                ? { $match: combineConjuncts( remainingOrConjuncts ) }
                : null
        };
    }

    const idCondition = conjuncts[ idConjunctIndex ]!._id;
    let prefilterCondition: Record<string, any> | null = null;
    let prefilterDisjunction: Array<Record<string, any>> | null = null;
    let retainIdInPostfilter = false;

    if(
        typeof idCondition === 'number'
        || typeof idCondition === 'string'
        || typeof idCondition === 'boolean'
    )
    {
        const k = boundaries.indexOf( idCondition );
        if( k === -1 || k >= boundaries.length - 1 )
        {
            return null;
        }

        prefilterCondition = {
            $gte: boundaries[k],
            $lt: boundaries[k + 1]
        };
    }
    else if(
        isPlainObject( idCondition )
        && '$eq' in idCondition
        && Object.keys( idCondition ).length === 1
    )
    {
        const k = boundaries.indexOf( idCondition.$eq );
        if( k === -1 || k >= boundaries.length - 1 )
        {
            return null;
        }

        prefilterCondition = {
            $gte: boundaries[k],
            $lt: boundaries[k + 1]
        };
    }
    else if(
        isPlainObject( idCondition )
        && '$ne' in idCondition
        && Object.keys( idCondition ).length === 1
        && bucketSpec.default !== undefined
        && idCondition.$ne === bucketSpec.default
        && isOutsideBoundaryRange( bucketSpec.default, boundaries[ 0 ], boundaries[ boundaries.length - 1 ] )
    )
    {
        prefilterCondition = {
            $gte: boundaries[ 0 ],
            $lt: boundaries[ boundaries.length - 1 ]
        };
    }
    else if(
        isPlainObject( idCondition )
        && '$nin' in idCondition
        && Array.isArray( idCondition.$nin )
        && idCondition.$nin.length > 0
        && Object.keys( idCondition ).length === 1
        && bucketSpec.default !== undefined
        && idCondition.$nin.includes( bucketSpec.default )
        && isOutsideBoundaryRange( bucketSpec.default, boundaries[ 0 ], boundaries[ boundaries.length - 1 ] )
    )
    {
        prefilterCondition = {
            $gte: boundaries[ 0 ],
            $lt: boundaries[ boundaries.length - 1 ]
        };

        const hasValidBoundaryInNin = idCondition.$nin.some(( item: unknown ) =>
        {
            const k = boundaries.indexOf( item );
            return k !== -1 && k < boundaries.length - 1;
        });

        retainIdInPostfilter = hasValidBoundaryInNin;
    }
    else if(
        isPlainObject( idCondition )
        && '$in' in idCondition
        && Array.isArray( idCondition.$in )
        && idCondition.$in.length > 0
        && Object.keys( idCondition ).length === 1
    )
    {
        const inValues: any[] = idCondition.$in;
        const indices: number[] = [];

        for( const item of inValues )
        {
            const k = boundaries.indexOf( item );
            if( k === -1 || k >= boundaries.length - 1 )
            {
                return null;
            }

            indices.push( k );
        }

        const sortedUnique = Array.from( new Set( indices )).sort( ( a, b ) => a - b );
        const isContiguous = sortedUnique.every(
            ( val, idx ) => idx === 0 || val === sortedUnique[idx - 1] + 1
        );

        if( isContiguous )
        {
            const firstIdx = sortedUnique[0];
            const lastIdx = sortedUnique[sortedUnique.length - 1];

            prefilterCondition = {
                $gte: boundaries[firstIdx],
                $lt: boundaries[lastIdx + 1]
            };
        }
        else
        {
            prefilterDisjunction = sortedUnique.map( ( idx ) => ({
                [sourceField]: {
                    $gte: boundaries[idx],
                    $lt: boundaries[idx + 1]
                }
            }));
        }
    }
    else if(
        isPlainObject( idCondition )
        && bucketSpec.default === undefined
        && Object.keys( idCondition ).length > 0
        && Object.entries( idCondition ).every(
            ([ op, bound ]) =>
                ( op === '$gt' || op === '$gte' || op === '$lt' || op === '$lte' )
                && typeof bound === typeof boundaries[ 0 ]
        )
    )
    {
        const matchingIndices: number[] = [];

        for( let k = 0; k < boundaries.length - 1; k++ )
        {
            const b = boundaries[ k ];
            const matches =
                ( !( '$gt' in idCondition ) || b > idCondition.$gt )
                && ( !( '$gte' in idCondition ) || b >= idCondition.$gte )
                && ( !( '$lt' in idCondition ) || b < idCondition.$lt )
                && ( !( '$lte' in idCondition ) || b <= idCondition.$lte );

            if( matches )
            {
                matchingIndices.push( k );
            }
        }

        if( matchingIndices.length === 0 )
        {
            return null;
        }

        const firstIdx = matchingIndices[ 0 ]!;
        const lastIdx = matchingIndices[ matchingIndices.length - 1 ]!;

        prefilterCondition = {
            $gte: boundaries[ firstIdx ],
            $lt: boundaries[ lastIdx + 1 ]
        };
    }
    else
    {
        return null;
    }

    const prefilter: Record<string, any> = {};

    if( prefilterCondition !== null )
    {
        prefilter[sourceField] = prefilterCondition;
    }
    else
    {
        prefilter.$or = prefilterDisjunction;
    }

    const remainingConjuncts = conjuncts
        .filter(( _c, idx ) => retainIdInPostfilter || idx !== idConjunctIndex )
        .map(( c ) => deepClone( c ));

    const postfilterStage = (
        remainingConjuncts.length > 0
            ? { $match: combineConjuncts( remainingConjuncts ) }
            : null
    );

    return {
        prefilterStage: { $match: prefilter },
        postfilterStage
    };
}
