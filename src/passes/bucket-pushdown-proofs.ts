import { deepClone } from '../utils.js';

export interface BucketFilterPushdownProof
{
    prefilterStage: { $match: Record<string, any> }
    postfilterStage: { $match: Record<string, any> } | null
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

export function proveBucketFilterPushdown(
    bucketStage: unknown,
    matchStage: unknown
): BucketFilterPushdownProof | null
{
    if( !isPlainObject( bucketStage ) || !isPlainObject( matchStage ))
    {
        return null;
    }

    const bucketKeys = Object.keys( bucketStage );
    if( bucketKeys.length !== 1 || bucketKeys[0] !== '$bucket' )
    {
        return null;
    }

    const matchKeys = Object.keys( matchStage );
    if( matchKeys.length !== 1 || matchKeys[0] !== '$match' )
    {
        return null;
    }

    const bucketSpec = bucketStage.$bucket;
    const matchSpec = matchStage.$match;

    if( !isPlainObject( bucketSpec ) || !isPlainObject( matchSpec ))
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

    if( !('_id' in matchSpec ))
    {
        return null;
    }

    const idCondition = matchSpec._id;
    let prefilterCondition: Record<string, any> | null = null;
    let prefilterDisjunction: Array<Record<string, any>> | null = null;

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

    const postfilter: Record<string, any> = {};

    for( const [ key, val ] of Object.entries( matchSpec ))
    {
        if( key === '_id' )
        {
            continue;
        }

        postfilter[key] = deepClone( val );
    }

    const postfilterStage = (
        Object.keys( postfilter ).length > 0
            ? { $match: postfilter }
            : null
    );

    return {
        prefilterStage: { $match: prefilter },
        postfilterStage
    };
}
