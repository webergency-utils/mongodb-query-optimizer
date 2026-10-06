import { describe, expect, it } from 'vitest';
import { getStageInfo } from '../src/index.js';
import {
    optimizeFilter,
    optimizePipeline,
} from './helpers/pre-gate-optimizer.js';
import { optimizeFilterWithCandidateProfile } from '../src/filter-optimizer.js';
import { optimizePipelineWithCandidateProfile } from '../src/passes/registry.js';

class FakeBsonValue
{
    readonly _bsontype = 'ObjectId';

    constructor(readonly value: string)
    {}
}

describe('production registries', () =>
{
    it('enables proven filter rewrites while preserving field conflicts', () =>
    {
        const cases = [
            {
                input: { score: { $eq: 10 } },
                expected: { score: 10 },
            },
            {
                input: { status: { $in: ['active'] } },
                expected: { status: 'active' },
            },
            {
                input: {
                    $and: [
                        { score: { $gt: 5 } },
                        { score: { $lt: 10 } },
                    ],
                },
                expected: {
                    score: { $gt: 5 },
                    $and: [
                        { score: { $lt: 10 } },
                    ],
                },
            },
            {
                input: {
                    $or: [
                        { status: 'active' },
                        { $or: [{ tier: 'gold' }, { tier: 'silver' }] },
                    ],
                },
                expected: {
                    $or: [
                        { status: 'active' },
                        { tier: 'gold' },
                        { tier: 'silver' },
                    ],
                },
            },
        ];

        for (const testCase of cases)
        {
            const optimized = optimizeFilter(testCase.input);

            expect(optimized).toEqual(testCase.expected);
            expect(optimized).not.toBe(testCase.input);
        }
    });

    it('enables proven filter and limit-skip pipeline transformations', () =>
    {
        const pipeline = [
            { $match: { score: { $gt: 5 } } },
            { $match: { status: 'active' } },
            {
                $lookup: {
                    from: 'orders',
                    localField: '_id',
                    foreignField: 'customerId',
                    pipeline: [
                        { $match: { paid: true } },
                        { $match: { archived: false } },
                    ],
                    as: 'orders',
                },
            },
            {
                $facet: {
                    recent: [
                        { $limit: 10 },
                        { $limit: 5 },
                    ],
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        { $skip: 2 },
                        { $skip: 3 },
                    ],
                },
            },
        ];

        const optimized = optimizePipeline(pipeline);

        expect(optimized).toEqual([
            {
                $match: {
                    score: { $gt: 5 },
                    status: 'active',
                },
            },
            {
                $lookup: {
                    from: 'orders',
                    localField: '_id',
                    foreignField: 'customerId',
                    pipeline: [
                        { $match: { paid: true, archived: false } },
                    ],
                    as: 'orders',
                },
            },
            {
                $facet: {
                    recent: [
                        { $limit: 5 },
                    ],
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        { $skip: 5 },
                    ],
                },
            },
        ]);
        expect(optimized).not.toBe(pipeline);
    });

    it('preserves established root and leaf reference behavior', () =>
    {
        const date = new Date('2026-09-04T00:00:00.000Z');
        const buffer = Buffer.from([1, 2, 3]);
        const regexp = /active/gi;
        const bson = new FakeBsonValue('abc123');
        const functionBody = (value: number) => value + 1;
        const expression = {
            $function: {
                body: functionBody,
                args: ['$score'],
                lang: 'js',
            },
        };
        const filter = {
            createdAt: date,
            payload: buffer,
            status: regexp,
            _id: bson,
            $expr: expression,
        };

        const optimizedFilter = optimizeFilter(filter);

        expect(optimizedFilter).not.toBe(filter);
        expect(optimizedFilter.createdAt).toBe(date);
        expect(optimizedFilter.payload).toBe(buffer);
        expect(optimizedFilter.status).toBe(regexp);
        expect(optimizedFilter._id).toBe(bson);
        expect(optimizedFilter.$expr).toBe(expression);

        const pipeline = [{ $match: filter }, { $unknown: { token: bson } }];
        const optimizedPipeline = optimizePipeline(pipeline);

        expect(optimizedPipeline).not.toBe(pipeline);
        expect(optimizedPipeline[0]).not.toBe(pipeline[0]);
        expect(optimizedPipeline[0].$match).not.toBe(filter);
        expect(optimizedPipeline[0].$match.createdAt).not.toBe(date);
        expect(optimizedPipeline[0].$match.createdAt).toEqual(date);
        expect(optimizedPipeline[0].$match.payload).not.toBe(buffer);
        expect(optimizedPipeline[0].$match.payload).toEqual(buffer);
        expect(optimizedPipeline[0].$match.status).not.toBe(regexp);
        expect(optimizedPipeline[0].$match.status).toEqual(regexp);
        expect(optimizedPipeline[0].$match._id).toBe(bson);
        expect(optimizedPipeline[0].$match.$expr.$function.body).toBe(functionBody);
        expect(optimizedPipeline[1].$unknown.token).toBe(bson);
    });

    it('does not mutate caller-owned nested pipeline arrays', () =>
    {
        const filter = {
            $and: [
                { a: { $eq: 1 } },
                { b: { $in: [2] } },
            ],
        };
        const facetPipeline = [
            { $match: { a: 1 } },
            { $match: { b: 2 } },
        ];
        const lookupPipeline = [
            { $limit: 10 },
            { $limit: 5 },
        ];
        const unionPipeline = [
            { $skip: 2 },
            { $skip: 3 },
        ];
        const pipeline: any[] = [
            { $facet: { branch: facetPipeline } },
            {
                $lookup: {
                    from: 'orders',
                    pipeline: lookupPipeline,
                    as: 'orders',
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: unionPipeline,
                },
            },
        ];
        const filterSnapshot = structuredClone(filter);
        const snapshot = structuredClone(pipeline);

        optimizeFilter(filter);
        optimizePipeline(pipeline);

        expect(filter).toEqual(filterSnapshot);
        expect(pipeline).toEqual(snapshot);
        expect(pipeline[0]!.$facet.branch).toBe(facetPipeline);
        expect(pipeline[1]!.$lookup.pipeline).toBe(lookupPipeline);
        expect(pipeline[2]!.$unionWith.pipeline).toBe(unionPipeline);
    });

    it('rejects unregistered atomic transformation IDs before execution', () =>
    {
        const filter = { score: { $eq: 10 } };
        const pipeline = [
            { $project: { score: 1 } },
            { $limit: 1 },
        ];
        const pipelineSnapshot = structuredClone(pipeline);

        expect(() =>
            optimizeFilterWithCandidateProfile(filter, ['unregistered-filter-rule']),
        ).toThrow('Filter rule is not registered');
        expect(() =>
            optimizePipelineWithCandidateProfile(pipeline, ['unregistered-pipeline-rule']),
        ).toThrow('Pipeline transformation is not registered');
        expect(filter).toEqual({ score: { $eq: 10 } });
        expect(pipeline).toEqual(pipelineSnapshot);
    });

    it('selects candidate direct-filter rules independently', () =>
    {
        const filter = {
            score: { $eq: 10 },
            status: { $in: ['active'] },
        };

        expect(
            optimizeFilterWithCandidateProfile(filter, ['simplify-equality']),
        ).toEqual({
            score: 10,
            status: { $in: ['active'] },
        });
        expect(
            optimizeFilterWithCandidateProfile(filter, ['simplify-singleton-in']),
        ).toEqual({
            score: { $eq: 10 },
            status: 'active',
        });
        expect(optimizeFilterWithCandidateProfile(filter, [])).toEqual(filter);
    });

    it('selects limit advancement while containing lookup delay', () =>
    {
        const limitPipeline = [
            { $project: { score: 1 } },
            { $limit: 1 },
        ];

        expect(
            optimizePipelineWithCandidateProfile(limitPipeline, ['limit-advance']),
        ).toEqual([
            { $limit: 1 },
            { $project: { score: 1 } },
        ]);
        expect(
            optimizePipelineWithCandidateProfile(limitPipeline, ['lookup-delay']),
        ).toEqual(limitPipeline);

        const lookup = {
            $lookup: {
                from: 'orders',
                localField: '_id',
                foreignField: 'customerId',
                as: 'orders',
            },
        };
        const lookupPipeline = [
            lookup,
            { $sort: { score: -1 } },
        ];

        expect(
            optimizePipelineWithCandidateProfile(lookupPipeline, ['lookup-delay']),
        ).toEqual([
            { $sort: { score: -1 } },
            lookup,
        ]);
        expect(
            optimizePipelineWithCandidateProfile(lookupPipeline, ['limit-advance']),
        ).toEqual(lookupPipeline);
    });

    it('keeps the observable getStageInfo shape stable', () =>
    {
        const expectedKeys = [
            'altersCount',
            'index',
            'isDestructive',
            'isUnknown',
            'modifiedFields',
            'operator',
            'producedFields',
            'removedFields',
            'stage',
            'usedFields',
        ];
        const cases = [
            { stage: { $match: { active: true } }, operator: '$match' },
            { stage: { $match: {}, $limit: 1 }, operator: 'unknown' },
            { stage: { $unknown: { dynamic: '$value' } }, operator: '$unknown' },
        ];

        for (const [index, testCase] of cases.entries())
        {
            const info = getStageInfo(testCase.stage, index);

            expect(Object.keys(info).sort()).toEqual(expectedKeys);
            expect(info.index).toBe(index);
            expect(info.stage).toBe(testCase.stage);
            expect(info.operator).toBe(testCase.operator);
            expect(info.usedFields).toBeInstanceOf(Set);
            expect(info.producedFields).toBeInstanceOf(Set);
            expect(info.modifiedFields).toBeInstanceOf(Set);
            expect(info.removedFields).toBeInstanceOf(Set);
            expect(typeof info.isDestructive).toBe('boolean');
            expect(typeof info.altersCount).toBe('boolean');
            expect(typeof info.isUnknown).toBe('boolean');
        }
    });
});
