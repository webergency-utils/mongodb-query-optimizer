import { GuaranteeContext } from '../guarantees.js';
import { deepClone, isPlainObject } from '../utils.js';
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

function conditionRejectsNull( condition: unknown ): boolean
{
    if( typeof condition === 'string' )
    {
        return condition.length > 0;
    }

    if( typeof condition === 'number' || typeof condition === 'boolean' )
    {
        return true;
    }

    if( isPlainObject( condition ) && '$ne' in condition )
    {
        return condition.$ne === null;
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
                prefilterConjuncts.push( { [ sourceField ]: deepClone( val ) } );
                hasIdCondition = true;
            }
            else if( key.startsWith( '_id.' ))
            {
                const sub = key.slice( 4 );
                prefilterConjuncts.push( { [ `${ sourceField }.${ sub }` ]: deepClone( val ) } );
                hasIdCondition = true;
            }
            else
            {
                postfilterConjuncts.push( deepClone( conjunct ) );
            }
        }
    }
    else if( isPlainObject( idSpec ))
    {
        const idKeys = Object.keys( idSpec );
        const allStringPaths = (
            idKeys.length > 0
            && idKeys.every(
                ( k ) =>
                    !k.startsWith( '$' )
                    && typeof idSpec[ k ] === 'string'
                    && idSpec[ k ].startsWith( '$' )
                    && !idSpec[ k ].startsWith( '$$' )
                    && idSpec[ k ].length > 1
            )
        );

        if( allStringPaths )
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

                    if( subKey in idSpec )
                    {
                        const sourceField = idSpec[ subKey ].slice( 1 ) + subPath;
                        prefilterConjuncts.push( { [ sourceField ]: deepClone( val ) } );
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
                            if( subKey in idSpec )
                            {
                                const sourceField = idSpec[ subKey ].slice( 1 );
                                prefilterConjuncts.push( { [ sourceField ]: deepClone( subVal ) } );
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
                    postfilterConjuncts.push( deepClone( conjunct ) );
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
                    postfilterConjuncts.push( ...conjuncts.map(( c ) => deepClone( c )) );
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
