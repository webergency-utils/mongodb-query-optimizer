import { analyzeStage } from '../analyzer/semantics.js';
import { GuaranteeContext } from '../guarantees.js';
import { deepClone, isPlainObject } from '../utils.js';
import { isStageProvenErrorFree } from './guarantee-guards.js';
import
{
    combineConjuncts,
    decomposeFilterIntoConjuncts,
    getSingleStageEntry,
    getStageSpec
}
from './helpers.js';

export interface UnwindPrefilterProof
{
    prefilterStage : { $match: Record<string, any> }
    arrayPath      : string
}

function isNonNullScalar( val: unknown ): boolean
{
    if( val === null || val === undefined )
    {
        return false;
    }

    const type = typeof val;

    return type === 'string'
        || type === 'number'
        || type === 'boolean'
        || type === 'bigint'
        || val instanceof Date;
}

function isQualifyingPrefilterValue( val: unknown ): boolean
{
    if( isNonNullScalar( val ))
    {
        return true;
    }

    if( !isPlainObject( val ))
    {
        return false;
    }

    const keys = Object.keys( val );

    if( keys.length === 0 )
    {
        return false;
    }

    for( const op of keys )
    {
        if( op === '$eq' || op === '$gt' || op === '$gte' || op === '$lt' || op === '$lte' )
        {
            if( !isNonNullScalar( val[ op ] ))
            {
                return false;
            }
        }
        else if( op === '$in' )
        {
            const inList = val[ op ];

            if( !Array.isArray( inList ) || inList.length === 0 )
            {
                return false;
            }

            for( const item of inList )
            {
                if( !isNonNullScalar( item ))
                {
                    return false;
                }
            }
        }
        else if( op === '$exists' )
        {
            if( val[ op ] !== true )
            {
                return false;
            }
        }
        else
        {
            return false;
        }
    }

    return true;
}

export function proveUnwindPrefilter(
    unwindStage : unknown,
    matchStage  : unknown,
    context?    : GuaranteeContext
): UnwindPrefilterProof | null
{
    const unwindEntry = getSingleStageEntry( unwindStage );
    const matchSpec = getStageSpec<Record<string, any>>( matchStage, '$match' );

    if( !unwindEntry || unwindEntry[ 0 ] !== '$unwind' || !matchSpec )
    {
        return null;
    }

    const unwindSpec = unwindEntry[ 1 ];

    let arrayPath: string;
    let indexField: string | undefined;

    if( typeof unwindSpec === 'string' )
    {
        if( !unwindSpec.startsWith( '$' ) || unwindSpec.length <= 1 )
        {
            return null;
        }

        arrayPath = unwindSpec.slice( 1 );
    }
    else if( isPlainObject( unwindSpec ))
    {
        if(
            typeof unwindSpec.path !== 'string'
            || !unwindSpec.path.startsWith( '$' )
            || unwindSpec.path.length <= 1
            || unwindSpec.preserveNullAndEmptyArrays === true
        )
        {
            return null;
        }

        arrayPath = unwindSpec.path.slice( 1 );

        if( typeof unwindSpec.includeArrayIndex === 'string' )
        {
            indexField = unwindSpec.includeArrayIndex;
        }
    }
    else
    {
        return null;
    }

    const summary = analyzeStage( matchStage );

    if(
        summary.malformed
        || summary.unknown
        || summary.determinism !== 'deterministic'
    )
    {
        return null;
    }

    if( context?.strictErrors )
    {
        if( !isStageProvenErrorFree( unwindStage ) || !isStageProvenErrorFree( matchStage ))
        {
            return null;
        }
    }

    const conjuncts = decomposeFilterIntoConjuncts( matchSpec );

    if( indexField !== undefined )
    {
        const prefixIndex = indexField + '.';

        for( const conjunct of conjuncts )
        {
            for( const key of Object.keys( conjunct ))
            {
                if( key === indexField || key.startsWith( prefixIndex ))
                {
                    return null;
                }
            }
        }
    }

    const prefix = arrayPath + '.';
    const dottedConjuncts: Record<string, any>[] = [];

    for( const conjunct of conjuncts )
    {
        const [ key, val ] = Object.entries( conjunct )[ 0 ]!;

        if( key === arrayPath || key.startsWith( prefix ))
        {
            if( !isQualifyingPrefilterValue( val ))
            {
                return null;
            }

            dottedConjuncts.push({ [ key ]: deepClone( val ) });
        }
    }

    if( dottedConjuncts.length === 0 )
    {
        return null;
    }

    const escapeBranch =
    {
        [ arrayPath ]: {
            $elemMatch: {
                $type: 'array'
            }
        }
    };

    return {
        prefilterStage: {
            $match: {
                $or: [
                    combineConjuncts( dottedConjuncts ),
                    escapeBranch
                ]
            }
        },
        arrayPath
    };
}
