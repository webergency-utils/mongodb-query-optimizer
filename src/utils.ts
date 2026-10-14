export const MAX_ANALYZED_ARRAY_LENGTH = 64;

function equalBytes( a: Uint8Array, b: Uint8Array ): boolean
{
    if( a.byteLength !== b.byteLength ){ return false }

    for( let i = 0; i < a.byteLength; i++ )
    {
        if( a[ i ] !== b[ i ] ){ return false }
    }

    return true;
}

function compareBsonValues(
    a       : any,
    b       : any,
    seen    : WeakMap<object, WeakSet<object>> | undefined
): boolean | null
{
    if( isPlainObject( a ) || isPlainObject( b ))
    {
        return false;
    }

    if( typeof a._bsontype !== 'string' || typeof b._bsontype !== 'string' )
    {
        return false;
    }

    if( a._bsontype !== b._bsontype || a.constructor !== b.constructor )
    {
        return false;
    }

    switch( a._bsontype )
    {
        case 'BSONRegExp':
            return a.pattern === b.pattern && a.options === b.options;

        case 'Code':
            return a.code === b.code && isEqualInternal( a.scope, b.scope, seen );

        case 'Binary':
        {
            if( a.sub_type !== b.sub_type ){ return false }

            if( a.buffer instanceof Uint8Array && b.buffer instanceof Uint8Array )
            {
                const lenA = typeof a.position === 'number' ? a.position : a.buffer.byteLength;
                const lenB = typeof b.position === 'number' ? b.position : b.buffer.byteLength;

                return equalBytes( a.buffer.subarray( 0, lenA ), b.buffer.subarray( 0, lenB ));
            }

            break;
        }

        case 'MinKey':
        case 'MaxKey':
            return true;

        case 'Double':
        case 'Int32':
        case 'BSONSymbol':
            return Object.is( a.valueOf(), b.valueOf() );

        case 'DBRef':
            return (
                ( a.collection ?? a.namespace ) === ( b.collection ?? b.namespace )
                && a.db === b.db
                && isEqualInternal( a.oid, b.oid, seen )
                && isEqualInternal( a.fields, b.fields, seen )
            );

        case 'Decimal128':
            if( a.bytes instanceof Uint8Array && b.bytes instanceof Uint8Array )
            {
                return equalBytes( a.bytes, b.bytes );
            }

            return a.toString() === b.toString();

        case 'Long':
            if( a.unsigned !== b.unsigned ){ return false }

            if( typeof a.equals === 'function' )
            {
                return Boolean( a.equals( b ));
            }

            break;
    }

    if( typeof a.equals === 'function' )
    {
        try
        {
            return Boolean( a.equals( b ));
        }
        catch
        {
            // fall through
        }
    }

    if( typeof a.toHexString === 'function' && typeof b.toHexString === 'function' )
    {
        return a.toHexString() === b.toHexString();
    }

    if( typeof a.toString === 'function' && a.toString !== Object.prototype.toString )
    {
        const strA = a.toString();
        const strB = b.toString();

        if( strA !== '[object Object]' || strB !== '[object Object]' )
        {
            return strA === strB;
        }
    }

    return null;
}

const acyclicObjects = new WeakSet<object>();

function recordCyclePair(
    a       : object,
    b       : object,
    seen    : WeakMap<object, WeakSet<object>>
): boolean
{
    const seenB = seen.get( a );

    if( seenB !== undefined )
    {
        if( seenB.has( b )){ return true }

        seenB.add( b );

        return false;
    }

    seen.set( a, new WeakSet<object>([ b ]));

    return false;
}

function getFunctionSource( value: Function ): string
{
    try
    {
        return Function.prototype.toString.call( value );
    }
    catch
    {
        return value.name;
    }
}

function isEqualInternal(
    a       : unknown,
    b       : unknown,
    seen    : WeakMap<object, WeakSet<object>> | undefined
): boolean
{
    if( Object.is( a, b )){ return true }

    if( a === null || b === null || typeof a !== typeof b ){ return false }

    if( typeof a === 'function' )
    {
        return getFunctionSource( a as Function ) === getFunctionSource( b as Function );
    }

    if( typeof a !== 'object' ){ return false }

    const objA = a as Record<PropertyKey, any>;
    const objB = b as Record<PropertyKey, any>;

    if( objA instanceof Date || objB instanceof Date )
    {
        return objA instanceof Date && objB instanceof Date && Object.is( objA.getTime(), objB.getTime() );
    }

    if( objA instanceof RegExp || objB instanceof RegExp )
    {
        return objA instanceof RegExp && objB instanceof RegExp && objA.source === objB.source && objA.flags === objB.flags;
    }

    if( objA instanceof ArrayBuffer || objB instanceof ArrayBuffer )
    {
        if( !( objA instanceof ArrayBuffer ) || !( objB instanceof ArrayBuffer ))
        {
            return false;
        }

        return equalBytes( new Uint8Array( objA ), new Uint8Array( objB ));
    }

    if( ArrayBuffer.isView( objA ) || ArrayBuffer.isView( objB ))
    {
        if(
            !ArrayBuffer.isView( objA )
            || !ArrayBuffer.isView( objB )
            || objA.constructor !== objB.constructor
            || objA.byteLength !== objB.byteLength
        )
        {
            return false;
        }

        return equalBytes(
            new Uint8Array( objA.buffer, objA.byteOffset, objA.byteLength ),
            new Uint8Array( objB.buffer, objB.byteOffset, objB.byteLength )
        );
    }

    if(
        ( !isPlainObject( objA ) || !isPlainObject( objB ))
        && ( typeof objA._bsontype === 'string' || typeof objB._bsontype === 'string' )
    )
    {
        const bsonResult = compareBsonValues( objA, objB, seen );

        if( bsonResult !== null )
        {
            return bsonResult;
        }
    }

    if( Array.isArray( objA ) || Array.isArray( objB ))
    {
        if( !Array.isArray( objA ) || !Array.isArray( objB ) || objA.length !== objB.length )
        {
            return false;
        }

        if( objA.length === 0 ){ return true }

        let activeSeen = seen;
        let pairRecorded = acyclicObjects.has( objA ) && acyclicObjects.has( objB );

        for( let i = 0; i < objA.length; i++ )
        {
            const itemA = objA[ i ];
            const itemB = objB[ i ];

            if( Object.is( itemA, itemB ))
            {
                continue;
            }

            if( !pairRecorded )
            {
                activeSeen ??= new WeakMap<object, WeakSet<object>>();

                if( recordCyclePair( objA, objB, activeSeen )){ return true }

                pairRecorded = true;
            }

            if( !isEqualInternal( itemA, itemB, activeSeen ))
            {
                return false;
            }
        }

        return true;
    }

    if( objA instanceof Map || objB instanceof Map )
    {
        if( !( objA instanceof Map ) || !( objB instanceof Map ) || objA.size !== objB.size )
        {
            return false;
        }

        if( objA.size === 0 ){ return true }

        const activeSeen = seen ?? new WeakMap<object, WeakSet<object>>();

        if( recordCyclePair( objA, objB, activeSeen )){ return true }

        const iterA = objA.entries();
        const iterB = objB.entries();

        for( let i = 0; i < objA.size; i++ )
        {
            const [ kA, vA ] = iterA.next().value!;
            const [ kB, vB ] = iterB.next().value!;

            if( !isEqualInternal( kA, kB, activeSeen ) || !isEqualInternal( vA, vB, activeSeen ))
            {
                return false;
            }
        }

        return true;
    }

    if( objA instanceof Set || objB instanceof Set )
    {
        if( !( objA instanceof Set ) || !( objB instanceof Set ) || objA.size !== objB.size )
        {
            return false;
        }

        if( objA.size === 0 ){ return true }

        const activeSeen = seen ?? new WeakMap<object, WeakSet<object>>();

        if( recordCyclePair( objA, objB, activeSeen )){ return true }

        const iterA = objA.values();
        const iterB = objB.values();

        for( let i = 0; i < objA.size; i++ )
        {
            const vA = iterA.next().value;
            const vB = iterB.next().value;

            if( !isEqualInternal( vA, vB, activeSeen ))
            {
                return false;
            }
        }

        return true;
    }

    const plainA = isPlainObject( objA );
    const plainB = isPlainObject( objB );

    if( plainA || plainB )
    {
        if( !plainA || !plainB ){ return false }
    }
    else if(
        Object.getPrototypeOf( objA ) !== Object.getPrototypeOf( objB )
        || ( objA as object ).constructor !== ( objB as object ).constructor
    )
    {
        return false;
    }

    const keysA = Object.keys( objA );
    const keysB = Object.keys( objB );

    if( keysA.length !== keysB.length ){ return false }

    for( let i = 0; i < keysA.length; i++ )
    {
        if( keysA[ i ] !== keysB[ i ] ){ return false }
    }

    const symbolsA = Object.getOwnPropertySymbols( objA );
    const symbolsB = Object.getOwnPropertySymbols( objB );

    if( symbolsA.length !== symbolsB.length ){ return false }

    for( let i = 0; i < symbolsA.length; i++ )
    {
        if( symbolsA[ i ] !== symbolsB[ i ] ){ return false }
    }

    if( keysA.length === 0 && symbolsA.length === 0 ){ return true }

    let activeSeen = seen;
    let pairRecorded = acyclicObjects.has( objA ) && acyclicObjects.has( objB );

    for( let i = 0; i < keysA.length; i++ )
    {
        const key = keysA[ i ]!;
        const valA = objA[ key ];
        const valB = objB[ key ];

        if( Object.is( valA, valB ))
        {
            continue;
        }

        if( !pairRecorded )
        {
            activeSeen ??= new WeakMap<object, WeakSet<object>>();

            if( recordCyclePair( objA, objB, activeSeen )){ return true }

            pairRecorded = true;
        }

        if( !isEqualInternal( valA, valB, activeSeen ))
        {
            return false;
        }
    }

    for( let i = 0; i < symbolsA.length; i++ )
    {
        const sym = symbolsA[ i ]!;
        const valA = objA[ sym ];
        const valB = objB[ sym ];

        if( Object.is( valA, valB ))
        {
            continue;
        }

        if( !pairRecorded )
        {
            activeSeen ??= new WeakMap<object, WeakSet<object>>();

            if( recordCyclePair( objA, objB, activeSeen )){ return true }

            pairRecorded = true;
        }

        if( !isEqualInternal( valA, valB, activeSeen ))
        {
            return false;
        }
    }

    return true;
}

export function isEqual( a: any, b: any ): boolean
{
    return isEqualInternal( a, b, undefined );
}

function isPrimitiveValue( val: unknown ): boolean
{
    return val === null || ( typeof val !== 'object' && typeof val !== 'function' );
}

export function containsValue( items: readonly unknown[], target: unknown ): boolean
{
    for( let i = 0; i < items.length; i++ )
    {
        if( isEqual( items[ i ], target )){ return true }
    }

    return false;
}

export const MAX_COMPLEX_ARRAY_LENGTH = 64;

const dedupedArraysCache = new WeakSet<object>();

export function deduplicateBoundedArray<T>(
    items   : readonly T[],
    maxLen  : number = Infinity
): T[]
{
    const len = items.length;

    if( len <= 1 || len > maxLen )
    {
        return items as T[];
    }

    if( dedupedArraysCache.has( items as object ))
    {
        return items as T[];
    }

    let primitiveSet: Set<unknown> | undefined;
    let hasNegativeZero = false;
    let dateSet: Set<number> | undefined;
    let hexSet: Set<string> | undefined;
    let oidTable: Int32Array | undefined;
    let oidMask = 0;
    let nonPrimitives: T[] | undefined;

    let result: T[] | undefined;
    let writeIdx = 0;

    for( let i = 0; i < len; i++ )
    {
        const item = items[ i ]!;
        let isDup = false;

        if( isPrimitiveValue( item ))
        {
            if( Object.is( item, -0 ))
            {
                if( hasNegativeZero )
                {
                    isDup = true;
                }
                else
                {
                    hasNegativeZero = true;
                }
            }
            else
            {
                primitiveSet ??= new Set<unknown>();

                if( primitiveSet.has( item ))
                {
                    isDup = true;
                }
                else
                {
                    primitiveSet.add( item );
                }
            }
        }
        else if(
            typeof ( item as any ).i0 === 'number'
            && typeof ( item as any ).i1 === 'number'
            && typeof ( item as any ).i2 === 'number'
            && typeof ( item as any ).i3 === 'number'
        )
        {
            if( oidTable === undefined )
            {
                let cap = 16;
                while( cap < len * 2 && cap < 131072 ){ cap <<= 1 }
                oidMask = cap - 1;
                oidTable = new Int32Array( cap ).fill( -1 );
            }

            const { i0, i1, i2, i3 } = item as any;
            const hash = ( i0 ^ ( i1 * 31 ) ^ ( i2 * 101 ) ^ ( i3 * 1009 )) >>> 0;
            let slot = hash & oidMask;

            while( oidTable[ slot ] !== -1 )
            {
                const ex = items[ oidTable[ slot ]! ] as any;

                if(
                    ex.i0 === i0
                    && ex.i1 === i1
                    && ex.i2 === i2
                    && ex.i3 === i3
                )
                {
                    isDup = true;
                    break;
                }

                slot = ( slot + 1 ) & oidMask;
            }

            if( !isDup )
            {
                oidTable[ slot ] = i;
            }
        }
        else if( item instanceof Date )
        {
            dateSet ??= new Set<number>();
            const time = item.getTime();

            if( dateSet.has( time ))
            {
                isDup = true;
            }
            else
            {
                dateSet.add( time );
            }
        }
        else if(
            ( item as any )._bsontype === 'ObjectId'
            || typeof ( item as any ).toHexString === 'function'
        )
        {
            hexSet ??= new Set<string>();
            const hex = typeof ( item as any ).toHexString === 'function'
                ? ( item as any ).toHexString()
                : String( item );

            if( hexSet.has( hex ))
            {
                isDup = true;
            }
            else
            {
                hexSet.add( hex );
            }
        }
        else
        {
            nonPrimitives ??= [];

            if( nonPrimitives.length >= MAX_COMPLEX_ARRAY_LENGTH )
            {
                // Complex subdocuments cap reached to prevent O(N^2) explosion
            }
            else if( containsValue( nonPrimitives, item ))
            {
                isDup = true;
            }
            else
            {
                nonPrimitives.push( item );
            }
        }

        if( isDup )
        {
            if( result === undefined )
            {
                result = items.slice( 0, i );
                writeIdx = i;
            }

            continue;
        }

        if( result !== undefined )
        {
            result[ writeIdx++ ] = item;
        }
    }

    if( result !== undefined )
    {
        result.length = writeIdx;
        dedupedArraysCache.add( result );
        return result;
    }

    dedupedArraysCache.add( items as object );
    return items as T[];
}

export function isPlainObject<T = Record<string, any>>( val: unknown ): val is T
{
    if( val === null || typeof val !== 'object' ){ return false }

    const proto = Object.getPrototypeOf( val );

    return proto === Object.prototype || proto === null;
}

export function hasSingleKey( val: Record<string, unknown> ): boolean
{
    let count = 0;

    for( const _key in val )
    {
        if( ++count > 1 ){ return false }
    }

    return count === 1;
}

export function isEmptyObject( val: unknown ): boolean
{
    if( !isPlainObject( val )){ return false }

    for( const _key in val )
    {
        return false;
    }

    return true;
}

export function isOperatorSubdocument( val: unknown ): boolean
{
    if( !isPlainObject( val )){ return false }

    let hasKey = false;

    for( const key in val )
    {
        if( !key.startsWith( '$' )){ return false }

        hasKey = true;
    }

    return hasKey;
}

export const rewriteSafeBsonArrays = new WeakSet<object>();

export function hasCycle( val: unknown ): boolean
{
    return objectHasCycle( val, new WeakSet(), acyclicObjects );
}

function objectHasCycle(
    val     : unknown,
    active  : WeakSet<object>,
    visited : WeakSet<object>
 ): boolean
{
    if( !val || typeof val !== 'object' ){ return false }

    const isArr = Array.isArray( val );

    if( !isArr && !isPlainObject( val )){ return false }

    if( visited.has( val )){ return false }

    if( active.has( val )){ return true }

    active.add( val );

    if( isArr )
    {
        const len = val.length;
        let allSafeBsonLeaves = true;

        if( len > 0 )
        {
            const first = val[ 0 ];
            const exoticFirstCtor = (
                first !== null
                && typeof first === 'object'
                && !Array.isArray( first )
                && !isPlainObject( first )
            )
                ? ( first as { constructor: new ( ...args: any[] ) => unknown } ).constructor
                : null;

            for( let i = 0; i < len; i++ )
            {
                const item = val[ i ];

                if(
                    typeof item === 'string'
                    || typeof item === 'number'
                    || typeof item === 'boolean'
                    || item === null
                )
                {
                    continue;
                }

                if( exoticFirstCtor !== null && item instanceof exoticFirstCtor )
                {
                    continue;
                }

                allSafeBsonLeaves = false;

                if( typeof item === 'object' && objectHasCycle( item, active, visited )){ return true }
            }
        }

        if( allSafeBsonLeaves )
        {
            rewriteSafeBsonArrays.add( val );
        }
    }
    else
    {
        for( const key in val )
        {
            if( objectHasCycle( ( val as Record<string, unknown> )[ key ], active, visited )){ return true }
        }
    }

    active.delete( val );
    visited.add( val );

    return false;
}


