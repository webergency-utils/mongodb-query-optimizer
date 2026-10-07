import { describe, expect, it } from 'vitest';
import {
    runMockPipeline,
} from './helpers/mock-engine.js';

describe('MongoDB-aligned mock boundaries (supplemental only)', () =>
{
    it('emits no count document for an empty input stream', () =>
    {
        expect(runMockPipeline([], [{ $count: 'total' }])).toEqual([]);
    });

    it('preserves empty, missing, and null unwind inputs distinctly', () =>
    {
        const result = runMockPipeline([
            { _id: 1, values: [] },
            { _id: 2 },
            { _id: 3, values: null },
        ], [{
            $unwind: {
                path: '$values',
                preserveNullAndEmptyArrays: true,
                includeArrayIndex: 'index',
            },
        }]);

        expect(result).toEqual([
            { _id: 1, index: null },
            { _id: 2, index: null },
            { _id: 3, values: null, index: null },
        ]);
        expect('values' in result[0]!).toBe(false);
        expect('values' in result[1]!).toBe(false);
    });

    it('distinguishes computed inclusion from exclusion projection mode', () =>
    {
        expect(runMockPipeline([
            {
                _id: 1,
                kept: 'yes',
                nested: { kept: true, removed: true },
            },
        ], [{
            $project: {
                constant: 5,
                array: [],
                object: {},
                missing: 1,
                _id: 0,
            },
        }])).toEqual([
            {
                constant: 5,
                array: [],
                object: {},
            },
        ]);

        expect(runMockPipeline([
            {
                _id: 1,
                nested: { kept: true, removed: true },
            },
        ], [{
            $project: {
                'nested.removed': 0,
            },
        }])).toEqual([
            {
                _id: 1,
                nested: { kept: true },
            },
        ]);

        expect(() => runMockPipeline(
            [{ _id: 1, kept: true, removed: true }],
            [{ $project: { kept: 1, removed: 0 } }],
        )).toThrow('invalid mixed projection');
        expect(() => runMockPipeline(
            [{ _id: 1 }],
            [{ $project: {} }],
        )).toThrow('empty projection');
    });

    it('rejects invalid logical arrays instead of inventing match semantics', () =>
    {
        for (const filter of [
            { $and: [] },
            { $or: [] },
            { $and: { value: 1 } },
            { value: { $in: 1 } },
        ])
        {
            expect(() => runMockPipeline(
                [{ _id: 1, value: 1 }],
                [{ $match: filter }],
            )).toThrow();
        }
    });

    it('evaluates $facet subpipelines independently and bundles results into a document', () =>
    {
        const data = [
            { _id: 1, category: 'electronics', price: 100 },
            { _id: 2, category: 'books', price: 20 },
            { _id: 3, category: 'electronics', price: 200 },
        ];
        const pipeline = [
            {
                $facet: {
                    categories: [
                        { $group: { _id: '$category', count: { $sum: 1 } } },
                        { $sort: { count: -1 } },
                    ],
                    totalPrice: [
                        { $group: { _id: null, total: { $sum: '$price' } } },
                    ],
                },
            },
        ];

        const result = runMockPipeline(data, pipeline);
        expect(result).toHaveLength(1);
        expect(result[0].categories).toHaveLength(2);
        expect(result[0].totalPrice).toEqual([{ _id: null, total: 320 }]);
    });

    it('evaluates diverse $group accumulators ($avg, $min, $max, $first, $last, $push)', () =>
    {
        const data = [
            { _id: 1, group: 'A', val: 10 },
            { _id: 2, group: 'A', val: 30 },
            { _id: 3, group: 'B', val: 50 },
        ];
        const pipeline = [
            {
                $group: {
                    _id: '$group',
                    avgVal: { $avg: '$val' },
                    minVal: { $min: '$val' },
                    maxVal: { $max: '$val' },
                    firstVal: { $first: '$val' },
                    lastVal: { $last: '$val' },
                    allVals: { $push: '$val' },
                },
            },
            { $sort: { _id: 1 } },
        ];

        const result = runMockPipeline(data, pipeline);
        expect(result).toEqual([
            {
                _id: 'A',
                avgVal: 20,
                minVal: 10,
                maxVal: 30,
                firstVal: 10,
                lastVal: 30,
                allVals: [10, 30],
            },
            {
                _id: 'B',
                avgVal: 50,
                minVal: 50,
                maxVal: 50,
                firstVal: 50,
                lastVal: 50,
                allVals: [50],
            },
        ]);
    });

    it('handles $elemMatch and $exists correctly on arrays and objects', () =>
    {
        const data = [
            { _id: 1, tags: ['tech', 'news'], items: [{ sku: 'A', qty: 5 }, { sku: 'B', qty: 0 }] },
            { _id: 2, tags: ['gardening'], items: [{ sku: 'C', qty: 2 }] },
            { _id: 3, items: [] },
        ];

        const elemMatchResult = runMockPipeline(data, [
            { $match: { items: { $elemMatch: { sku: 'A', qty: { $gt: 0 } } } } },
        ]);
        expect(elemMatchResult).toHaveLength(1);
        expect(elemMatchResult[0]._id).toBe(1);

        const existsResult = runMockPipeline(data, [
            { $match: { tags: { $exists: true } } },
        ]);
        expect(existsResult).toHaveLength(2);

        const notExistsResult = runMockPipeline(data, [
            { $match: { tags: { $exists: false } } },
        ]);
        expect(notExistsResult).toHaveLength(1);
        expect(notExistsResult[0]._id).toBe(3);
    });
});

describe( 'mock engine fidelity with MongoDB 8 expression semantics', () =>
{
    const project = ( doc: Record<string, unknown>, expression: unknown ): unknown =>
    {
        return runMockPipeline([ doc ], [{ $project: { _id: 0, r: expression } }])[0]?.r;
    };

    it( 'returns null for arithmetic over missing or null operands', () =>
    {
        expect( project({ n: null }, { $add: [ '$missing', 1 ] })).toBeNull();
        expect( project({ n: null }, { $multiply: [ '$n', 2 ] })).toBeNull();
        expect( project({ n: null }, { $subtract: [ '$missing', 2 ] })).toBeNull();
        expect( project({ n: null }, { $divide: [ '$n', 2 ] })).toBeNull();
        expect( project({ a: 2, b: 3 }, { $add: [ '$a', '$b', 1 ] })).toBe( 6 );
        expect( project({ a: 2, b: 3 }, { $subtract: [ '$b', '$a' ] })).toBe( 1 );
        expect( project({ a: 2, b: 3 }, { $multiply: [ '$a', '$b' ] })).toBe( 6 );
        expect( project({ a: 6, b: 3 }, { $divide: [ '$a', '$b' ] })).toBe( 2 );
    });

    it( 'throws where MongoDB rejects arithmetic input', () =>
    {
        expect(() => project({}, { $add: [ 'x', 1 ] })).toThrow( 'only supports numeric types' );
        expect(() => project({}, { $divide: [ 1, 0 ] })).toThrow( 'divide by zero' );
    });

    it( 'throws for $size of a missing, null or scalar value', () =>
    {
        expect(() => project({}, { $size: '$missing' })).toThrow( '$size argument must be an array' );
        expect(() => project({ n: null }, { $size: '$n' })).toThrow( '$size argument must be an array' );
        expect(() => project({ s: 5 }, { $size: '$s' })).toThrow( '$size argument must be an array' );
        expect( project({ a: [ 1, 2 ] }, { $size: '$a' })).toBe( 2 );
    });

    it( 'applies dotted $addFields writes like MongoDB', () =>
    {
        const write = ( doc: Record<string, unknown> ): unknown =>
        {
            return runMockPipeline([ doc ], [{ $addFields: { 'arr.v': 5 } }])[0];
        };

        expect( write({ arr: [ {}, { v: 1, w: 2 } ] })).toEqual({ arr: [ { v: 5 }, { v: 5, w: 2 } ] });
        expect( write({ arr: [] })).toEqual({ arr: [] });
        expect( write({ arr: 7 })).toEqual({ arr: { v: 5 } });
        expect( write({ arr: null })).toEqual({ arr: { v: 5 } });
        expect( write({ arr: [ 1, {}, [ {} ] ] })).toEqual({ arr: [ { v: 5 }, { v: 5 }, [ { v: 5 } ] ] });
        expect( write({ x: 1 })).toEqual({ x: 1, arr: { v: 5 } });
    });

    it( 'does not mutate the input document on dotted writes', () =>
    {
        const input = [ { nested: { a: 1 } } ];
        const output = runMockPipeline( input, [{ $addFields: { 'nested.b': 2 } }]);

        expect( input ).toEqual([ { nested: { a: 1 } } ]);
        expect( output ).toEqual([ { nested: { a: 1, b: 2 } } ]);
    });

    it( 'evaluates $filter with as, $$this, limit and MongoDB truthiness', () =>
    {
        const doc = { a: [ 1, 2, 3 ], n: null, s: 5 };

        expect( project( doc, { $filter: { input: '$a', as: 'x', cond: { $gt: [ '$$x', 1 ] } } })).toEqual([ 2, 3 ]);
        expect( project( doc, { $filter: { input: '$a', cond: { $gt: [ '$$this', 1 ] } } })).toEqual([ 2, 3 ]);
        expect( project( doc, { $filter: { input: '$a', cond: true, limit: 2 } })).toEqual([ 1, 2 ]);
        expect( project( doc, { $filter: { input: '$a', cond: {} } })).toEqual([ 1, 2, 3 ]);
        expect( project( doc, { $filter: { input: '$a', cond: '' } })).toEqual([ 1, 2, 3 ]);
        expect( project( doc, { $filter: { input: '$a', cond: 0 } })).toEqual([]);
        expect( project( doc, { $filter: { input: '$n', cond: true } })).toBeNull();
        expect( project( doc, { $filter: { input: '$missing', cond: true } })).toBeNull();
        expect(() => project( doc, { $filter: { input: '$s', cond: true } })).toThrow( '$filter input must be an array' );
    });

    it( 'uses MongoDB truthiness for logical operators', () =>
    {
        expect( project({}, { $and: [] })).toBe( true );
        expect( project({}, { $or: [] })).toBe( false );
        expect( project({}, { $and: [ '', {}, [] ] })).toBe( true );
        expect( project({}, { $and: [ { $literal: '$x' } ] })).toBe( true );
        expect( project({}, { $or: [ 0, null ] })).toBe( false );
        expect( project({}, { $not: [ '' ] })).toBe( false );
    });

    it( 'evaluates $cond, $literal, $mergeObjects, $sum and comparisons', () =>
    {
        expect( project({ a: 1 }, { $cond: [ '$a', 'yes', 'no' ] })).toBe( 'yes' );
        expect( project({ a: 0 }, { $cond: { if: '$a', then: 'yes', else: 'no' } })).toBe( 'no' );
        expect( project({}, { $literal: { $add: [ 1, 2 ] } })).toEqual({ $add: [ 1, 2 ] });
        expect( project({ n: null }, { $mergeObjects: [ { a: 1 }, '$n', { b: 2 } ] })).toEqual({ a: 1, b: 2 });
        expect(() => project({}, { $mergeObjects: [ 1 ] })).toThrow( 'requires object inputs' );
        expect( project({ a: [ 1, 'x', 2 ] }, { $sum: '$a' })).toBe( 3 );
        expect( project({}, { $sum: [ 1, 'x', 2 ] })).toBe( 3 );
        expect( project({ a: 2 }, { $gte: [ '$a', 2 ] })).toBe( true );
        expect( project({ a: 2 }, { $lte: [ '$a', 1 ] })).toBe( false );
        expect( project({ a: 2 }, { $lt: [ '$a', 3 ] })).toBe( true );
        expect( project({ a: 2 }, { $eq: [ '$a', 2 ] })).toBe( true );
        expect( project({ a: 2 }, { $ne: [ '$a', 2 ] })).toBe( false );
        expect( project({ t: 'Ab' }, { $toUpper: '$t' })).toBe( 'AB' );
        expect( project({ t: 'Ab' }, { $toLower: '$t' })).toBe( 'ab' );
        expect( project({ t: 1 }, { $toLower: '$t' })).toBe( 1 );
        expect( project({ t: 'a' }, { $concat: [ '$t', 'b' ] })).toBe( 'ab' );
        expect( project({ n: null }, { $ifNull: [ '$n', 'd' ] })).toBe( 'd' );
    });

    it( 'resolves system and scoped variables and rejects unknown ones', () =>
    {
        expect( project({ a: 1 }, '$$ROOT.a' )).toBe( 1 );
        expect( project({ a: 1 }, '$$CURRENT' )).toEqual({ a: 1 });
        expect( project({ a: 1 }, '$$REMOVE' )).toBeUndefined();
        expect(() => project({ a: 1 }, '$$unknown' )).toThrow( 'does not define variable $$unknown' );
    });

    it( 'throws a named error for expression operators it does not implement', () =>
    {
        expect(() => project({}, { $foo: 1 })).toThrow( 'does not implement expression operator $foo' );
    });

    it( 'sorts with MongoDB type order and array semantics', () =>
    {
        const docs = [
            { _id: 1, k: 'b' },
            { _id: 2, k: 3 },
            { _id: 3 },
            { _id: 4, k: [] },
            { _id: 5, k: [ 9, 1 ] },
            { _id: 6, k: null },
            { _id: 7, k: true },
            { _id: 8, k: { a: 1 } },
        ];
        const ascending = runMockPipeline( docs, [{ $sort: { k: 1, _id: 1 } }]).map(( doc ) => doc._id );
        const descending = runMockPipeline( docs, [{ $sort: { k: -1, _id: 1 } }]).map(( doc ) => doc._id );

        expect( ascending ).toEqual([ 4, 3, 6, 5, 2, 1, 8, 7 ]);
        expect( descending ).toEqual([ 7, 8, 1, 5, 2, 3, 6, 4 ]);
    });
});
