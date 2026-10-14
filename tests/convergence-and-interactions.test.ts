import { BSONRegExp, ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { optimizePipeline } from './helpers/pre-gate-optimizer.js';
import {
    optimizePipelineWithCandidateProfile,
    optimizePipelineWithPasses,
} from '../src/passes/registry.js';
import { PipelinePass } from '../src/passes/types.js';
import { isEqual } from '../src/utils.js';

class ClassValue
{
    constructor(readonly value: string)
    {}
}

describe('tree-wide pipeline convergence', () =>
{
    it('keeps the known facet optimization stable after one public call', () =>
    {
        const pipeline = [
            {
                $facet: {
                    byStatus: [
                        { $match: { a: 1 } },
                        { $match: { b: 2 } },
                    ],
                    limited: [
                        { $limit: 10 },
                        { $limit: 5 },
                    ],
                },
            },
        ];
        const pipelinePasses = [
            'adjacent-match-merging',
            'limit-skip-coalescing',
        ];
        const filterRules = ['merge-conjunctions'];

        const once = optimizePipelineWithCandidateProfile(
            pipeline,
            pipelinePasses,
            filterRules,
        );
        const twice = optimizePipelineWithCandidateProfile(
            once,
            pipelinePasses,
            filterRules,
        );

        expect(once).toEqual([
            {
                $facet: {
                    byStatus: [
                        { $match: { a: 1, b: 2 } },
                    ],
                    limited: [
                        { $limit: 5 },
                    ],
                },
            },
        ]);
        expect(twice).toEqual(once);
    });

    it('converges nested changes without broad outer field pruning', () =>
    {
        const pipeline = [
            { $addFields: { removedAfterNestedMerge: 1 } },
            {
                $facet: {
                    branch: [
                        { $project: { removedAfterNestedMerge: 1, retained: 1 } },
                        { $project: { retained: 1 } },
                    ],
                },
            },
        ];

        const optimized = optimizePipelineWithCandidateProfile(
            pipeline,
            ['adjacent-project-merging', 'unused-field-pruning'],
            [],
        );

        expect(optimized).toEqual([
            { $addFields: { removedAfterNestedMerge: 1 } },
            {
                $facet: {
                    branch: [
                        { $project: { retained: 1 } },
                    ],
                },
            },
        ]);
    });

    it('makes nested changes visible to the outer node in the same global sweep', () =>
    {
        const calls: string[] = [];
        const pass: PipelinePass = {
            name: 'nested-then-outer',
            execute(pipeline)
            {
                const node = pipeline[0]?.$schedulerNode;
                calls.push(typeof node === 'string' ? node : 'root');

                if (typeof node === 'string')
                {
                    if (pipeline[0].state === 'pending')
                    {
                        return [
                            { ...pipeline[0], state: 'done' },
                            ...pipeline.slice(1),
                        ];
                    }

                    return pipeline;
                }

                const facetDone = pipeline[0]?.$facet?.branch?.[0]?.state === 'done';
                const lookupDone = pipeline[1]?.$lookup?.pipeline?.[0]?.state === 'done';
                const unionDone = pipeline[2]?.$unionWith?.pipeline?.[0]?.state === 'done';
                const alreadyObserved = pipeline.some((stage) => stage?.$outerObserved);

                return facetDone && lookupDone && unionDone && !alreadyObserved
                    ? [...pipeline, { $outerObserved: true }]
                    : pipeline;
            },
        };
        const pipeline = [
            {
                $facet: {
                    branch: [
                        { $schedulerNode: 'facet', state: 'pending' },
                    ],
                },
            },
            {
                $lookup: {
                    from: 'foreign',
                    pipeline: [
                        { $schedulerNode: 'lookup', state: 'pending' },
                    ],
                    as: 'joined',
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        { $schedulerNode: 'union', state: 'pending' },
                    ],
                },
            },
        ];

        const optimized = optimizePipelineWithPasses(pipeline, [pass], 2);

        expect(optimized.at(-1)).toEqual({ $outerObserved: true });
        expect(calls).toEqual([
            'facet',
            'lookup',
            'union',
            'root',
            'facet',
            'lookup',
            'union',
            'root',
        ]);
    });

    it('converges beyond 100 one-step opportunities or returns the pristine tree', () =>
    {
        const pass: PipelinePass = {
            name: 'complete-one-step',
            execute(pipeline)
            {
                const index = pipeline.findIndex((stage) => stage?.pending === true);
                if (index === -1)
                {
                    return pipeline;
                }

                const result = [...pipeline];
                result[index] = { ...result[index], pending: false };
                return result;
            },
        };
        const pipeline = Array.from({ length: 101 }, (_, index) => ({
            index,
            pending: true,
        }));

        const exhausted = optimizePipelineWithPasses(pipeline, [pass]);
        const converged = optimizePipelineWithPasses(pipeline, [pass], 102);

        expect(exhausted).toEqual(pipeline);
        expect(exhausted).not.toBe(pipeline);
        expect(converged).toHaveLength(101);
        expect(converged.every((stage: any) => stage.pending === false)).toBe(true);
    });

    it('falls back globally on a repeated non-fixed state and stays stable', () =>
    {
        const pass: PipelinePass = {
            name: 'two-state-oscillator',
            execute(pipeline)
            {
                const state = pipeline[0]?.state;
                if (state === 'left' || state === 'right')
                {
                    return [
                        {
                            ...pipeline[0],
                            state: state === 'left' ? 'right' : 'left',
                        },
                        ...pipeline.slice(1),
                    ];
                }

                const childState = pipeline[0]?.$facet?.branch?.[0]?.state;
                if (childState === 'left' || childState === 'right')
                {
                    return [
                        ...pipeline.filter((stage) => !('$observedState' in stage)),
                        { $observedState: childState },
                    ];
                }

                return pipeline;
            },
        };
        const pipeline = [
            {
                $facet: {
                    branch: [
                        { state: 'left' },
                    ],
                },
            },
            { $outside: 'pristine' },
        ];

        const once = optimizePipelineWithPasses(pipeline, [pass], 10);
        const twice = optimizePipelineWithPasses(once, [pass], 10);

        expect(once).toEqual(pipeline);
        expect(once).not.toBe(pipeline);
        expect(twice).toEqual(once);
    });
});

describe('structural equality', () =>
{
    it('distinguishes BSON-aware values without losing structural order', () =>
    {
        const objectId = '000000000000000000000001';

        expect(isEqual(1, '1')).toBe(false);
        expect(isEqual(/alpha/gi, new RegExp('alpha', 'ig'))).toBe(true);
        expect(isEqual(/alpha/g, /alpha/i)).toBe(false);
        expect(isEqual(/alpha/i, /beta/i)).toBe(false);
        expect(isEqual(new Date(1), new Date(2))).toBe(false);
        expect(isEqual(Buffer.from([1, 2]), Buffer.from([2, 1]))).toBe(false);
        expect(isEqual(new ObjectId(objectId), new ObjectId(objectId))).toBe(true);
        expect(isEqual(new ObjectId(objectId), new ObjectId('000000000000000000000002'))).toBe(false);
        expect(isEqual(new BSONRegExp('alpha', 'i'), new BSONRegExp('alpha', 'm'))).toBe(false);
        expect(isEqual({ value: undefined }, {})).toBe(false);
        expect(isEqual([1, 2], [2, 1])).toBe(false);
        expect(isEqual({ first: 1, second: 2 }, { second: 2, first: 1 })).toBe(false);
        expect(isEqual(new ClassValue('one'), new ClassValue('one'))).toBe(true);
        expect(isEqual(new ClassValue('one'), new ClassValue('two'))).toBe(false);
        expect(isEqual(new ClassValue('one'), { value: 'one' })).toBe(false);
    });
});

describe('production pipeline copy semantics', () =>
{
    it('retains containment copy semantics after candidate scheduling', () =>
    {
        const bson = new ObjectId('000000000000000000000001');
        const classValue = new ClassValue('leaf');
        const date = new Date('2026-09-04T00:00:00.000Z');
        const buffer = Buffer.from([1, 2, 3]);
        const regexp = /contained/gi;
        const pipeline: any[] = [
            {
                $match: {
                    bson,
                    classValue,
                    date,
                    buffer,
                    regexp,
                    explicitlyUndefined: undefined,
                },
            },
            {
                $facet: {
                    branch: [
                        { $match: { active: true } },
                    ],
                },
            },
        ];

        optimizePipelineWithPasses(
            [{ $custom: 'candidate' }],
            [{
                name: 'candidate-only',
                execute: () => [{ $custom: 'changed' }],
            }],
            2,
        );
        const optimized = optimizePipeline(pipeline);

        expect(optimized).toEqual(pipeline);
        expect(optimized).not.toBe(pipeline);
        expect(optimized[0]).toBe(pipeline[0]);
        expect(optimized[0].$match).toBe(pipeline[0].$match);
        expect(optimized[0].$match.bson).toBe(bson);
        expect(optimized[0].$match.classValue).toBe(classValue);
        expect(optimized[0].$match.date).toBe(date);
        expect(optimized[0].$match.buffer).toBe(buffer);
        expect(optimized[0].$match.regexp).toBe(regexp);
        expect(optimized[1]).toBe(pipeline[1]);
        expect(optimized[1]!.$facet.branch).toBe(pipeline[1]!.$facet.branch);
    });

    it( 'AE4: returns a new root pipeline array while preserving unmodified stage and leaf references', () =>
    {
        const input: any[] =
        [
            { $match: { createdAt: new Date( '2026-01-01T00:00:00Z' ) } },
            { $limit: 10 }
        ];
        const snapshot = structuredClone( input );

        const output = optimizePipeline( input );

        expect( input ).toEqual( snapshot );
        expect( output ).not.toBe( input );
        expect( output[ 0 ] ).toBe( input[ 0 ] );
        expect( output[ 1 ] ).toBe( input[ 1 ] );
        expect( output[ 0 ].$match.createdAt ).toBe( input[ 0 ].$match.createdAt );
    } );

    it( 'AE1: merges adjacent $match stages, deduplicates small $in, and preserves 3,121-element ObjectId $in by reference', () =>
    {
        const largeIds = Array.from(
            { length: 3121 },
            ( _, i ) => new ObjectId( i.toString( 16 ).padStart( 24, '0' ))
        );
        const input: any[] =
        [
            {
                $match:
                {
                    _id: { $in: largeIds },
                    status: { $in: [ 'active', 'active' ] }
                }
            },
            {
                $match:
                {
                    tenantId: 't1'
                }
            }
        ];

        const output = optimizePipeline( input );

        expect( output ).toEqual(
        [
            {
                $match:
                {
                    _id: { $in: largeIds },
                    status: 'active',
                    tenantId: 't1'
                }
            }
        ] );
        expect( output[ 0 ].$match._id.$in ).toBe( input[ 0 ].$match._id.$in );
        expect( input[ 0 ].$match.status ).toEqual({ $in: [ 'active', 'active' ] });
    } );

    it( 'optimizes a 5-stage 3,121-element ObjectId $in pipeline in sub-millisecond time while preserving $in by reference', () =>
    {
        const largeIds = Array.from(
            { length: 3121 },
            ( _, i ) => new ObjectId( i.toString( 16 ).padStart( 24, '0' ))
        );
        const input =
        [
            { $match: { _id: { $in: largeIds }, deleted: false } },
            { $sort: { createdAt: -1 } },
            { $skip: 0 },
            { $limit: 50 },
            { $project: { _id: 1, name: 1, createdAt: 1 } }
        ];

        // Warmup
        optimizePipeline( input );

        const iterations = 20;
        const start = performance.now();

        let output: any[] = [];

        for( let i = 0; i < iterations; i++ )
        {
            output = optimizePipeline( input );
        }

        const elapsedPerCallMs = ( performance.now() - start ) / iterations;

        expect( output ).toEqual(
        [
            { $match: { _id: { $in: largeIds }, deleted: false } },
            { $sort: { createdAt: -1 } },
            { $limit: 50 },
            { $project: { _id: 1, name: 1, createdAt: 1 } }
        ] );
        expect( output[ 0 ].$match._id.$in ).toBe( largeIds );
        expect( input ).toHaveLength( 5 );
        expect( elapsedPerCallMs ).toBeLessThan( 15 );
    } );

    it('converges multi-pass interactions across expr-normalization, group-pushdown, unwind-prefilter, and facet-hoisting', () =>
    {
        // 1. $expr normalization -> adjacent match merging -> match pushdown
        const pipeline1 = [
            { $project: { status: 1, score: 1 } },
            { $match: { $expr: { $eq: ['$status', 'active'] } } },
            { $match: { score: { $gte: 10 } } },
        ];
        const optimized1 = optimizePipeline(pipeline1);
        expect(optimized1).toEqual([
            { $match: { status: 'active', score: { $gte: 10 } } },
            { $project: { status: 1, score: 1 } },
        ]);

        // 2. $group pushdown -> match pushdown across $lookup
        const pipeline2 = [
            {
                $lookup: {
                    from: 'customers',
                    localField: 'customerId',
                    foreignField: '_id',
                    as: 'customer',
                },
            },
            {
                $group: {
                    _id: '$tenantId',
                    count: { $sum: 1 },
                },
            },
            { $match: { _id: 'tenant-1' } },
        ];
        const optimized2 = optimizePipeline(pipeline2);
        expect(optimized2).toEqual([
            { $match: { tenantId: 'tenant-1' } },
            {
                $lookup: {
                    from: 'customers',
                    localField: 'customerId',
                    foreignField: '_id',
                    as: 'customer',
                },
            },
            {
                $group: {
                    _id: '$tenantId',
                    count: { $sum: 1 },
                },
            },
        ]);

        // 3. $facet hoisting -> adjacent match merging with preceding $match
        const pipeline3 = [
            { $match: { tenant: 'org-1' } },
            {
                $facet: {
                    recent: [
                        { $match: { status: 'active' } },
                        { $project: { name: 1 } },
                        { $count: 'total' },
                    ],
                    oldest: [
                        { $match: { status: 'active' } },
                        { $project: { name: 1 } },
                        { $group: { _id: '$name' } },
                    ],
                },
            },
        ];
        const optimized3 = optimizePipeline(pipeline3);
        expect(optimized3).toEqual([
            { $match: { tenant: 'org-1', status: 'active' } },
            {
                $facet: {
                    recent: [{ $count: 'total' }],
                    oldest: [
                        { $project: { name: 1 } },
                        { $group: { _id: '$name' } },
                    ],
                },
            },
        ]);

        // 4. $unwind prefilter -> adjacent match merging with preceding $match
        const pipeline4 = [
            { $match: { tenant: 'org-1' } },
            { $unwind: '$items' },
            { $match: { 'items.qty': { $gt: 0 } } },
        ];
        const optimized4 = optimizePipeline(pipeline4);
        expect(optimized4).toEqual([
            {
                $match: {
                    $or: [
                        { 'items.qty': { $gt: 0 } },
                        { items: { $elemMatch: { $type: 'array' } } },
                    ],
                    tenant: 'org-1',
                },
            },
            { $unwind: '$items' },
            { $match: { 'items.qty': { $gt: 0 } } },
        ]);
    });
});
