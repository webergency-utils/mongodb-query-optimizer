import { GuaranteeContext } from '../guarantees.js';
import { isPlainObject } from '../utils.js';
import { isStageProvenErrorFree } from './guarantee-guards.js';
import {
    combineConjuncts,
    decomposeFilterIntoConjuncts,
    getStageSpec,
} from './helpers.js';

export interface GroupFilterPushdownProof
{
    prefilterStage: { $match: Record<string, any> };
    postfilterStage: { $match: Record<string, any> } | null;
}

function isNullAndEmptyRejectingScalar( val: unknown ): boolean
{
    if( typeof val === 'string' )
    {
        return val.length > 0;
    }

    return typeof val === 'number'
        || typeof val === 'boolean'
        || val instanceof Date;
}

function conditionRejectsNull( condition: unknown ): boolean
{
    if( isNullAndEmptyRejectingScalar( condition ))
    {
        return true;
    }

    if( !isPlainObject( condition ))
    {
        return false;
    }

    if( '$ne' in condition && condition.$ne === null )
    {
        return true;
    }

    if( '$eq' in condition && isNullAndEmptyRejectingScalar( condition.$eq ))
    {
        return true;
    }

    if(
        '$in' in condition
        && Array.isArray( condition.$in )
        && condition.$in.length > 0
        && condition.$in.every( isNullAndEmptyRejectingScalar )
    )
    {
        return true;
    }

    if(
        ( '$gt' in condition && isNullAndEmptyRejectingScalar( condition.$gt ))
        || ( '$gte' in condition && isNullAndEmptyRejectingScalar( condition.$gte ))
    )
    {
        return true;
    }

    return false;
}

export function proveGroupFilterPushdown(
    groupStage: unknown,
    matchStage: unknown,
    context?: GuaranteeContext
): GroupFilterPushdownProof | null
{
    if( context?.strictErrors && !isStageProvenErrorFree( groupStage ))
    {
        return null;
    }

    const groupSpec = getStageSpec<Record<string, any>>( groupStage, '$group' );
    const matchSpec = getStageSpec<Record<string, any>>( matchStage, '$match' );

    if( !groupSpec || !matchSpec || !( '_id' in groupSpec ))
    {
        return null;
    }

    const conjuncts = decomposeFilterIntoConjuncts( matchSpec );

    const idSpec = groupSpec._id;
    const prefilterConjuncts: Record<string, any>[] = [];
    const postfilterConjuncts: Record<string, any>[] = [];
    let hasIdCondition = false;

    // Inspect _id specification
    if(
        typeof idSpec === 'string'
        && idSpec.startsWith( '$' )
        && !idSpec.startsWith( '$$' )
        && idSpec.length > 1
    )
    {
        const sourceField = idSpec.slice( 1 );

        for( const conjunct of conjuncts )
        {
            const entries = Object.entries( conjunct );
            const [ key, val ] = entries[ 0 ]!;

            if( key === '_id' )
            {
                prefilterConjuncts.push( { [ sourceField ]: val } );
                hasIdCondition = true;
            }
            else if( key.startsWith( '_id.' ))
            {
                const sub = key.slice( 4 );
                prefilterConjuncts.push( { [ `${ sourceField }.${ sub }` ]: val } );
                hasIdCondition = true;
            }
            else if( key === '$or' && Array.isArray( val ) && val.length > 0 )
            {
                const pushedBranches: Record<string, any>[] = [];
                let allBranchesPureId = true;

                for( const branch of val )
                {
                    if( !isPlainObject( branch ))
                    {
                        allBranchesPureId = false;
                        break;
                    }

                    const branchProof = proveGroupFilterPushdown( groupStage, { $match: branch }, context );
                    if( !branchProof || branchProof.postfilterStage !== null )
                    {
                        allBranchesPureId = false;
                        break;
                    }

                    pushedBranches.push( branchProof.prefilterStage.$match );
                }

                if( allBranchesPureId )
                {
                    prefilterConjuncts.push({ $or: pushedBranches });
                    hasIdCondition = true;
                }
                else
                {
                    postfilterConjuncts.push( conjunct );
                }
            }
            else
            {
                postfilterConjuncts.push( conjunct );
            }
        }
    }
    else if( isPlainObject( idSpec ))
    {
        const idKeys = Object.keys( idSpec );
        const directFieldMap = new Map<string, string>();
        const computedFieldMap = new Map<string, string>();
        let isValidComposite = idKeys.length > 0 && !idKeys.some(( k ) => k.startsWith( '$' ));

        if( isValidComposite )
        {
            for( const k of idKeys )
            {
                const subSpec = idSpec[ k ];

                if(
                    typeof subSpec === 'string'
                    && subSpec.startsWith( '$' )
                    && !subSpec.startsWith( '$$' )
                    && subSpec.length > 1
                )
                {
                    directFieldMap.set( k, subSpec.slice( 1 ));
                }
                else if( isPlainObject( subSpec ))
                {
                    const subOpKeys = Object.keys( subSpec );
                    const subOpArg = subOpKeys.length === 1 && subOpKeys[ 0 ]!.startsWith( '$' )
                        ? subSpec[ subOpKeys[ 0 ]! ]
                        : null;

                    if(
                        typeof subOpArg === 'string'
                        && subOpArg.startsWith( '$' )
                        && !subOpArg.startsWith( '$$' )
                        && subOpArg.length > 1
                    )
                    {
                        computedFieldMap.set( k, subOpArg.slice( 1 ));
                    }
                    else
                    {
                        isValidComposite = false;
                        break;
                    }
                }
                else
                {
                    isValidComposite = false;
                    break;
                }
            }
        }

        if( isValidComposite && computedFieldMap.size === 0 )
        {
            for( const conjunct of conjuncts )
            {
                const entries = Object.entries( conjunct );
                const [ key, val ] = entries[ 0 ]!;

                if( key.startsWith( '_id.' ))
                {
                    const rest = key.slice( 4 );
                    const dotIdx = rest.indexOf( '.' );
                    const subKey = dotIdx === -1 ? rest : rest.slice( 0, dotIdx );
                    const subPath = dotIdx === -1 ? '' : rest.slice( dotIdx );

                    if( directFieldMap.has( subKey ))
                    {
                        const sourceField = directFieldMap.get( subKey )! + subPath;
                        prefilterConjuncts.push( { [ sourceField ]: val } );
                        hasIdCondition = true;
                    }
                    else
                    {
                        return null;
                    }
                }
                else if( key === '_id' )
                {
                    if( isPlainObject( val ))
                    {
                        for( const [ subKey, subVal ] of Object.entries( val ))
                        {
                            if( directFieldMap.has( subKey ))
                            {
                                const sourceField = directFieldMap.get( subKey )!;
                                prefilterConjuncts.push( { [ sourceField ]: subVal } );
                                hasIdCondition = true;
                            }
                            else
                            {
                                return null;
                            }
                        }
                    }
                    else
                    {
                        return null;
                    }
                }
                else
                {
                    postfilterConjuncts.push( conjunct );
                }
            }
        }
        else if( isValidComposite && computedFieldMap.size > 0 )
        {
            const nullRejectedSources = new Set<string>();

            for( const conjunct of conjuncts )
            {
                const entries = Object.entries( conjunct );
                const [ key, val ] = entries[ 0 ]!;

                if( key.startsWith( '_id.' ))
                {
                    const rest = key.slice( 4 );
                    const dotIdx = rest.indexOf( '.' );
                    const subKey = dotIdx === -1 ? rest : rest.slice( 0, dotIdx );
                    const subPath = dotIdx === -1 ? '' : rest.slice( dotIdx );

                    if( directFieldMap.has( subKey ))
                    {
                        const sourceField = directFieldMap.get( subKey )! + subPath;
                        prefilterConjuncts.push( { [ sourceField ]: val } );
                        hasIdCondition = true;
                    }
                    else if( computedFieldMap.has( subKey ))
                    {
                        if( dotIdx === -1 && conditionRejectsNull( val ))
                        {
                            const sourceField = computedFieldMap.get( subKey )!;

                            if( !nullRejectedSources.has( sourceField ))
                            {
                                nullRejectedSources.add( sourceField );
                                prefilterConjuncts.push( { [ sourceField ]: { $exists: true, $ne: null } } );
                            }

                            hasIdCondition = true;
                        }

                        postfilterConjuncts.push( conjunct );
                    }
                    else
                    {
                        return null;
                    }
                }
                else
                {
                    postfilterConjuncts.push( conjunct );
                }
            }
        }
        else
        {
            // Computed expression like { $toUpper: '$dept' }
            const opKeys = Object.keys( idSpec );

            if( opKeys.length === 1 && opKeys[ 0 ]!.startsWith( '$' ))
            {
                const opArg = idSpec[ opKeys[ 0 ]! ];

                if(
                    typeof opArg === 'string'
                    && opArg.startsWith( '$' )
                    && !opArg.startsWith( '$$' )
                    && opArg.length > 1
                )
                {
                    const sourceField = opArg.slice( 1 );
                    let hasNullRejectingId = false;

                    for( const conjunct of conjuncts )
                    {
                        const entries = Object.entries( conjunct );
                        const [ key, val ] = entries[ 0 ]!;

                        if( key === '_id' && conditionRejectsNull( val ))
                        {
                            hasNullRejectingId = true;
                        }
                    }

                    if( !hasNullRejectingId )
                    {
                        return null;
                    }

                    prefilterConjuncts.push( { [ sourceField ]: { $exists: true, $ne: null } } );
                    hasIdCondition = true;
                    postfilterConjuncts.push( ...conjuncts );
                }
                else
                {
                    return null;
                }
            }
            else
            {
                return null;
            }
        }
    }
    else
    {
        return null;
    }

    if( !hasIdCondition )
    {
        return null;
    }

    const postfilterStage = (
        postfilterConjuncts.length > 0
            ? { $match: combineConjuncts( postfilterConjuncts ) }
            : null
    );

    return {
        prefilterStage: { $match: combineConjuncts( prefilterConjuncts ) },
        postfilterStage,
    };
}
