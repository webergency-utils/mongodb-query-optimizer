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

    describe( 'variable binding and schema identifier preservation', () =>
    {
        it( 'preserves variable binding in $map and $filter', () =>
        {
            const mapQuery = {
                $map: {
                    input: '$contracts',
                    as: 'contract',
                    in: '$$contract.status'
                }
            };
            expect( toAbstractQuery( mapQuery )).toBe(
                '{"$map":{"as":"contract","in":"$$contract.status","input":"$contracts"}}'
            );

            const filterQuery = {
                $filter: {
                    input: '$items',
                    as: 'item',
                    cond: { $gt: ['$$item.price', 100] }
                }
            };
            expect( toAbstractQuery( filterQuery )).toBe(
                '{"$filter":{"as":"item","cond":{"$gt":["$$item.price",<number>]},"input":"$items"}}'
            );
        });

        it( 'preserves alias in $lookup and $graphLookup while abstracting collection names', () =>
        {
            const lookup = [
                {
                    $lookup: {
                        from: 'users',
                        as: 'user',
                        pipeline: []
                    }
                },
                {
                    $graphLookup: {
                        from: 'employees',
                        startWith: '$reportsTo',
                        connectFromField: 'reportsTo',
                        connectToField: 'name',
                        as: 'reportingHierarchy'
                    }
                }
            ];

            const shape = toAbstractQuery( lookup );
            expect( shape ).toContain( '{"$lookup":{"as":"user","from":<string>,"pipeline":[]}}' );
            expect( shape ).toContain( '"as":"reportingHierarchy"' );
            expect( shape ).toContain( '"from":<string>' );
        });

        it( 'preserves includeArrayIndex in $unwind stage', () =>
        {
            const pipeline = [
                {
                    $unwind: {
                        path: '$items',
                        includeArrayIndex: 'itemIndex',
                        preserveNullAndEmptyArrays: true
                    }
                }
            ];

            expect( toAbstractQuery( pipeline )).toBe(
                '[{"$unwind":{"includeArrayIndex":"itemIndex","path":"$items","preserveNullAndEmptyArrays":<boolean>}}]'
            );
        });

        it( 'preserves and canonically sorts $unset field lists', () =>
        {
            const unsetSingle = { $unset: 'temporaryStatus' };
            expect( toAbstractQuery( unsetSingle )).toBe( '{"$unset":"temporaryStatus"}' );

            const unsetMulti1 = { $unset: ['zebra', 'apple', 'middle'] };
            const unsetMulti2 = { $unset: ['apple', 'middle', 'zebra'] };

            expect( toAbstractQuery( unsetMulti1 )).toBe( '{"$unset":["apple","middle","zebra"]}' );
            expect( toAbstractQuery( unsetMulti2 )).toBe( '{"$unset":["apple","middle","zebra"]}' );
        });

        it( 'preserves field in $getField, $setField, and $unsetField', () =>
        {
            const getFieldShorthand = { $getField: 'zipCode' };
            expect( toAbstractQuery( getFieldShorthand )).toBe( '{"$getField":"zipCode"}' );

            const getFieldObj = {
                $getField: {
                    field: 'zipCode',
                    input: '$address'
                }
            };
            expect( toAbstractQuery( getFieldObj )).toBe(
                '{"$getField":{"field":"zipCode","input":"$address"}}'
            );

            const setFieldObj = {
                $setField: {
                    field: 'taxRate',
                    input: '$pricing',
                    value: 0.15
                }
            };
            expect( toAbstractQuery( setFieldObj )).toBe(
                '{"$setField":{"field":"taxRate","input":"$pricing","value":<number>}}'
            );
        });

        it( 'preserves partitionByFields in $densify and $fill', () =>
        {
            const densify = {
                $densify: {
                    field: 'timestamp',
                    partitionByFields: ['region', 'carrier']
                }
            };
            expect( toAbstractQuery( densify )).toBe(
                '{"$densify":{"field":"timestamp","partitionByFields":["carrier","region"]}}'
            );
        });

        it( 'does not treat literal values in standard $match as identifiers', () =>
        {
            const filterWithAsField = {
                $match: {
                    as: 'consultant',
                    field: 'testValue'
                }
            };
            expect( toAbstractQuery( filterWithAsField )).toBe(
                '{"$match":{"as":<string>,"field":<string>}}'
            );
        });

        it( 'formats the full complex real-world pipeline preserving identifiers', () =>
        {
            const pipeline = [
                {
                    $match: {
                        deleted: { $ne: true }
                    }
                },
                {
                    $addFields: {
                        contracts: {
                            $sortArray: {
                                input: '$contracts',
                                sortBy: {
                                    'employment.interval.start': -1
                                }
                            }
                        },
                        statuses: {
                            $setUnion: [
                                {
                                    $map: {
                                        input: '$contracts',
                                        as: 'contract',
                                        in: '$$contract.status'
                                    }
                                },
                                []
                            ]
                        }
                    }
                },
                {
                    $unset: ['statuses']
                }
            ];

            const shape = toAbstractQuery( pipeline );
            expect( shape ).toContain( '"as":"contract"' );
            expect( shape ).toContain( '"in":"$$contract.status"' );
            expect( shape ).toContain( '{"$unset":["statuses"]}' );

            const formatted = formatAbstractQuery( pipeline, { format: 'allman' });
            expect( formatted ).toContain( '"as": "contract"' );
            expect( formatted ).toContain( '"in": "$$contract.status"' );
            expect( formatted ).toContain( '"$unset": ["statuses"]' );
        });
    });

    describe( 'array and string index preservation', () =>
    {
        it( 'preserves integer indexes in $arrayElemAt for both head and tail access', () =>
        {
            const headAccess = {
                $arrayElemAt: [ '$contracts', 0 ]
            };
            expect( toAbstractQuery( headAccess )).toBe( '{"$arrayElemAt":["$contracts",0]}' );

            const tailAccess = {
                $arrayElemAt: [ '$contracts', -1 ]
            };
            expect( toAbstractQuery( tailAccess )).toBe( '{"$arrayElemAt":["$contracts",-1]}' );

            const specificIndex = {
                $arrayElemAt: [ '$contracts', 2 ]
            };
            expect( toAbstractQuery( specificIndex )).toBe( '{"$arrayElemAt":["$contracts",2]}' );

            const nestedExpr = {
                $arrayElemAt: [
                    {
                        $filter: {
                            input: '$contracts',
                            as: 'c',
                            cond: { $eq: [ '$$c.active', true ] }
                        }
                    },
                    0
                ]
            };
            expect( toAbstractQuery( nestedExpr )).toBe(
                '{"$arrayElemAt":[{"$filter":{"as":"c","cond":{"$eq":["$$c.active",<boolean>]},"input":"$contracts"}},0]}'
            );
        });

        it( 'preserves slice counts and offsets in aggregation $slice', () =>
        {
            const sliceCount = {
                $slice: [ '$contracts', 5 ]
            };
            expect( toAbstractQuery( sliceCount )).toBe( '{"$slice":["$contracts",5]}' );

            const sliceNegative = {
                $slice: [ '$contracts', -1 ]
            };
            expect( toAbstractQuery( sliceNegative )).toBe( '{"$slice":["$contracts",-1]}' );

            const sliceOffsetAndCount = {
                $slice: [ '$contracts', 0, 10 ]
            };
            expect( toAbstractQuery( sliceOffsetAndCount )).toBe( '{"$slice":["$contracts",0,10]}' );
        });

        it( 'preserves slice limits and bounds in projection $slice', () =>
        {
            const projSliceInt = {
                comments: { $slice: 5 }
            };
            expect( toAbstractQuery( projSliceInt )).toBe( '{"comments":{"$slice":5}}' );

            const projSliceNegative = {
                comments: { $slice: -5 }
            };
            expect( toAbstractQuery( projSliceNegative )).toBe( '{"comments":{"$slice":-5}}' );

            const projSliceArray = {
                comments: { $slice: [ 20, 10 ] }
            };
            expect( toAbstractQuery( projSliceArray )).toBe( '{"comments":{"$slice":[20,10]}}' );
        });

        it( 'preserves start and end index bounds in $indexOfArray', () =>
        {
            const indexOfSimple = {
                $indexOfArray: [ '$tags', 'admin' ]
            };
            expect( toAbstractQuery( indexOfSimple )).toBe( '{"$indexOfArray":["$tags",<string>]}' );

            const indexOfWithStart = {
                $indexOfArray: [ '$tags', 'admin', 0 ]
            };
            expect( toAbstractQuery( indexOfWithStart )).toBe( '{"$indexOfArray":["$tags",<string>,0]}' );

            const indexOfWithBounds = {
                $indexOfArray: [ '$tags', 'admin', 1, 10 ]
            };
            expect( toAbstractQuery( indexOfWithBounds )).toBe( '{"$indexOfArray":["$tags",<string>,1,10]}' );
        });

        it( 'preserves string slice and index offsets in $substrCP and $indexOfCP', () =>
        {
            const substr = {
                $substrCP: [ '$createdAt', 0, 10 ]
            };
            expect( toAbstractQuery( substr )).toBe( '{"$substrCP":["$createdAt",0,10]}' );

            const indexOfCP = {
                $indexOfCP: [ '$name', 'Doe', 0, 50 ]
            };
            expect( toAbstractQuery( indexOfCP )).toBe( '{"$indexOfCP":["$name",<string>,0,50]}' );
        });

        it( 'preserves integer boundaries and steps in $range', () =>
        {
            const literalRange = {
                $range: [ 0, 10, 1 ]
            };
            expect( toAbstractQuery( literalRange )).toBe( '{"$range":[0,10,1]}' );

            const exprRange = {
                $range: [ 0, { $size: '$contracts' }, 1 ]
            };
            expect( toAbstractQuery( exprRange )).toBe( '{"$range":[0,{"$size":"$contracts"},1]}' );
        });

        it( 'formats abstract query with $arrayElemAt in Allman and same-line styles', () =>
        {
            const query = {
                $addFields: {
                    latestContract: {
                        $arrayElemAt: [ '$contracts', 0 ]
                    }
                }
            };

            const allman = formatAbstractQuery( query, { format: 'allman' });
            expect( allman ).toContain( '"$arrayElemAt": ["$contracts", 0]' );

            const sameLine = formatAbstractQuery( query, { format: 'same-line' });
            expect( sameLine ).toContain( '"$arrayElemAt": ["$contracts", 0]' );
        });
    });
});

