import { describe, expect, it } from 'vitest';
import { RedundantSortEliminationPass } from '../src/passes/redundant-sort-elimination';
import 
{ 
    isAdjacentSort, 
    isDeadSortBeforeBucket,
    isDeadSortBeforeCount, 
    isDeadSortBeforeGroup, 
    isDeadSortBeforeSortByCount, 
    isEmptySort, 
    isOrderAgnosticBucket,
    isOrderAgnosticGroup, 
    proveRedundantSortElimination,
    proveRedundantSortEliminationInPipeline
} 
from '../src/passes/sort-proofs';
import { optimizePipeline } from './helpers/pre-gate-optimizer.js';
import { runMockPipeline } from './helpers/mock-engine';

describe( 'sort-proofs unit and branch analysis', () =>
{
    it( 'evaluates isOrderAgnosticGroup across exhaustive branches', () =>
    {
        expect( isOrderAgnosticGroup( null )).toBe( false );
        expect( isOrderAgnosticGroup( Object.create( null ) )).toBe( false );
        const nullProtoGroup = Object.create( null );
        nullProtoGroup.$group = { _id: '$dept' };
        expect( isOrderAgnosticGroup( nullProtoGroup )).toBe( true );
        expect( isOrderAgnosticGroup( [ 1, 2 ] )).toBe( false );
        expect( isOrderAgnosticGroup( { $match: { a: 1 } } )).toBe( false );
        expect( isOrderAgnosticGroup( { $group: 'not-an-object' } )).toBe( false );
        expect( isOrderAgnosticGroup( { $group: { _id: '$dept', total: 'invalid' } } )).toBe( false );
        expect( isOrderAgnosticGroup( { $group: { _id: '$dept', total: { $sum: 1, $avg: 2 } } } )).toBe( false );
        expect( isOrderAgnosticGroup( { $group: { _id: '$dept', total: { $unknown: 1 } } } )).toBe( false );
        expect( isOrderAgnosticGroup( { $group: { _id: '$dept', firstVal: { $first: '$val' } } } )).toBe( false );
        expect( isOrderAgnosticGroup( { $group: { _id: '$dept', lastVal: { $last: '$val' } } } )).toBe( false );
        expect( isOrderAgnosticGroup( { $group: { _id: '$dept', pushed: { $push: '$val' } } } )).toBe( false );

        // Valid order-agnostic groups
        expect( isOrderAgnosticGroup( { $group: { _id: '$dept' } } )).toBe( true );
        expect( isOrderAgnosticGroup( { $group: { _id: '$dept', total: { $sum: '$amt' }, avg: { $avg: '$amt' } } } )).toBe( true );
        expect( isOrderAgnosticGroup( { $group: { _id: '$dept', min: { $min: '$amt' }, max: { $max: '$amt' }, cnt: { $count: {} } } } )).toBe( true );
        expect( isOrderAgnosticGroup( { $group: { _id: '$dept', std1: { $stdDevPop: '$amt' }, std2: { $stdDevSamp: '$amt' } } } )).toBe( true );
    });

    it( 'evaluates isOrderAgnosticBucket and isDeadSortBeforeBucket across exhaustive branches', () =>
    {
        expect( isOrderAgnosticBucket( null )).toBe( false );
        expect( isOrderAgnosticBucket({ $match: { a: 1 } })).toBe( false );
        expect( isOrderAgnosticBucket({ $bucket: 'invalid' })).toBe( false );
        expect( isOrderAgnosticBucket({ $bucket: { boundaries: [ 0, 10 ] } })).toBe( false );
        expect( isOrderAgnosticBucket({ $bucket: { groupBy: '$a', boundaries: [ 0, 10 ] } })).toBe( true );
        expect( isOrderAgnosticBucket({ $bucketAuto: { groupBy: '$a', buckets: 5 } })).toBe( true );
        expect( isOrderAgnosticBucket({ $bucket: { groupBy: '$a', output: 'invalid' } })).toBe( false );
        expect( isOrderAgnosticBucket({ $bucket: { groupBy: '$a', output: { c: 'invalid' } } })).toBe( false );
        expect( isOrderAgnosticBucket({ $bucket: { groupBy: '$a', output: { c: { $sum: 1, $avg: 2 } } } })).toBe( false );
        expect( isOrderAgnosticBucket({ $bucket: { groupBy: '$a', output: { c: { $push: '$x' } } } })).toBe( false );
        expect( isOrderAgnosticBucket({ $bucket: { groupBy: '$a', output: { c: { $sum: 1 }, m: { $max: '$x' } } } })).toBe( true );

        expect( isDeadSortBeforeBucket( null, { $bucket: { groupBy: '$a' } } )).toBe( false );
        expect( isDeadSortBeforeBucket({ $sort: { a: 1 } }, { $bucket: { groupBy: '$a', output: { p: { $push: '$x' } } } })).toBe( false );
        expect( isDeadSortBeforeBucket({ $sort: { a: 1 } }, { $bucket: { groupBy: '$a' } })).toBe( true );
    });

    it( 'evaluates isEmptySort across branches', () =>
    {
        expect( isEmptySort( null )).toBe( false );
        expect( isEmptySort( { $match: {} } )).toBe( false );
        expect( isEmptySort( { $sort: 'string' } )).toBe( false );
        expect( isEmptySort( { $sort: { a: 1 } } )).toBe( false );
        expect( isEmptySort( { $sort: {} } )).toBe( true );
    });

    it( 'evaluates isAdjacentSort across branches', () =>
    {
        expect( isAdjacentSort( null, { $sort: { a: 1 } } )).toBe( false );
        expect( isAdjacentSort( { $sort: { a: 1 } }, null )).toBe( false );
        expect( isAdjacentSort( { $match: { a: 1 } }, { $sort: { a: 1 } } )).toBe( false );
        expect( isAdjacentSort( { $sort: { a: 1 } }, { $match: { a: 1 } } )).toBe( false );
        expect( isAdjacentSort( { $sort: 'invalid' }, { $sort: { a: 1 } } )).toBe( false );
        expect( isAdjacentSort( { $sort: { a: 1 } }, { $sort: 'invalid' } )).toBe( false );
        expect( isAdjacentSort( { $sort: { a: 1 } }, { $sort: { b: -1 } } )).toBe( true );
    });

    it( 'evaluates isDeadSortBeforeGroup across branches', () =>
    {
        expect( isDeadSortBeforeGroup( null, { $group: { _id: '$dept' } } )).toBe( false );
        expect( isDeadSortBeforeGroup( { $match: { a: 1 } }, { $group: { _id: '$dept' } } )).toBe( false );
        expect( isDeadSortBeforeGroup( { $sort: 'not-object' }, { $group: { _id: '$dept' } } )).toBe( false );
        expect( isDeadSortBeforeGroup( { $sort: { a: 1 } }, { $group: { _id: '$dept', p: { $push: '$a' } } } )).toBe( false );
        expect( isDeadSortBeforeGroup( { $sort: { a: 1 } }, { $group: { _id: '$dept', total: { $sum: 1 } } } )).toBe( true );
    });

    it( 'evaluates isDeadSortBeforeCount across branches', () =>
    {
        expect( isDeadSortBeforeCount( null, { $count: 'total' } )).toBe( false );
        expect( isDeadSortBeforeCount( { $sort: { a: 1 } }, null )).toBe( false );
        expect( isDeadSortBeforeCount( { $match: { a: 1 } }, { $count: 'total' } )).toBe( false );
        expect( isDeadSortBeforeCount( { $sort: 'not-object' }, { $count: 'total' } )).toBe( false );
        expect( isDeadSortBeforeCount( { $sort: { a: 1 } }, { $match: { a: 1 } } )).toBe( false );
        expect( isDeadSortBeforeCount( { $sort: { a: 1 } }, { $count: '' } )).toBe( false );
        expect( isDeadSortBeforeCount( { $sort: { a: 1 } }, { $count: 123 } )).toBe( false );
        expect( isDeadSortBeforeCount( { $sort: { a: 1 } }, { $count: 'total' } )).toBe( true );
    });

    it( 'evaluates isDeadSortBeforeSortByCount across branches', () =>
    {
        expect( isDeadSortBeforeSortByCount( null, { $sortByCount: '$dept' } )).toBe( false );
        expect( isDeadSortBeforeSortByCount( { $sort: { a: 1 } }, null )).toBe( false );
        expect( isDeadSortBeforeSortByCount( { $match: { a: 1 } }, { $sortByCount: '$dept' } )).toBe( false );
        expect( isDeadSortBeforeSortByCount( { $sort: 'not-object' }, { $sortByCount: '$dept' } )).toBe( false );
        expect( isDeadSortBeforeSortByCount( { $sort: { a: 1 } }, { $match: { a: 1 } } )).toBe( false );
        expect( isDeadSortBeforeSortByCount( { $sort: { a: 1 } }, { $sortByCount: '$dept', extra: 1 } )).toBe( false );
        expect( isDeadSortBeforeSortByCount( { $sort: { a: 1 } }, { $sortByCount: '$dept' } )).toBe( true );
    });

    it( 'evaluates proveRedundantSortElimination', () =>
    {
        expect( proveRedundantSortElimination( { $sort: { a: 1 } }, { $sort: { b: 1 } } )).toBe( true );
        expect( proveRedundantSortElimination( { $sort: { a: 1 } }, { $group: { _id: '$dept', s: { $sum: 1 } } } )).toBe( true );
        expect( proveRedundantSortElimination( { $sort: { a: 1 } }, { $bucket: { groupBy: '$dept', boundaries: [ 0, 10 ] } } )).toBe( true );
        expect( proveRedundantSortElimination( { $sort: { a: 1 } }, { $count: 'total' } )).toBe( true );
        expect( proveRedundantSortElimination( { $sort: { a: 1 } }, { $sortByCount: '$dept' } )).toBe( true );
        expect( proveRedundantSortElimination( { $sort: { a: 1 } }, { $match: { a: 1 } } )).toBe( false );
    });
});

describe( 'RedundantSortEliminationPass execution and parity', () =>
{
    const pass = new RedundantSortEliminationPass();

    it( 'eliminates empty sort stages', () =>
    {
        const pipeline =
        [
            { $match: { status: 'active' } },
            { $sort: {} },
            { $project: { _id: 1 } }
        ];

        const optimized = pass.execute( pipeline );

        expect( optimized ).toEqual(
        [
            { $match: { status: 'active' } },
            { $project: { _id: 1 } }
        ]);
    });

    it( 'eliminates adjacent sort overwrites in sequence', () =>
    {
        const pipeline =
        [
            { $sort: { a: 1 } },
            { $sort: { b: -1 } },
            { $sort: { c: 1 } }
        ];

        const optimized = pass.execute( pipeline );

        expect( optimized ).toEqual(
        [
            { $sort: { c: 1 } }
        ]);
    });

    it( 'eliminates dead sorts preceding order-agnostic groups', () =>
    {
        const pipeline =
        [
            { $sort: { createdAt: -1 } },
            { $group: { _id: '$dept', total: { $sum: '$amt' } } }
        ];

        const optimized = pass.execute( pipeline );

        expect( optimized ).toEqual(
        [
            { $group: { _id: '$dept', total: { $sum: '$amt' } } }
        ]);
    });

    it( 'preserves sort when preceding order-sensitive accumulators', () =>
    {
        const pipeline =
        [
            { $sort: { createdAt: 1 } },
            { $group: { _id: '$dept', firstItem: { $first: '$item' } } }
        ];

        const optimized = pass.execute( pipeline );

        expect( optimized ).toEqual( pipeline );
    });

    it( 'eliminates sort preceding count', () =>
    {
        const pipeline =
        [
            { $match: { active: true } },
            { $sort: { score: -1 } },
            { $count: 'numActive' }
        ];

        const optimized = pass.execute( pipeline );

        expect( optimized ).toEqual(
        [
            { $match: { active: true } },
            { $count: 'numActive' }
        ]);
    });

    it( 'eliminates sort preceding sortByCount', () =>
    {
        const pipeline =
        [
            { $sort: { name: 1 } },
            { $sortByCount: '$role' }
        ];

        const optimized = pass.execute( pipeline );

        expect( optimized ).toEqual(
        [
            { $sortByCount: '$role' }
        ]);
    });

    it( 'preserves execution parity through optimizePipeline on real dataset', () =>
    {
        const dataset =
        [
            { _id: 1, dept: 'Sales', val: 10, score: 99 },
            { _id: 2, dept: 'Sales', val: 20, score: 55 },
            { _id: 3, dept: 'Engineering', val: 30, score: 88 },
            { _id: 4, dept: 'Engineering', val: 40, score: 77 }
        ];

        const rawPipeline =
        [
            { $sort: { score: 1 } },
            { $group: { _id: '$dept', total: { $sum: '$val' } } },
            { $sort: { _id: 1 } }
        ];

        const optimizedPipeline = optimizePipeline( rawPipeline );
        const rawResult = runMockPipeline( dataset, rawPipeline );
        const optimizedResult = runMockPipeline( dataset, optimizedPipeline );

        expect( rawResult ).toEqual( optimizedResult );
        expect( optimizedPipeline ).toEqual(
        [
            { $project: { dept: 1, val: 1, _id: 0 } },
            { $group: { _id: '$dept', total: { $sum: '$val' } } },
            { $sort: { _id: 1 } }
        ]);
    });

    it( 'evaluates proveRedundantSortElimination with context', () =>
    {
        const pass = new RedundantSortEliminationPass();
        const pipeline = [
            { $sort: { a: 1 } },
            { $sort: { b: 1 } }
        ];

        expect( pass.execute( pipeline, { strictFieldOrder: true, strictErrors: true } ) ).toEqual([
            { $sort: { b: 1 } }
        ]);

        expect( proveRedundantSortElimination( { $sort: { a: 1 } }, { $sort: { b: 1 } }, { strictFieldOrder: true, strictErrors: true } ) ).toBe( true );
        expect( proveRedundantSortElimination( { $sort: 'invalid' }, { $sort: { b: 1 } }, { strictFieldOrder: false, strictErrors: true } ) ).toBe( false );
    });

    it( 'eliminates dead sorts across order-insensitive intermediate stages and stops on barriers', () =>
    {
        const pass = new RedundantSortEliminationPass();
        const pipeline = [
            { $sort: { a: 1 } },
            { $match: { status: 'active' } },
            { $addFields: { x: 1 } },
            { $project: { dept: 1, salary: 1 } },
            { $unset: 'temp' },
            { $lookup: { from: 'items', localField: 'dept', foreignField: 'dept', as: 'items' } },
            { $group: { _id: '$dept', total: { $sum: '$salary' } } }
        ];

        expect( pass.execute( pipeline )).toEqual( pipeline.slice( 1 ));

        // Preserves sort when an order-sensitive stage ($limit) sits in between
        const limitBetween = [
            { $sort: { a: 1 } },
            { $limit: 5 },
            { $sort: { b: -1 } }
        ];
        expect( pass.execute( limitBetween )).toEqual( limitBetween );

        // Preserves sort when intermediate stage is malformed, volatile, or error-prone under strictErrors
        expect( proveRedundantSortEliminationInPipeline(
            [ { $sort: { a: 1 } }, { $addFields: { r: { $rand: {} } } }, { $sort: { b: 1 } } ],
            0
        )).toBe( false );

        expect( proveRedundantSortEliminationInPipeline(
            [ { $sort: { a: 1 } }, { $addFields: { q: { $divide: [ '$a', '$b' ] } } }, { $sort: { b: 1 } } ],
            0,
            { strictFieldOrder: false, strictErrors: true }
        )).toBe( false );

        expect( proveRedundantSortEliminationInPipeline(
            [ { $sort: 'invalid' }, { $sort: { b: 1 } } ],
            0,
            { strictFieldOrder: false, strictErrors: true }
        )).toBe( false );

        // Eliminates dead sort across $unwind before order-agnostic collapsing stages ($group, $bucket, $count, $sortByCount)
        expect( proveRedundantSortEliminationInPipeline(
            [ { $sort: { a: 1 } }, { $unwind: '$items' }, { $group: { _id: '$items.cat', s: { $sum: 1 } } } ],
            0
        )).toBe( true );
        expect( proveRedundantSortEliminationInPipeline(
            [ { $sort: { a: 1 } }, { $unwind: '$items' }, { $bucket: { groupBy: '$items.price', boundaries: [ 0, 10, 20 ] } } ],
            0
        )).toBe( true );
        expect( proveRedundantSortEliminationInPipeline(
            [ { $sort: { a: 1 } }, { $unwind: '$items' }, { $count: 'total' } ],
            0
        )).toBe( true );
        expect( proveRedundantSortEliminationInPipeline(
            [ { $sort: { a: 1 } }, { $unwind: '$items' }, { $sortByCount: '$items.tag' } ],
            0
        )).toBe( true );

        // Preserves sort before $unwind when followed by another $sort (to preserve tie-breaking order)
        expect( proveRedundantSortEliminationInPipeline(
            [ { $sort: { a: 1 } }, { $unwind: '$items' }, { $sort: { 'items.price': 1 } } ],
            0
        )).toBe( false );
    });
});
