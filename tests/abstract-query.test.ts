import { describe, expect, it } from 'vitest';
import
{
    toAbstractQuery,
    formatAbstractQuery
}
from '../src';

describe( 'abstract query shape generator and pretty printer', () =>
{
    describe( 'toAbstractQuery', () =>
    {
        it( 'AE1: abstracts basic filter query scalars and preserves null', () =>
        {
            const query = {
                status: 'active',
                age: { $gte: 21 },
                deletedAt: null
            };

            const shape = toAbstractQuery( query );
            expect( shape ).toBe( '{"age":{"$gte":<number>},"deletedAt":null,"status":<string>}' );
        });

        it( 'AE2: collapses literal array to unique types and sorts keys', () =>
        {
            const query = {
                tags: { $in: [ 'admin', 'staff', 'moderator' ] },
                scores: [ 10, 20 ]
            };

            const shape = toAbstractQuery( query );
            expect( shape ).toBe( '{"scores":[<number>],"tags":{"$in":[<string>]}}' );
        });

        it( 'AE3: deduplicates and deterministically sorts mixed-type array tags', () =>
        {
            const query = {
                values: [ 1, 'two', 3, 'four', true ]
            };

            const shape = toAbstractQuery( query );
            expect( shape ).toBe( '{"values":[<boolean>,<number>,<string>]}' );
        });

        it( 'AE4: deterministically sorts commutative branch operators ($or, $and, $nor)', () =>
        {
            const query1 = {
                $or: [ { b: 2 }, { a: 'test' } ]
            };

            const query2 = {
                $or: [ { a: 'other' }, { b: 5 } ]
            };

            const shape1 = toAbstractQuery( query1 );
            const shape2 = toAbstractQuery( query2 );

            expect( shape1 ).toBe( '{"$or":[{"a":<string>},{"b":<number>}]}' );
            expect( shape2 ).toBe( '{"$or":[{"a":<string>},{"b":<number>}]}' );
            expect( shape1 ).toBe( shape2 );
        });

        it( 'sorts commutative $and and $nor branches', () =>
        {
            const andQuery1 = { $and: [ { z: 9 }, { y: 'hello' } ] };
            const andQuery2 = { $and: [ { y: 'world' }, { z: 1 } ] };

            expect( toAbstractQuery( andQuery1 )).toBe( toAbstractQuery( andQuery2 ));
            expect( toAbstractQuery( andQuery1 )).toBe( '{"$and":[{"y":<string>},{"z":<number>}]}' );

            const norQuery1 = { $nor: [ { b: false }, { a: 10 } ] };
            const norQuery2 = { $nor: [ { a: 20 }, { b: true } ] };

            expect( toAbstractQuery( norQuery1 )).toBe( toAbstractQuery( norQuery2 ));
            expect( toAbstractQuery( norQuery1 )).toBe( '{"$nor":[{"a":<number>},{"b":<boolean>}]}' );
        });

        it( 'AE5: handles aggregation pipeline stages and preserves $ field path expressions', () =>
        {
            const pipeline = [
                { $match: { teamId: 't1' } },
                { $group: { _id: '$role', count: { $sum: 1 } } }
            ];

            const shape = toAbstractQuery( pipeline );
            expect( shape ).toBe( '[{"$match":{"teamId":<string>}},{"$group":{"_id":"$role","count":{"$sum":<number>}}}]' );
        });

        it( 'preserves field paths inside $expr in match filters', () =>
        {
            const query = {
                $expr: {
                    $eq: [ '$user.id', 'literal-id' ]
                }
            };

            const shape = toAbstractQuery( query );
            expect( shape ).toBe( '{"$expr":{"$eq":["$user.id",<string>]}}' );
        });

        it( 'abstracts BSON and exotic types (ObjectId, Date, RegExp, Buffer/Binary)', () =>
        {
            const mockObjectId = {
                _bsontype: 'ObjectId',
                toHexString: () => '507f1f77bcf86cd799439011',
                getTimestamp: () => new Date()
            };

            const query = {
                _id: mockObjectId,
                createdAt: new Date( '2026-01-01T00:00:00Z' ),
                pattern: /^abc/i,
                data: Buffer.from( 'binary data' ),
                min: { _bsontype: 'MinKey' },
                max: { _bsontype: 'MaxKey' },
                ts: { _bsontype: 'Timestamp' }
            };

            const shape = toAbstractQuery( query );
            expect( shape ).toBe( '{"_id":<ObjectId>,"createdAt":<Date>,"data":<Binary>,"max":<MaxKey>,"min":<MinKey>,"pattern":<RegExp>,"ts":<Timestamp>}' );
        });

        it( 'handles edge cases: null, primitives, empty objects, empty arrays', () =>
        {
            expect( toAbstractQuery( null )).toBe( 'null' );
            expect( toAbstractQuery( undefined )).toBe( 'undefined' );
            expect( toAbstractQuery( 123 )).toBe( '<number>' );
            expect( toAbstractQuery( 'sample' )).toBe( '<string>' );
            expect( toAbstractQuery( true )).toBe( '<boolean>' );
            expect( toAbstractQuery({})).toBe( '{}' );
            expect( toAbstractQuery([])).toBe( '[]' );
        });
    });

    describe( 'formatAbstractQuery', () =>
    {
        it( 'AE6: formats query shape in Allman style with 2-space indentation', () =>
        {
            const shape = toAbstractQuery({ user: { id: 'u123', active: true } });
            const formatted = formatAbstractQuery( shape, { format: 'allman', tabSize: 2 });

            const expected = [
                '{',
                '  "user":',
                '  {',
                '    "active": <boolean>,',
                '    "id": <string>',
                '  }',
                '}'
            ].join( '\n' );

            expect( formatted ).toBe( expected );
        });

        it( 'AE7: formats query shape in same-line style with 2-space indentation', () =>
        {
            const shape = toAbstractQuery({ user: { id: 'u123', active: true } });
            const formatted = formatAbstractQuery( shape, { format: 'same-line', tabSize: 2 });

            const expected = [
                '{',
                '  "user": {',
                '    "active": <boolean>,',
                '    "id": <string>',
                '  }',
                '}'
            ].join( '\n' );

            expect( formatted ).toBe( expected );
        });

        it( 'accepts raw query object directly in formatAbstractQuery', () =>
        {
            const query = { user: { id: 'u123', active: true } };
            const formatted = formatAbstractQuery( query, { format: 'same-line', tabSize: 2 });

            const expected = [
                '{',
                '  "user": {',
                '    "active": <boolean>,',
                '    "id": <string>',
                '  }',
                '}'
            ].join( '\n' );

            expect( formatted ).toBe( expected );
        });

        it( 'formats arrays of objects across lines', () =>
        {
            const pipeline = [
                { $match: { teamId: 't1' } },
                { $group: { _id: '$role' } }
            ];

            const formatted = formatAbstractQuery( pipeline, { format: 'same-line', tabSize: 2 });
            const expected = [
                '[',
                '  {',
                '    "$match": {',
                '      "teamId": <string>',
                '    }',
                '  },',
                '  {',
                '    "$group": {',
                '      "_id": "$role"',
                '    }',
                '  }',
                ']'
            ].join( '\n' );

            expect( formatted ).toBe( expected );
        });

        it( 'respects custom tabSize (e.g. 4 spaces)', () =>
        {
            const query = { a: 1 };
            const formatted = formatAbstractQuery( query, { tabSize: 4 });

            const expected = [
                '{',
                '    "a": <number>',
                '}'
            ].join( '\n' );

            expect( formatted ).toBe( expected );
        });
    });
});
