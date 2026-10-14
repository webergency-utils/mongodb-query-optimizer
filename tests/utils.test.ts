import
{
    Binary,
    BSONRegExp,
    BSONSymbol,
    Code,
    DBRef,
    Decimal128,
    Double,
    Int32,
    Long,
    MaxKey,
    MinKey,
    ObjectId,
    Timestamp,
    UUID
}
from 'mongodb';
import { describe, expect, it } from 'vitest';
import
{
    containsValue,
    deduplicateBoundedArray,
    hasCycle,
    isEmptyObject,
    isEqual,
    isOperatorSubdocument,
    isPlainObject,
    MAX_ANALYZED_ARRAY_LENGTH
}
from '../src/utils.js';
import
{
    getSingleStageEntry,
    getStageSpec,
    isMatchStage,
    isSingleKeyStage
}
from '../src/passes/helpers.js';
import
{
    isExactPath,
    isExactTopLevelPath
}
from '../src/analyzer/paths.js';
import
{
    isValidProjectionPath
}
from '../src/analyzer/projections.js';

describe( 'utils and stage helpers', () =>
{
    describe( 'isPlainObject', () =>
    {
        it( 'returns true for plain object literals and Object.create(null)', () =>
        {
            expect( isPlainObject({ a: 1 })).toBe( true );
            expect( isPlainObject( Object.create( null ))).toBe( true );
            expect( isPlainObject({})).toBe( true );
        });

        it( 'returns false for primitives, arrays, null, undefined, dates, and class instances', () =>
        {
            expect( isPlainObject( null )).toBe( false );
            expect( isPlainObject( undefined )).toBe( false );
            expect( isPlainObject( 123 )).toBe( false );
            expect( isPlainObject( 'str' )).toBe( false );
            expect( isPlainObject( true )).toBe( false );
            expect( isPlainObject([ 1, 2, 3 ])).toBe( false );
            expect( isPlainObject( new Date())).toBe( false );
            expect( isPlainObject( new RegExp( 'abc' ))).toBe( false );

            class Custom {}
            expect( isPlainObject( new Custom())).toBe( false );
        });
    });

    describe( 'isEmptyObject', () =>
    {
        it( 'returns true only for empty plain objects', () =>
        {
            expect( isEmptyObject({})).toBe( true );
            expect( isEmptyObject( Object.create( null ))).toBe( true );
            expect( isEmptyObject({ a: 1 })).toBe( false );
            expect( isEmptyObject( null )).toBe( false );
            expect( isEmptyObject([])).toBe( false );
        });
    });

    describe( 'isOperatorSubdocument', () =>
    {
        it( 'identifies documents where all keys start with $', () =>
        {
            expect( isOperatorSubdocument({ $gt: 5, $lt: 10 })).toBe( true );
            expect( isOperatorSubdocument({ $eq: 1 })).toBe( true );
            expect( isOperatorSubdocument({ a: 1, $gt: 2 })).toBe( false );
            expect( isOperatorSubdocument({})).toBe( false );
            expect( isOperatorSubdocument( null )).toBe( false );
            expect( isOperatorSubdocument( 'not-an-object' )).toBe( false );
        });
    });

    describe( 'stage helpers', () =>
    {
        it( 'getSingleStageEntry extracts single entry from valid stages and returns null otherwise', () =>
        {
            expect( getSingleStageEntry({ $match: { x: 1 } })).toEqual([ '$match', { x: 1 } ]);
            expect( getSingleStageEntry({ $match: 1, $sort: 1 })).toBeNull();
            expect( getSingleStageEntry({})).toBeNull();
            expect( getSingleStageEntry( null )).toBeNull();
            expect( getSingleStageEntry( 'stage' )).toBeNull();
        });

        it( 'getStageSpec retrieves plain object spec matching target operator', () =>
        {
            expect( getStageSpec({ $match: { x: 1 } }, '$match' )).toEqual({ x: 1 });
            expect( getStageSpec({ $match: 'scalar' }, '$match' )).toBeNull();
            expect( getStageSpec({ $sort: { x: 1 } }, '$match' )).toBeNull();
            expect( getStageSpec( null, '$match' )).toBeNull();
        });

        it( 'isMatchStage verifies valid single-key $match stage with plain object filter', () =>
        {
            expect( isMatchStage({ $match: { x: 1 } })).toBe( true );
            expect( isMatchStage({ $match: {} })).toBe( true );
            expect( isMatchStage({ $match: 123 })).toBe( false );
            expect( isMatchStage({ $sort: { x: 1 } })).toBe( false );
            expect( isMatchStage({ $match: {}, extra: 1 })).toBe( false );
            expect( isMatchStage( null )).toBe( false );
        });

        it( 'isSingleKeyStage verifies operator key presence on single-key stages', () =>
        {
            expect( isSingleKeyStage({ $sortByCount: '$dept' }, '$sortByCount' )).toBe( true );
            expect( isSingleKeyStage({ $group: {} }, '$sortByCount' )).toBe( false );
            expect( isSingleKeyStage( null, '$sortByCount' )).toBe( false );
        });
    });

    describe( 'path predicates', () =>
    {
        it( 'isExactPath validates well-formed exact paths and rejects wildcards or invalid paths', () =>
        {
            expect( isExactPath( 'profile.name' )).toBe( true );
            expect( isExactPath( 'status' )).toBe( true );
            expect( isExactPath( '' )).toBe( false );
            expect( isExactPath( '*' )).toBe( false );
            expect( isExactPath( '?' )).toBe( false );
            expect( isExactPath( '$$var' )).toBe( false );
            expect( isExactPath( 'a..b' )).toBe( false );
        });

        it( 'isExactTopLevelPath validates top-level document fields excluding dot paths and $-prefixes', () =>
        {
            expect( isExactTopLevelPath( 'status' )).toBe( true );
            expect( isExactTopLevelPath( 'profile.name' )).toBe( false );
            expect( isExactTopLevelPath( '$status' )).toBe( false );
            expect( isExactTopLevelPath( '' )).toBe( false );
            expect( isExactTopLevelPath( '*' )).toBe( false );
        });

        it( 'isValidProjectionPath checks projection path segment formatting', () =>
        {
            expect( isValidProjectionPath( 'status' )).toBe( true );
            expect( isValidProjectionPath( 'profile.name' )).toBe( true );
            expect( isValidProjectionPath( '' )).toBe( false );
            expect( isValidProjectionPath( '$status' )).toBe( false );
            expect( isValidProjectionPath( 'profile.' )).toBe( false );
            expect( isValidProjectionPath( '.profile' )).toBe( false );
            expect( isValidProjectionPath( 'profile..name' )).toBe( false );
        });
    });

    describe( 'isEqual', () =>
    {
        it( 'handles Object.is semantics for NaN, -0 vs +0, and Date(NaN)', () =>
        {
            expect( isEqual( NaN, NaN )).toBe( true );
            expect( isEqual( -0, +0 )).toBe( false );
            expect( isEqual( +0, -0 )).toBe( false );
            expect( isEqual( -0, -0 )).toBe( true );
            expect( isEqual( +0, +0 )).toBe( true );
            expect( isEqual( new Date( NaN ), new Date( NaN ))).toBe( true );
            expect( isEqual( new Date( 100 ), new Date( 100 ))).toBe( true );
            expect( isEqual( new Date( 100 ), new Date( 200 ))).toBe( false );
            expect( isEqual( new Date( -0 ), new Date( +0 ))).toBe( true );
            expect( isEqual( new Date( 100 ), 100 )).toBe( false );
        });

        it( 'enforces positional key order and explicit undefined key presence', () =>
        {
            expect( isEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe( true );
            expect( isEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe( false );
            expect( isEqual({ a: undefined }, {})).toBe( false );
            expect( isEqual({}, { a: undefined })).toBe( false );
            expect( isEqual({ a: undefined }, { a: undefined })).toBe( true );
            expect( isEqual({ a: undefined }, { b: undefined })).toBe( false );
        });

        it( 'compares Buffer, Uint8Array, ArrayBuffer, DataView, Map, Set, RegExp, and functions', () =>
        {
            expect( isEqual( Buffer.from([ 1, 2, 3 ]), Buffer.from([ 1, 2, 3 ]))).toBe( true );
            expect( isEqual( Buffer.from([ 1, 2, 3 ]), Buffer.from([ 1, 2, 4 ]))).toBe( false );
            expect( isEqual( Buffer.from([ 1, 2 ]), new Uint8Array([ 1, 2 ]))).toBe( false );
            expect( isEqual( new Uint8Array([ 1, 2 ]), new Uint8Array([ 1, 2 ]))).toBe( true );
            expect( isEqual( new Uint8Array([ 1, 2 ]), new Uint8Array([ 2, 1 ]))).toBe( false );

            const ab1 = new Uint8Array([ 5, 6 ]).buffer;
            const ab2 = new Uint8Array([ 5, 6 ]).buffer;
            const ab3 = new Uint8Array([ 5, 7 ]).buffer;

            expect( isEqual( ab1, ab2 )).toBe( true );
            expect( isEqual( ab1, ab3 )).toBe( false );
            expect( isEqual( ab1, new Uint8Array([ 5, 6 ]))).toBe( false );

            const dv1 = new DataView( ab1 );
            const dv2 = new DataView( ab2 );
            const dv3 = new DataView( ab3 );

            expect( isEqual( dv1, dv2 )).toBe( true );
            expect( isEqual( dv1, dv3 )).toBe( false );
            expect( isEqual( dv1, new Uint8Array( ab1 ))).toBe( false );

            expect( isEqual(
                new Map([[ 'a', 1 ], [ 'b', 2 ]]),
                new Map([[ 'a', 1 ], [ 'b', 2 ]])
            )).toBe( true );
            expect( isEqual(
                new Map([[ 'a', 1 ], [ 'b', 2 ]]),
                new Map([[ 'b', 2 ], [ 'a', 1 ]])
            )).toBe( false );
            expect( isEqual(
                new Map([[ 'a', 1 ]]),
                new Map([[ 'a', 2 ]])
            )).toBe( false );

            expect( isEqual( new Set([ 1, 2 ]), new Set([ 1, 2 ]))).toBe( true );
            expect( isEqual( new Set([ 1, 2 ]), new Set([ 2, 1 ]))).toBe( false );
            expect( isEqual( new Set([ -0 ]), new Set([ +0 ]))).toBe( true );

            expect( isEqual( /alpha/gi, new RegExp( 'alpha', 'ig' ))).toBe( true );
            expect( isEqual( /alpha/g, /alpha/i )).toBe( false );
            expect( isEqual( /alpha/i, /beta/i )).toBe( false );

            const fnA = () => 42;
            const fnB = () => 42;
            const fnC = () => 43;

            expect( isEqual( fnA, fnA )).toBe( true );
            expect( isEqual( fnA, fnB )).toBe( true );
            expect( isEqual( fnA, fnC )).toBe( false );
        });

        it( 'compares all BSON types accurately', () =>
        {
            const id1 = new ObjectId( '000000000000000000000001' );
            const id2 = new ObjectId( '000000000000000000000001' );
            const id3 = new ObjectId( '000000000000000000000002' );

            expect( isEqual( id1, id2 )).toBe( true );
            expect( isEqual( id1, id3 )).toBe( false );

            expect( isEqual( Decimal128.fromString( '1.23' ), Decimal128.fromString( '1.23' ))).toBe( true );
            expect( isEqual( Decimal128.fromString( '1.20' ), Decimal128.fromString( '1.2' ))).toBe( false );
            expect( isEqual( Decimal128.fromString( 'NaN' ), Decimal128.fromString( 'NaN' ))).toBe( true );

            expect( isEqual( Long.fromNumber( 100 ), Long.fromNumber( 100 ))).toBe( true );
            expect( isEqual( Long.fromNumber( 100 ), Long.fromNumber( 101 ))).toBe( false );
            expect( isEqual( Long.fromNumber( 100, false ), Long.fromNumber( 100, true ))).toBe( false );

            expect( isEqual( new Timestamp({ t: 1, i: 2 }), new Timestamp({ t: 1, i: 2 }))).toBe( true );
            expect( isEqual( new Timestamp({ t: 1, i: 2 }), new Timestamp({ t: 1, i: 3 }))).toBe( false );
            expect( isEqual( Long.fromNumber( 1 ), new Timestamp({ t: 0, i: 1 }))).toBe( false );

            expect( isEqual( new Double( 1.5 ), new Double( 1.5 ))).toBe( true );
            expect( isEqual( new Double( -0 ), new Double( +0 ))).toBe( false );
            expect( isEqual( new Double( NaN ), new Double( NaN ))).toBe( true );

            expect( isEqual( new Int32( 7 ), new Int32( 7 ))).toBe( true );
            expect( isEqual( new Int32( 7 ), new Int32( 8 ))).toBe( false );
            expect( isEqual( new Double( 7 ), new Int32( 7 ))).toBe( false );

            expect( isEqual( new BSONRegExp( 'abc', 'i' ), new BSONRegExp( 'abc', 'i' ))).toBe( true );
            expect( isEqual( new BSONRegExp( 'abc', 'i' ), new BSONRegExp( 'abc', 'm' ))).toBe( false );
            expect( isEqual( new BSONRegExp( 'abc', 'i' ), new BSONRegExp( 'def', 'i' ))).toBe( false );

            expect( isEqual(
                new Binary( new Uint8Array([ 1, 2, 3 ]), 0 ),
                new Binary( new Uint8Array([ 1, 2, 3 ]), 0 )
            )).toBe( true );
            expect( isEqual(
                new Binary( new Uint8Array([ 1, 2, 3 ]), 0 ),
                new Binary( new Uint8Array([ 1, 2, 3 ]), 2 )
            )).toBe( false );
            expect( isEqual(
                new Binary( new Uint8Array([ 1, 2, 3 ]), 0 ),
                new Binary( new Uint8Array([ 1, 2, 4 ]), 0 )
            )).toBe( false );

            expect( isEqual( new Code( 'return 1;' ), new Code( 'return 1;' ))).toBe( true );
            expect( isEqual( new Code( 'return 1;' ), new Code( 'return 2;' ))).toBe( false );
            expect( isEqual(
                new Code( 'return x;', { x: 1, y: 2 }),
                new Code( 'return x;', { x: 1, y: 2 })
            )).toBe( true );
            expect( isEqual(
                new Code( 'return x;', { x: 1, y: 2 }),
                new Code( 'return x;', { y: 2, x: 1 })
            )).toBe( false );

            expect( isEqual( new MinKey(), new MinKey())).toBe( true );
            expect( isEqual( new MaxKey(), new MaxKey())).toBe( true );
            expect( isEqual( new MinKey(), new MaxKey())).toBe( false );

            const uuid1 = new UUID( '00000000-0000-4000-8000-000000000001' );
            const uuid2 = new UUID( '00000000-0000-4000-8000-000000000001' );
            const uuid3 = new UUID( '00000000-0000-4000-8000-000000000002' );

            expect( isEqual( uuid1, uuid2 )).toBe( true );
            expect( isEqual( uuid1, uuid3 )).toBe( false );

            expect( isEqual( new BSONSymbol( 'sym' ), new BSONSymbol( 'sym' ))).toBe( true );
            expect( isEqual( new BSONSymbol( 'sym' ), new BSONSymbol( 'other' ))).toBe( false );

            expect( isEqual( new DBRef( 'users', id1, 'db1' ), new DBRef( 'users', id2, 'db1' ))).toBe( true );
            expect( isEqual( new DBRef( 'users', id1, 'db1' ), new DBRef( 'users', id3, 'db1' ))).toBe( false );
            expect( isEqual( new DBRef( 'users', id1, 'db1' ), new DBRef( 'posts', id2, 'db1' ))).toBe( false );
        });

        it( 'handles self-referential and mutually recursive cycles safely', () =>
        {
            const selfA: any = { tag: 'node' };
            selfA.self = selfA;

            const selfB: any = { tag: 'node' };
            selfB.self = selfB;

            const selfC: any = { tag: 'different' };
            selfC.self = selfC;

            expect( isEqual( selfA, selfB )).toBe( true );
            expect( isEqual( selfA, selfC )).toBe( false );

            const a1: any = { id: 1 };
            const a2: any = { id: 2, next: a1 };
            a1.next = a2;

            const b1: any = { id: 1 };
            const b2: any = { id: 2, next: b1 };
            b1.next = b2;

            const c1: any = { id: 1 };
            const c2: any = { id: 999, next: c1 };
            c1.next = c2;

            expect( isEqual( a1, b1 )).toBe( true );
            expect( isEqual( a1, c1 )).toBe( false );

            const arrA: any[] = [ 1 ];
            arrA.push( arrA );

            const arrB: any[] = [ 1 ];
            arrB.push( arrB );

            expect( isEqual( arrA, arrB )).toBe( true );
        });

        it( 'compares Symbol keys positionally and handles plain objects and custom BSON fallbacks with _bsontype', () =>
        {
            const sym1 = Symbol( 'k1' );
            const sym2 = Symbol( 'k2' );

            expect( isEqual({ [ sym1 ]: 1, [ sym2 ]: 2 }, { [ sym1 ]: 1, [ sym2 ]: 2 })).toBe( true );
            expect( isEqual({ [ sym1 ]: 1, [ sym2 ]: 2 }, { [ sym2 ]: 2, [ sym1 ]: 1 })).toBe( false );
            expect( isEqual({ [ sym1 ]: 1 }, { [ sym1 ]: 2 })).toBe( false );
            expect( isEqual({ [ sym1 ]: 1 }, { [ sym2 ]: 1 })).toBe( false );
            expect( isEqual({ [ sym1 ]: 1 }, {})).toBe( false );

            const id = new ObjectId( '000000000000000000000001' );

            expect( isEqual( id, {})).toBe( false );
            expect( isEqual({}, id )).toBe( false );
            expect( isEqual( id, { _bsontype: 'ObjectId' })).toBe( false );

            expect( isEqual(
                { _bsontype: 'MinKey', active: true },
                { _bsontype: 'MinKey', active: false }
            )).toBe( false );
            expect( isEqual(
                { _bsontype: 'MinKey', active: true },
                { _bsontype: 'MinKey', active: true }
            )).toBe( true );
            expect( isEqual({ _bsontype: 'User' }, { _bsontype: 'User' })).toBe( true );
            expect( isEqual({ _bsontype: 'User' }, { _bsontype: 'Admin' })).toBe( false );

            class FakeBson
            {
                readonly _bsontype = 'FakeBson';

                constructor( public readonly value: number ) {}
            }

            class NonBson
            {
                constructor( public readonly value: number ) {}
            }

            class HexBson
            {
                readonly _bsontype = 'HexBson';

                constructor( private readonly hex: string ) {}

                toHexString(): string
                {
                    return this.hex;
                }
            }

            class StrBson
            {
                readonly _bsontype = 'StrBson';

                constructor( private readonly raw: string ) {}

                toString(): string
                {
                    return this.raw;
                }
            }

            expect( isEqual( new FakeBson( 1 ), new FakeBson( 1 ))).toBe( true );
            expect( isEqual( new FakeBson( 1 ), new FakeBson( 2 ))).toBe( false );
            expect( isEqual( new FakeBson( 1 ), new NonBson( 1 ))).toBe( false );

            expect( isEqual( new HexBson( 'aa' ), new HexBson( 'aa' ))).toBe( true );
            expect( isEqual( new HexBson( 'aa' ), new HexBson( 'bb' ))).toBe( false );

            expect( isEqual( new StrBson( 'v1' ), new StrBson( 'v1' ))).toBe( true );
            expect( isEqual( new StrBson( 'v1' ), new StrBson( 'v2' ))).toBe( false );
        });
    });

    describe( 'deduplicateBoundedArray and containsValue', () =>
    {
        it( 'exports MAX_ANALYZED_ARRAY_LENGTH = 64', () =>
        {
            expect( MAX_ANALYZED_ARRAY_LENGTH ).toBe( 64 );
        });

        it( 'deduplicates primitives including -0 vs +0, NaN, and non-primitives via isEqual when length <= 64', () =>
        {
            expect( deduplicateBoundedArray([ -0, +0, -0, +0, NaN, NaN, 1, 1, 'a', 'a' ])).toEqual([
                -0,
                +0,
                NaN,
                1,
                'a'
            ]);

            const id1 = new ObjectId( '000000000000000000000001' );
            const id1Copy = new ObjectId( '000000000000000000000001' );
            const id2 = new ObjectId( '000000000000000000000002' );

            const dedupedObjects = deduplicateBoundedArray([
                id1,
                id1Copy,
                id2,
                { a: 1, b: 2 },
                { a: 1, b: 2 },
                { b: 2, a: 1 }
            ]);

            expect( dedupedObjects ).toEqual([
                id1,
                id2,
                { a: 1, b: 2 },
                { b: 2, a: 1 }
            ]);

            const twoUnique = [ 1, 2 ];
            expect( deduplicateBoundedArray( twoUnique )).toBe( twoUnique );
            expect( deduplicateBoundedArray([ 1, 1 ])).toEqual([ 1 ]);

            const id3 = new ObjectId( '000000000000000000000003' );
            const uniqueIds = [ id1, id2, id3 ];
            expect( deduplicateBoundedArray( uniqueIds )).toBe( uniqueIds );
            expect( deduplicateBoundedArray([ id1, id2, id1Copy, id3 ])).toEqual([ id1, id2, id3 ]);

            const d1 = new Date( 1000 );
            const d1Copy = new Date( 1000 );
            const d2 = new Date( 2000 );
            const d3 = new Date( 3000 );
            const uniqueDates = [ d1, d2, d3 ];
            expect( deduplicateBoundedArray( uniqueDates )).toBe( uniqueDates );
            expect( deduplicateBoundedArray([ d1, d2, d1Copy, d3 ])).toEqual([ d1, d2, d3 ]);
            expect( deduplicateBoundedArray([ d1, d1Copy, 'mixed' ])).toEqual([ d1, 'mixed' ]);
        });

        it( 'preserves original array reference when no duplicates exist or when custom maxLen is exceeded', () =>
        {
            const empty: number[] = [];
            const single = [ 1 ];
            const unique = [ -0, +0, 1, 2, { a: 1 }, { a: 2 }];

            expect( deduplicateBoundedArray( empty )).toBe( empty );
            expect( deduplicateBoundedArray( single )).toBe( single );
            expect( deduplicateBoundedArray( unique )).toBe( unique );

            const overCap = Array.from({ length: 65 }, () => 1 );

            expect( deduplicateBoundedArray( overCap, 64 )).toBe( overCap );
            expect( deduplicateBoundedArray( overCap )).toEqual([ 1 ]);
        });

        it( 'deduplicates 3,000+ ObjectIds in microseconds with zero allocations when unique', () =>
        {
            const ids3000 = Array.from({ length: 3000 }, () => new ObjectId());
            expect( deduplicateBoundedArray( ids3000 )).toBe( ids3000 );

            const withDups = [ ...ids3000 ];
            const dupId = new ObjectId( ids3000[ 5 ]!.toString() );
            withDups[ 100 ] = dupId;
            withDups[ 2000 ] = dupId;

            const deduped = deduplicateBoundedArray( withDups );
            expect( deduped ).toHaveLength( 2998 );
            expect( deduped[ 0 ] ).toBe( ids3000[ 0 ] );
            expect( deduped[ 5 ] ).toBe( ids3000[ 5 ] );
        });

        it( 'handles mixed arrays of ObjectIds, primitives, dates, and complex objects with Option A zero reallocation', () =>
        {
            const id1 = new ObjectId();
            const id2 = new ObjectId();
            const id1Dup = new ObjectId( id1.toString() );
            const d1 = new Date( 1000 );
            const d2 = new Date( 2000 );
            const d1Dup = new Date( 1000 );

            const mixed = [
                id1,
                'a',
                10,
                -0,
                +0,
                NaN,
                d1,
                { x: 1 },
                id2,
                'a',
                10,
                -0,
                NaN,
                d1Dup,
                id1Dup,
                d2,
                { x: 1 }
            ];

            const deduped = deduplicateBoundedArray( mixed );
            expect( deduped ).toEqual([
                id1,
                'a',
                10,
                -0,
                +0,
                NaN,
                d1,
                { x: 1 },
                id2,
                d2
            ]);
        });

        it( 'containsValue checks membership using BSON-aware and key-order-sensitive isEqual', () =>
        {
            const id = new ObjectId( '000000000000000000000001' );
            const list = [ -0, NaN, id, { a: 1, b: 2 }];

            expect( containsValue( list, -0 )).toBe( true );
            expect( containsValue( list, +0 )).toBe( false );
            expect( containsValue( list, NaN )).toBe( true );
            expect( containsValue( list, new ObjectId( '000000000000000000000001' ))).toBe( true );
            expect( containsValue( list, new ObjectId( '000000000000000000000002' ))).toBe( false );
            expect( containsValue( list, { a: 1, b: 2 })).toBe( true );
            expect( containsValue( list, { b: 2, a: 1 })).toBe( false );
        });
    });

    describe( 'hasCycle', () =>
    {
        it( 'returns false for Date, RegExp, BSON/exotic leaves, and acyclic structures, and true for cycles', () =>
        {
            expect( hasCycle({
                d: new Date(),
                r: /abc/g,
                id: new ObjectId( '000000000000000000000001' ),
                buf: Buffer.from([ 1, 2, 3 ]),
                nested: [ 1, { ok: true }]
            })).toBe( false );

            const cyclic: any = { a: 1 };
            cyclic.self = cyclic;

            expect( hasCycle( cyclic )).toBe( true );

            const cyclicWithBsonType: any = { _bsontype: 'x' };
            cyclicWithBsonType.self = cyclicWithBsonType;

            expect( hasCycle( cyclicWithBsonType )).toBe( true );
        });
    });
});


