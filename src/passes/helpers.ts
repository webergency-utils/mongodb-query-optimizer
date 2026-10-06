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
