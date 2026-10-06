import { describe, expect, it } from 'vitest';
import { RedundantSortEliminationPass } from '../src/passes/redundant-sort-elimination';
import 
{ 
    isAdjacentSort, 
    isDeadSortBeforeCount, 
    isDeadSortBeforeGroup, 
    isDeadSortBeforeSortByCount, 
    isEmptySort, 
    isOrderAgnosticGroup, 
    proveRedundantSortElimination 
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
            { $group: { _id: '$dept', total: { $sum: '$val' } } },
            { $sort: { _id: 1 } }
        ]);
    });
});
