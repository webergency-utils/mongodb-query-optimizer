import { BSONRegExp, ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { optimizePipeline } from './helpers/pre-gate-optimizer.js';
import {
    optimizePipelineWithCandidateProfile,
    optimizePipelineWithPasses,
} from '../src/passes/registry.js';
import { PipelinePass } from '../src/passes/types.js';
import { structuralFingerprint } from '../src/utils.js';

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

describe('structural fingerprints', () =>
{
    it('distinguishes BSON-aware values without losing structural order', () =>
    {
        const objectId = '000000000000000000000001';

        expect(structuralFingerprint(1)).not.toBe(structuralFingerprint('1'));
        expect(structuralFingerprint(/alpha/gi)).toBe(
            structuralFingerprint(new RegExp('alpha', 'ig')),
        );
        expect(structuralFingerprint(/alpha/g)).not.toBe(
            structuralFingerprint(/alpha/i),
        );
        expect(structuralFingerprint(/alpha/i)).not.toBe(
            structuralFingerprint(/beta/i),
        );
        expect(structuralFingerprint(new Date(1))).not.toBe(
            structuralFingerprint(new Date(2)),
        );
        expect(structuralFingerprint(Buffer.from([1, 2]))).not.toBe(
            structuralFingerprint(Buffer.from([2, 1])),
        );
        expect(structuralFingerprint(new ObjectId(objectId))).toBe(
            structuralFingerprint(new ObjectId(objectId)),
        );
        expect(structuralFingerprint(new ObjectId(objectId))).not.toBe(
            structuralFingerprint(new ObjectId('000000000000000000000002')),
        );
        expect(structuralFingerprint(new BSONRegExp('alpha', 'i'))).not.toBe(
            structuralFingerprint(new BSONRegExp('alpha', 'm')),
        );
        expect(structuralFingerprint({ value: undefined })).not.toBe(
            structuralFingerprint({}),
        );
        expect(structuralFingerprint([1, 2])).not.toBe(
            structuralFingerprint([2, 1]),
        );
        expect(structuralFingerprint({ first: 1, second: 2 })).not.toBe(
            structuralFingerprint({ second: 2, first: 1 }),
        );
        expect(structuralFingerprint(new ClassValue('one'))).toBe(
            structuralFingerprint(new ClassValue('one')),
        );
        expect(structuralFingerprint(new ClassValue('one'))).not.toBe(
            structuralFingerprint(new ClassValue('two')),
        );
        expect(structuralFingerprint(new ClassValue('one'))).not.toBe(
            structuralFingerprint({ value: 'one' }),
        );
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
        expect(optimized[0]).not.toBe(pipeline[0]);
        expect(optimized[0].$match).not.toBe(pipeline[0].$match);
        expect(optimized[0].$match.bson).toBe(bson);
        expect(optimized[0].$match.classValue).toBe(classValue);
        expect(optimized[0].$match.date).not.toBe(date);
        expect(optimized[0].$match.buffer).not.toBe(buffer);
        expect(optimized[0].$match.regexp).not.toBe(regexp);
        expect(optimized[1]!.$facet.branch).not.toBe(pipeline[1]!.$facet.branch);
    });

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
            { $project: { name: 1 } },
            {
                $facet: {
                    recent: [{ $count: 'total' }],
                    oldest: [{ $group: { _id: '$name' } }],
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
                    $and: [
                        {
                            $or: [
                                { 'items.qty': { $gt: 0 } },
                                { items: { $elemMatch: { $type: 'array' } } },
                            ],
                        },
                    ],
                    tenant: 'org-1',
                },
            },
            { $unwind: '$items' },
            { $match: { 'items.qty': { $gt: 0 } } },
        ]);
    });
});
