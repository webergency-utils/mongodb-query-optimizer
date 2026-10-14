import { hasSingleKey, isPlainObject } from '../utils.js';

const singleStageEntryCache = new WeakMap<object, readonly [ string, unknown ] | null>();
const filterConjunctsCache = new WeakMap<object, Record<string, unknown>[]>();

export function getSingleStageEntry( stage: unknown ): readonly [ string, unknown ] | null
{
    if( !isPlainObject( stage )){ return null }

    const cached = singleStageEntryCache.get( stage );

    if( cached !== undefined ){ return cached }

    let singleKey: string | undefined;

    for( const key in stage )
    {
        if( singleKey !== undefined )
        {
            singleStageEntryCache.set( stage, null );

            return null;
        }

        singleKey = key;
    }

    if( singleKey === undefined )
    {
        singleStageEntryCache.set( stage, null );

        return null;
    }

    const entry = [ singleKey, ( stage as Record<string, unknown> )[ singleKey ] ] as const;
    singleStageEntryCache.set( stage, entry );

    return entry;
}

export function getStageSpec<T = Record<string, unknown>>( stage: unknown, op: string ): T | null
{
    if( !isPlainObject( stage ) || !( op in stage ) || !hasSingleKey( stage ))
    {
        return null;
    }

    const spec = ( stage as Record<string, unknown> )[ op ];

    return isPlainObject( spec ) ? ( spec as T ) : null;
}

export function isMatchStage( stage: unknown ): stage is { readonly $match: Record<string, unknown> }
{
    return getStageSpec( stage, '$match' ) !== null;
}

export function isSingleKeyStage( stage: unknown, op: string ): boolean
{
    return isPlainObject( stage ) && ( op in stage ) && hasSingleKey( stage );
}

export function decomposeFilterIntoConjuncts( filter: Record<string, unknown> ): Record<string, unknown>[]
{
    const cached = filterConjunctsCache.get( filter );

    if( cached !== undefined )
    {
        return [ ...cached ];
    }

    if( !( '$and' in filter ) && hasSingleKey( filter ))
    {
        const single = [ filter ];
        filterConjunctsCache.set( filter, single );

        return [ filter ];
    }

    const conjuncts: Record<string, unknown>[] = [];

    for( const key in filter )
    {
        const value = filter[ key ];

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

    filterConjunctsCache.set( filter, conjuncts );

    return [ ...conjuncts ];
}

export function combineConjuncts( conjuncts: readonly Record<string, unknown>[] ): Record<string, unknown>
{
    if( conjuncts.length === 0 ){ return {} }

    if( conjuncts.length === 1 ){ return { ...conjuncts[ 0 ] } }

    const merged: Record<string, unknown> = {};
    const seenKeys = new Set<string>();
    let hasCollision = false;

    for( const conjunct of conjuncts )
    {
        for( const key in conjunct )
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
