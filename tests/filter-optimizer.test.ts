import {
    BSONRegExp,
    Long,
    ObjectId,
} from 'mongodb';
import { describe, expect, it } from 'vitest';
import {
    optimizeFilterWithCandidateProfile,
    optimizeFilterWithRulesForTesting,
} from '../src/filter-optimizer.js';
import type { FilterRule } from '../src/filter-rule-registry.js';
import {
    optimizeFilter,
    optimizePipeline,
} from '../src/index.js';
import { optimizePipelineWithCandidateProfile } from '../src/passes/registry.js';

describe('production filter optimizer', () =>
{
    it('treats an empty disjunction branch as match-all without dropping siblings', () =>
    {
        expect(optimizeFilter({
            $or: [{}, { a: 1 }],
        })).toEqual({});

        expect(optimizeFilter({
            tenant: 'acme',
            $or: [{}, { a: 1 }],
        })).toEqual({
            tenant: 'acme',
        });
    });

    it('removes valid conjunction identities but preserves invalid empty arrays', () =>
    {
        expect(optimizeFilter({
            $and: [{}, { a: 1 }],
        })).toEqual({
            a: 1,
        });

        expect(optimizeFilter({ $and: [] })).toEqual({ $and: [] });
        expect(optimizeFilter({ $or: [] })).toEqual({ $or: [] });
        expect(optimizeFilter({
            $and: [
                { a: 1 },
                { $and: [] },
            ],
        })).toEqual({
            $and: [
                { a: 1 },
                { $and: [] },
            ],
        });

        const invalidWithOtherwiseOptimizableChild = {
            $and: [
                { a: { $eq: 1 } },
                { $or: [] },
            ],
        };
        expect(
            optimizeFilter(invalidWithOtherwiseOptimizableChild),
        ).toEqual(invalidWithOtherwiseOptimizableChild);

        const invalidFieldOperator = {
            $or: [
                {},
                { a: { $in: 1 } },
            ],
        };
        expect(optimizeFilter(invalidFieldOperator)).toEqual(invalidFieldOperator);

        const invalidSibling = {
            $and: [
                { a: { $eq: 1 } },
                { b: { $in: 1 } },
            ],
        };
        expect(optimizeFilter(invalidSibling)).toEqual(invalidSibling);
    });

    it('composes the enabled rules for direct public calls', () =>
    {
        expect(optimizeFilter({
            $and: [
                { score: { $eq: 10 } },
                { status: { $in: ['active'] } },
                { tenant: 'acme' },
                { tenant: 'acme' },
            ],
        })).toEqual({
            score: 10,
            status: 'active',
            tenant: 'acme',
        });
    });

    it('keeps repeated multikey predicates and explicit exotic equality forms', () =>
    {
        const objectId = new ObjectId('000000000000000000000001');
        const regex = /active/i;
        const input = {
            $and: [
                { tags: { $in: [1, 2] } },
                { tags: { $in: [2, 3] } },
                { pattern: { $eq: regex } },
                { _id: { $eq: objectId } },
                { payload: { $eq: { $gt: 1 } } },
            ],
        };

        expect(optimizeFilter(input)).toEqual({
            tags: { $in: [1, 2] },
            pattern: { $eq: regex },
            _id: { $eq: objectId },
            payload: { $eq: { $gt: 1 } },
            $and: [
                { tags: { $in: [2, 3] } },
            ],
        });
    });

    it('does not mutate input and preserves direct-call leaf references', () =>
    {
        const objectId = new ObjectId('000000000000000000000001');
        const regex = /active/i;
        const input = {
            $and: [
                { score: { $eq: 10 } },
                { pattern: { $eq: regex } },
                { _id: { $eq: objectId } },
            ],
        };
        const originalConditions = input.$and;

        const optimized = optimizeFilter(input);

        expect(input).toEqual({
            $and: [
                { score: { $eq: 10 } },
                { pattern: { $eq: regex } },
                { _id: { $eq: objectId } },
            ],
        });
        expect(input.$and).toBe(originalConditions);
        expect(optimized).not.toBe(input);
        expect(optimized.pattern.$eq).toBe(regex);
        expect(optimized._id.$eq).toBe(objectId);
    });

    it('keeps unsupported and dynamic filters unchanged', () =>
    {
        const unsupported = {
            $and: [
                { score: { $eq: 10 } },
                { $dynamicPredicate: { source: '$score' } },
            ],
        };
        const dynamic = {
            $and: [
                { score: { $eq: 10 } },
                { $expr: { $rand: {} } },
            ],
        };

        expect(optimizeFilter(unsupported)).toEqual(unsupported);
        expect(optimizeFilter(dynamic)).toEqual(dynamic);
    });
});

describe('direct filter fixed-point safety', () =>
{
    it('falls back to the pristine complete filter on a nested cycle', () =>
    {
        const oscillator: FilterRule = {
            id: 'simplify-equality',
            apply(filter)
            {
                if (filter.state === 'left' || filter.state === 'right')
                {
                    return {
                        ...filter,
                        state: filter.state === 'left' ? 'right' : 'left',
                    };
                }

                return filter;
            },
        };
        const filter = {
            $and: [
                { state: 'left' },
            ],
            tenant: 'acme',
        };
        const snapshot = structuredClone(filter);

        const once = optimizeFilterWithRulesForTesting(
            filter,
            [oscillator],
            10,
        );
        const twice = optimizeFilterWithRulesForTesting(
            once,
            [oscillator],
            10,
        );

        expect(filter).toEqual(snapshot);
        expect(once).toEqual(filter);
        expect(once).not.toBe(filter);
        expect(twice).toEqual(once);
    });

    it('returns pristine on budget exhaustion and converges when budget permits', () =>
    {
        const incrementUntilThree: FilterRule = {
            id: 'simplify-equality',
            apply(filter)
            {
                return (
                    typeof filter.step === 'number'
                    && filter.step < 3
                )
                    ? { ...filter, step: filter.step + 1 }
                    : filter;
            },
        };
        const filter = { step: 0 };

        const exhausted = optimizeFilterWithRulesForTesting(
            filter,
            [incrementUntilThree],
            2,
        );
        const converged = optimizeFilterWithRulesForTesting(
            filter,
            [incrementUntilThree],
            4,
        );

        expect(exhausted).toEqual(filter);
        expect(exhausted).not.toBe(filter);
        expect(
            optimizeFilterWithRulesForTesting(
                exhausted,
                [incrementUntilThree],
                2,
            ),
        ).toEqual(exhausted);
        expect(converged).toEqual({ step: 3 });
    });
});

describe('atomic filter candidates', () =>
{
    it('simplifies only finite primitive equality forms', () =>
    {
        const objectId = new ObjectId('000000000000000000000001');
        const filter = {
            score: { $eq: 10 },
            status: { $eq: 'active' },
            enabled: { $eq: true },
            regex: { $eq: /active/i },
            embeddedOperator: { $eq: { $gt: 1 } },
            objectId: { $eq: objectId },
            nullValue: { $eq: null },
            nonFinite: { $eq: Number.POSITIVE_INFINITY },
        };

        expect(
            optimizeFilterWithCandidateProfile(filter, ['simplify-equality']),
        ).toEqual({
            score: 10,
            status: 'active',
            enabled: true,
            regex: { $eq: /active/i },
            embeddedOperator: { $eq: { $gt: 1 } },
            objectId: { $eq: objectId },
            nullValue: { $eq: null },
            nonFinite: { $eq: Number.POSITIVE_INFINITY },
        });
    });

    it('simplifies singleton $in only for finite primitive values', () =>
    {
        const objectId = new ObjectId('000000000000000000000001');
        const filter = {
            score: { $in: [10] },
            status: { $in: ['active'] },
            enabled: { $in: [true] },
            regex: { $in: [/active/i] },
            embeddedOperator: { $in: [{ $gt: 1 }] },
            objectId: { $in: [objectId] },
            nullValue: { $in: [null] },
            nonFinite: { $in: [Number.NaN] },
        };

        expect(
            optimizeFilterWithCandidateProfile(filter, ['simplify-singleton-in']),
        ).toEqual({
            score: 10,
            status: 'active',
            enabled: true,
            regex: { $in: [/active/i] },
            embeddedOperator: { $in: [{ $gt: 1 }] },
            objectId: { $in: [objectId] },
            nullValue: { $in: [null] },
            nonFinite: { $in: [Number.NaN] },
        });
    });

    it('deduplicates $in elements and simplifies to scalar equality when possible', () =>
    {
        expect(
            optimizeFilterWithCandidateProfile({
                tag: { $in: ['a', 'a'] },
            }, ['simplify-singleton-in']),
        ).toEqual({
            tag: 'a',
        });

        expect(
            optimizeFilterWithCandidateProfile({
                tag: { $in: ['a', 'b', 'a'] },
            }, ['simplify-singleton-in']),
        ).toEqual({
            tag: { $in: ['a', 'b'] },
        });

        expect(
            optimizeFilterWithCandidateProfile({
                tag: { $in: [/abc/i, /abc/i] },
            }, ['simplify-singleton-in']),
        ).toEqual({
            tag: { $in: [/abc/i] },
        });

        const uniqueIn = { tag: { $in: ['a', 'b'] } };
        expect(
            optimizeFilterWithCandidateProfile(uniqueIn, ['simplify-singleton-in']),
        ).toEqual(uniqueIn);
    });

    it('deduplicates $or branches and unwraps single-condition disjunctions', () =>
    {
        expect(
            optimizeFilterWithCandidateProfile({
                $or: [{ a: 1 }, { a: 1 }],
            }, ['simplify-disjunction-identities']),
        ).toEqual({
            a: 1,
        });

        expect(
            optimizeFilterWithCandidateProfile({
                $or: [{ status: 'active' }],
            }, ['simplify-disjunction-identities']),
        ).toEqual({
            status: 'active',
        });

        expect(
            optimizeFilterWithCandidateProfile({
                $or: [{ a: 1 }, { b: 2 }, { a: 1 }],
            }, ['simplify-disjunction-identities']),
        ).toEqual({
            $or: [{ a: 1 }, { b: 2 }],
        });

        expect(
            optimizeFilterWithCandidateProfile({
                tenant: 'acme',
                $or: [{ a: 1 }, { a: 1 }],
            }, ['simplify-disjunction-identities']),
        ).toEqual({
            tenant: 'acme',
            $or: [{ a: 1 }],
        });

        expect(
            optimizeFilterWithCandidateProfile({
                tenant: 'acme',
                $and: [{}],
            }, ['simplify-conjunction-identities']),
        ).toEqual({
            tenant: 'acme',
        });

        expect(
            optimizeFilterWithCandidateProfile({
                $and: [{}],
            }, ['simplify-conjunction-identities']),
        ).toEqual({});

        expect(
            optimizeFilterWithCandidateProfile({
                tag: { $in: 'invalid' as any },
            }, ['simplify-singleton-in']),
        ).toEqual({
            tag: { $in: 'invalid' },
        });

        expect(
            optimizeFilterWithCandidateProfile({
                $and: ['not-an-object', { a: 1 }],
            }, ['merge-conjunctions']),
        ).toEqual({
            $and: ['not-an-object', { a: 1 }],
        });
    });

    it('flattens only valid non-empty arrays of the same logical operator', () =>
    {
        expect(
            optimizeFilterWithCandidateProfile({
                $and: [
                    { a: 1 },
                    { $and: [{ b: 2 }, { c: 3 }] },
                ],
            }, ['flatten-conjunctions']),
        ).toEqual({
            $and: [
                { a: 1 },
                { b: 2 },
                { c: 3 },
            ],
        });

        expect(
            optimizeFilterWithCandidateProfile({
                $or: [
                    { a: 1 },
                    { $or: [{ b: 2 }, { c: 3 }] },
                ],
            }, ['flatten-disjunctions']),
        ).toEqual({
            $or: [
                { a: 1 },
                { b: 2 },
                { c: 3 },
            ],
        });

        const nestedInvalid = {
            $and: [
                { a: 1 },
                { $and: [] },
            ],
        };
        expect(
            optimizeFilterWithCandidateProfile(nestedInvalid, ['flatten-conjunctions']),
        ).toEqual(nestedInvalid);

        const unsupported = {
            $or: [
                { $or: [{ a: 1 }, { b: 2 }] },
                { $dynamicPredicate: true },
            ],
        };
        expect(
            optimizeFilterWithCandidateProfile(unsupported, ['flatten-disjunctions']),
        ).toEqual(unsupported);
    });

    it('de-duplicates only BSON- and order-identical conjunction clauses', () =>
    {
        const objectId = '000000000000000000000001';
        const conditions = [
            { pattern: /alpha/i },
            { pattern: new RegExp('alpha', 'i') },
            { pattern: /alpha/g },
            { pattern: /beta/i },
            { bsonPattern: new BSONRegExp('alpha', 'i') },
            { bsonPattern: new BSONRegExp('alpha', 'm') },
            { _id: new ObjectId(objectId) },
            { _id: new ObjectId(objectId) },
            { _id: new ObjectId('000000000000000000000002') },
            { numeric: 1 },
            { numeric: Long.fromNumber(1) },
            { embedded: { $eq: { first: 1, second: 2 } } },
            { embedded: { $eq: { second: 2, first: 1 } } },
        ];

        expect(
            optimizeFilterWithCandidateProfile(
                { $and: conditions },
                ['deduplicate-conjunctions'],
            ),
        ).toEqual({
            $and: [
                conditions[0],
                conditions[2],
                conditions[3],
                conditions[4],
                conditions[5],
                conditions[6],
                conditions[8],
                conditions[9],
                conditions[10],
                conditions[11],
                conditions[12],
            ],
        });
    });

    it('merges only field-disjoint conjunction objects and preserves conflicts', () =>
    {
        const repeatedMultikey = {
            $and: [
                { tags: { $in: [1, 2] } },
                { tags: { $in: [2, 3] } },
                { tenant: 'acme' },
            ],
        };
        expect(
            optimizeFilterWithCandidateProfile(repeatedMultikey, ['merge-conjunctions']),
        ).toEqual({
            tags: { $in: [1, 2] },
            tenant: 'acme',
            $and: [
                { tags: { $in: [2, 3] } },
            ],
        });

        const repeatedRanges = {
            $and: [
                { score: { $gt: 5 } },
                { score: { $lt: 10 } },
                { active: true },
            ],
        };
        expect(
            optimizeFilterWithCandidateProfile(repeatedRanges, ['merge-conjunctions']),
        ).toEqual({
            score: { $gt: 5 },
            active: true,
            $and: [
                { score: { $lt: 10 } },
            ],
        });

        const logicalFirst = {
            $and: [{ a: 1 }, { b: 2 }],
            a: 2,
        };
        const fieldFirst = {
            a: 2,
            $and: [{ a: 1 }, { b: 2 }],
        };
        const expectedMixed = {
            a: 2,
            b: 2,
            $and: [{ a: 1 }],
        };
        expect(
            optimizeFilterWithCandidateProfile(logicalFirst, ['merge-conjunctions']),
        ).toEqual(expectedMixed);
        expect(
            optimizeFilterWithCandidateProfile(fieldFirst, ['merge-conjunctions']),
        ).toEqual(expectedMixed);

        const operatorClause = {
            $and: [
                { $or: [{ a: 1 }, { b: 2 }] },
                { tenant: 'acme' },
            ],
        };
        expect(
            optimizeFilterWithCandidateProfile(operatorClause, ['merge-conjunctions']),
        ).toEqual({
            tenant: 'acme',
            $and: [
                { $or: [{ a: 1 }, { b: 2 }] },
            ],
        });

        expect(
            optimizeFilterWithCandidateProfile({ $and: [] }, ['merge-conjunctions']),
        ).toEqual({ $and: [] });
    });
});

describe('filter-bearing pipelines', () =>
{
    it('optimizes filters and merges adjacent matches in production', () =>
    {
        const pipeline = [
            {
                $match: {
                    $and: [
                        { score: { $eq: 10 } },
                        { active: true },
                    ],
                },
            },
            { $match: { tenant: 'acme' } },
        ];

        expect(optimizePipeline(pipeline)).toEqual([
            {
                $match: {
                    score: 10,
                    active: true,
                    tenant: 'acme',
                },
            },
        ]);
    });

    it('applies the same filter rules in every supported nested pipeline', () =>
    {
        const pipeline = [
            {
                $facet: {
                    branch: [
                        { $match: { a: { $eq: 1 } } },
                        { $match: { b: 2 } },
                    ],
                },
            },
            {
                $lookup: {
                    from: 'orders',
                    pipeline: [
                        { $match: { paid: { $in: [true] } } },
                        { $match: { archived: false } },
                    ],
                    as: 'orders',
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        {
                            $match: {
                                tenant: 'acme',
                                $or: [{}, { archived: false }],
                            },
                        },
                    ],
                },
            },
        ];

        expect(optimizePipeline(pipeline)).toEqual([
            {
                $facet: {
                    branch: [
                        { $match: { a: 1, b: 2 } },
                    ],
                },
            },
            {
                $lookup: {
                    from: 'orders',
                    pipeline: [
                        { $match: { paid: true, archived: false } },
                    ],
                    as: 'orders',
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        { $match: { tenant: 'acme' } },
                    ],
                },
            },
        ]);
    });

    it('allows pipeline candidates to select passes and filter rules independently', () =>
    {
        const pipeline = [
            { $match: { score: { $eq: 10 } } },
            { $match: { active: true } },
        ];

        expect(optimizePipelineWithCandidateProfile(
            pipeline,
            ['filter-optimization'],
            ['simplify-equality'],
        )).toEqual([
            { $match: { score: 10 } },
            { $match: { active: true } },
        ]);

        expect(optimizePipelineWithCandidateProfile(
            pipeline,
            ['adjacent-match-merging'],
            ['merge-conjunctions'],
        )).toEqual([
            {
                $match: {
                    score: { $eq: 10 },
                    active: true,
                },
            },
        ]);
    });

    it('keeps repeated fields in one flat conjunction when merging a match run', () =>
    {
        const pipeline = [
            { $match: { tags: { $in: [1] } } },
            { $match: { tags: { $in: [2] } } },
            { $match: { tags: { $in: [3] } } },
        ];

        expect(optimizePipeline(pipeline)).toEqual([
            {
                $match: {
                    tags: 1,
                    $and: [
                        { tags: 2 },
                        { tags: 3 },
                    ],
                },
            },
        ]);
    });

    it('preserves pipeline input and established exotic leaf references', () =>
    {
        const objectId = new ObjectId('000000000000000000000001');
        const regex = /active/i;
        const pipeline = [
            {
                $match: {
                    pattern: { $eq: regex },
                    _id: { $eq: objectId },
                },
            },
            { $match: { active: true } },
        ];

        const optimized = optimizePipeline(pipeline);

        expect(pipeline).toEqual([
            {
                $match: {
                    pattern: { $eq: regex },
                    _id: { $eq: objectId },
                },
            },
            { $match: { active: true } },
        ]);
        expect(optimized).not.toBe(pipeline);
        expect(optimized[0].$match.pattern.$eq).not.toBe(regex);
        expect(optimized[0].$match.pattern.$eq).toEqual(regex);
        expect(optimized[0].$match._id.$eq).toBe(objectId);
    });

    it('keeps invalid filter-bearing stages structurally unchanged', () =>
    {
        const pipeline = [
            {
                $match: {
                    $and: [
                        { score: { $eq: 10 } },
                        { $or: [] },
                    ],
                },
            },
        ];

        expect(optimizePipeline(pipeline)).toEqual(pipeline);

        const malformedStage = [
            {
                $match: { score: { $eq: 10 } },
                $limit: 1,
            },
            { $match: { active: true } },
        ];
        expect(optimizePipelineWithCandidateProfile(
            malformedStage,
            ['filter-optimization', 'adjacent-match-merging'],
            ['simplify-equality', 'merge-conjunctions'],
        )).toEqual(malformedStage);

        const dynamicMatches = [
            { $match: { $expr: { $rand: {} } } },
            { $match: { active: true } },
        ];
        expect(optimizePipelineWithCandidateProfile(
            dynamicMatches,
            ['filter-optimization', 'adjacent-match-merging'],
            ['merge-conjunctions'],
        )).toEqual(dynamicMatches);
    });
});
