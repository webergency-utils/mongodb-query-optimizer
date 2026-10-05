import { describe, expect, it } from 'vitest';
import { optimizePipeline } from '../src/index.js';
import { proveGroupFilterPushdown } from '../src/passes/group-pushdown-proofs.js';
import { proveMatchPushdownAcrossStage } from '../src/passes/movement-proofs.js';
import { runMockPipeline } from './helpers/mock-engine.js';

describe( 'Bug Regression Suite', () =>
{
    describe( 'Bug 3: Computed expression $group prefilter discards null groups', () =>
    {
        it( 'rejects pushdown when post-match targets null _id to preserve null groups', () =>
        {
            const group = {
                $group: {
                    _id: { $toUpper: '$dept' },
                    count: { $sum: 1 }
                }
            };
            const match = {
                $match: {
                    _id: null
                }
            };

            const proof = proveGroupFilterPushdown( group, match );
            expect( proof ).toBeNull();

            const pipeline = [ group, match ];
            const optimized = optimizePipeline( pipeline );
            expect( optimized ).toEqual( pipeline );
        });

        it( 'rejects pushdown when post-match targets empty string _id', () =>
        {
            const group = {
                $group: {
                    _id: { $toUpper: '$dept' },
                    count: { $sum: 1 }
                }
            };
            const match = {
                $match: {
                    _id: ''
                }
            };

            const proof = proveGroupFilterPushdown( group, match );
            expect( proof ).toBeNull();
        });

        it( 'rejects pushdown when post-match only targets accumulator fields', () =>
        {
            const group = {
                $group: {
                    _id: { $toUpper: '$dept' },
                    count: { $sum: 1 }
                }
            };
            const match = {
                $match: {
                    count: { $gt: 1 }
                }
            };

            const proof = proveGroupFilterPushdown( group, match );
            expect( proof ).toBeNull();
        });

        it( 'rejects pushdown when post-match $ne is not null', () =>
        {
            const group = {
                $group: {
                    _id: { $toUpper: '$dept' },
                    count: { $sum: 1 }
                }
            };
            const match = {
                $match: {
                    _id: { $ne: 'SALES' }
                }
            };

            const proof = proveGroupFilterPushdown( group, match );
            expect( proof ).toBeNull();
        });

        it( 'rejects pushdown when post-match uses non-$ne object operator', () =>
        {
            const group = {
                $group: {
                    _id: { $toUpper: '$dept' },
                    count: { $sum: 1 }
                }
            };
            const match = {
                $match: {
                    _id: { $exists: true }
                }
            };

            const proof = proveGroupFilterPushdown( group, match );
            expect( proof ).toBeNull();
        });

        it( 'allows pushdown when post-match explicitly requires $ne: null', () =>
        {
            const group = {
                $group: {
                    _id: { $toUpper: '$dept' },
                    count: { $sum: 1 }
                }
            };
            const match = {
                $match: {
                    _id: { $ne: null }
                }
            };

            const proof = proveGroupFilterPushdown( group, match );
            expect( proof ).not.toBeNull();
            expect( proof?.prefilterStage ).toEqual({
                $match: {
                    dept: { $exists: true, $ne: null }
                }
            });
        });

        it( 'allows pushdown when post-match targets numeric or boolean _id', () =>
        {
            const groupNum = {
                $group: {
                    _id: { $abs: '$val' },
                    count: { $sum: 1 }
                }
            };
            expect( proveGroupFilterPushdown( groupNum, { $match: { _id: 10 } } )).not.toBeNull();
            expect( proveGroupFilterPushdown( groupNum, { $match: { _id: true } } )).not.toBeNull();
        });

        it( 'preserves null group output without data loss in pipeline execution', () =>
        {
            const data = [
                { _id: 1, dept: null, count: 1 },
                { _id: 2, count: 1 }
            ];

            const pipeline = [
                { $group: { _id: '$dept', total: { $sum: '$count' } } },
                { $match: { _id: null } }
            ];

            const optimized = optimizePipeline( pipeline );
            const originalResult = runMockPipeline( data, pipeline );
            const optimizedResult = runMockPipeline( data, optimized );

            expect( originalResult ).toEqual( [ { _id: null, total: 2 } ] );
            expect( optimizedResult ).toEqual( originalResult );
        });
    });

    describe( 'Bug 5: $addFields / $set alias pushdown with $exists filter', () =>
    {
        it( 'rejects match pushdown across $addFields when condition checks $exists', () =>
        {
            const addFields = {
                $addFields: {
                    status: '$info.state'
                }
            };
            const match = {
                $match: {
                    status: { $exists: true }
                }
            };

            const proof = proveMatchPushdownAcrossStage( addFields, match );
            expect( proof ).toBeNull();

            const pipeline = [ addFields, match ];
            const optimized = optimizePipeline( pipeline );
            expect( optimized ).toEqual( pipeline );
        });

        it( 'rejects match pushdown across $set when nested subpath checks $exists', () =>
        {
            const setStage = {
                $set: {
                    alias: '$source'
                }
            };
            const match = {
                $match: {
                    'alias.sub': { $exists: true }
                }
            };

            const proof = proveMatchPushdownAcrossStage( setStage, match );
            expect( proof ).toBeNull();
        });

        it( 'rejects match pushdown across $addFields when $and contains $exists on alias', () =>
        {
            const addFields = {
                $addFields: {
                    status: '$info.state'
                }
            };
            const match = {
                $match: {
                    $and: [
                        { status: { $exists: true } }
                    ]
                }
            };

            const proof = proveMatchPushdownAcrossStage( addFields, match );
            expect( proof ).toBeNull();
        });

        it( 'rejects match pushdown across $addFields when $or contains $exists on alias', () =>
        {
            const addFields = {
                $addFields: {
                    status: '$info.state'
                }
            };
            const match = {
                $match: {
                    $or: [
                        { status: { $exists: true } }
                    ]
                }
            };

            const proof = proveMatchPushdownAcrossStage( addFields, match );
            expect( proof ).toBeNull();
        });

        it( 'allows pushdown across $addFields when match condition does not use $exists', () =>
        {
            const addFields = {
                $addFields: {
                    status: '$info.state'
                }
            };
            const match = {
                $match: {
                    status: 'active'
                }
            };

            const proof = proveMatchPushdownAcrossStage( addFields, match );
            expect( proof ).not.toBeNull();
            expect( proof?.matchStage ).toEqual({
                $match: {
                    'info.state': 'active'
                }
            });
        });
    });

    describe( 'Bug 4 & Bug 2: Pipeline execution semantics preservation', () =>
    {
        it( 'preserves documents when $unwind processes single object operands', () =>
        {
            const data = [
                { _id: 1, items: { color: 'red' } }
            ];

            const pipeline = [
                { $unwind: '$items' },
                { $match: { 'items.color': 'red' } }
            ];

            const originalResult = runMockPipeline( data, pipeline );
            expect( originalResult ).toEqual( [ { _id: 1, items: { color: 'red' } } ] );
        });

        it( 'preserves multikey array group semantics under 1-to-1 group pushdown', () =>
        {
            const data = [
                { _id: 1, dept: 'Sales', amount: 10 },
                { _id: 2, dept: [ 'Sales', 'HR' ], amount: 50 }
            ];

            const pipeline = [
                { $group: { _id: '$dept', total: { $sum: '$amount' } } },
                { $match: { _id: 'Sales' } }
            ];

            const optimized = optimizePipeline( pipeline );
            const originalResult = runMockPipeline( data, pipeline );
            const optimizedResult = runMockPipeline( data, optimized );

            expect( optimizedResult ).toEqual( originalResult );
        });
    });
});
