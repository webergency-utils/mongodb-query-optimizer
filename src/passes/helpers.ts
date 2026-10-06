import { isPlainObject } from '../utils.js';

export function getSingleStageEntry( stage: unknown ): readonly [ string, unknown ] | null
{
    if( !isPlainObject( stage )){ return null }

    const keys = Object.keys( stage );
    if( keys.length !== 1 ){ return null }

    const key = keys[0]!;

    return [ key, ( stage as Record<string, unknown> )[ key ]] as const;
}

export function getStageSpec<T = Record<string, unknown>>( stage: unknown, op: string ): T | null
{
    const entry = getSingleStageEntry( stage );
    if( !entry || entry[0] !== op || !isPlainObject( entry[1] )){ return null }

    return entry[1] as T;
}

export function isMatchStage( stage: unknown ): stage is { readonly $match: Record<string, unknown> }
{
    return getStageSpec( stage, '$match' ) !== null;
}

export function isSingleKeyStage( stage: unknown, op: string ): boolean
{
    const entry = getSingleStageEntry( stage );

    return entry !== null && entry[0] === op;
}

export function decomposeFilterIntoConjuncts( filter: Record<string, unknown> ): Record<string, unknown>[]
{
    const entries = Object.entries( filter );

    if( entries.length === 0 ){ return [] }

    const conjuncts: Record<string, unknown>[] = [];

    for( const [ key, value ] of entries )
    {
        if( key === '$and' && Array.isArray( value ))
        {
            for( const branch of value )
            {
                if( isPlainObject( branch ))
                {
                    const subConjuncts = decomposeFilterIntoConjuncts( branch );

                    if( subConjuncts.length > 0 )
                    {
                        conjuncts.push( ...subConjuncts );
                    }
                    else
                    {
                        conjuncts.push( branch );
                    }
                }
                else
                {
                    conjuncts.push( branch as Record<string, unknown> );
                }
            }
        }
        else
        {
            conjuncts.push( { [ key ]: value } );
        }
    }

    return conjuncts;
}

export function combineConjuncts( conjuncts: readonly Record<string, unknown>[] ): Record<string, unknown>
{
    if( conjuncts.length === 0 ){ return {} }

    if( conjuncts.length === 1 ){ return conjuncts[ 0 ] }

    const merged: Record<string, unknown> = {};
    const seenKeys = new Set<string>();
    let hasCollision = false;

    for( const conjunct of conjuncts )
    {
        for( const key of Object.keys( conjunct ))
        {
            if( seenKeys.has( key ))
            {
                hasCollision = true;
                break;
            }

            seenKeys.add( key );
        }

        if( hasCollision ){ break }
    }

    if( !hasCollision )
    {
        for( const conjunct of conjuncts )
        {
            Object.assign( merged, conjunct );
        }

        return merged;
    }

    return { $and: conjuncts.map(( conjunct ) => ({ ...conjunct })) };
}
