import {
    BSONRegExp,
    Long,
    ObjectId,
} from 'mongodb';
import { describe, expect, it } from 'vitest';
import {
    optimizeFilterWithCandidateProfile,
    optimizeFilterWithContext,
    optimizeFilterWithRulesForTesting,
} from '../src/filter-optimizer.js';
import { resolveFilterGuarantees } from '../src/guarantees.js';
import type { FilterRule } from '../src/filter-rule-registry.js';
import { isFilterContradiction } from '../src/analyzer/filters.js';
import {
    optimizeFilter,
    optimizePipeline,
} from './helpers/pre-gate-optimizer.js';
import { optimizeFilter as productionOptimizeFilter } from '../src/index.js';
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
            _id: objectId,
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
        expect(optimized._id).toBe(objectId);
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

        const oversizedUnsafeOr =
        {
            $or: Array.from(
                { length: 100 },
                ( _, index ) => index === 75
                    ? { $where: 'this.a > 1' }
                    : { branch: index }
            ),
            a: { $in: [ 1, 1 ] }
        };

        expect( optimizeFilter( oversizedUnsafeOr )).toEqual( oversizedUnsafeOr );
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
    it('simplifies only finite primitive, valid Date, and ObjectId equality forms', () =>
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
            objectId,
            nullValue: { $eq: null },
            nonFinite: { $eq: Number.POSITIVE_INFINITY },
        });
    });

    it('simplifies singleton $in only for finite primitive, valid Date, and ObjectId values', () =>
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
            objectId,
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
        expect(optimized[0].$match.pattern.$eq).toBe(regex);
        expect(optimized[0].$match._id).toBe(objectId);
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

    it('identifies filter contradictions across all branch variants', () =>
    {
        expect(isFilterContradiction(null)).toBe(false);
        expect(isFilterContradiction(123)).toBe(false);
        expect(isFilterContradiction({ $and: [] })).toBe(false);
        expect(isFilterContradiction({ a: 1 })).toBe(false);
        expect(isFilterContradiction({ a: { $gt: 5 } })).toBe(false);
        expect(isFilterContradiction({ a: { $in: [1] } })).toBe(false);
        expect(isFilterContradiction({ a: { $in: [] } })).toBe(true);
    });

    it('simplifies interval bounds via subsumption tightening and detects contradictions', () =>
    {
        expect(optimizeFilter({ age: { $gt: 50, $lt: 30 } })).toEqual({
            age: { $in: [] },
        });

        expect(optimizeFilter({ age: { $gt: 30, $lt: 30 } })).toEqual({
            age: { $in: [] },
        });

        expect(optimizeFilter({ age: { $gte: 50, $lte: 30 } })).toEqual({
            age: { $in: [] },
        });

        expect(optimizeFilter({ age: { $gte: 30, $lte: 30 } })).toEqual({
            age: 30,
        });

        expect(optimizeFilter({ age: { $gt: 10, $gte: 20 } })).toEqual({
            age: { $gte: 20 },
        });

        expect(optimizeFilter({ age: { $gt: 20, $gte: 10 } })).toEqual({
            age: { $gt: 20 },
        });

        expect(optimizeFilter({ age: { $gt: 10, $gte: 10 } })).toEqual({
            age: { $gt: 10 },
        });

        expect(optimizeFilter({ age: { $lt: 50, $lte: 30 } })).toEqual({
            age: { $lte: 30 },
        });

        expect(optimizeFilter({ age: { $lt: 30, $lte: 50 } })).toEqual({
            age: { $lt: 30 },
        });

        expect(optimizeFilter({ age: { $lt: 30, $lte: 30 } })).toEqual({
            age: { $lt: 30 },
        });

        expect(optimizeFilter({ age: { $eq: 25, $gt: 10, $lt: 50 } })).toEqual({
            age: 25,
        });

        expect(optimizeFilter({ age: { $eq: 5, $gt: 10 } })).toEqual({
            age: { $in: [] },
        });

        expect(optimizeFilter({ age: { $eq: 55, $lt: 30 } })).toEqual({
            age: { $in: [] },
        });

        expect(optimizeFilter({ age: { $gt: 'a', $lt: 'z' } })).toEqual({
            age: { $gt: 'a', $lt: 'z' },
        });

        expect(optimizeFilter({
            $and: [
                { age: { $gt: 50, $lt: 30 } },
                { name: 'Alice' },
            ],
        })).toEqual({
            age: { $in: [] },
        });

        expect(optimizeFilter({
            $or: [
                { age: { $gt: 50, $lt: 30 } },
                { name: 'Alice' },
            ],
        })).toEqual({
            name: 'Alice',
        });
    });

    it('short-circuits pipelines on contradictory match filters', () =>
    {
        const pipeline = [
            { $match: { age: { $gt: 50, $lt: 30 } } },
            { $sort: { score: -1 } },
            { $project: { name: 1 } },
        ];

        expect(optimizePipeline(pipeline)).toEqual([
            { $match: { age: { $in: [] } } },
        ]);
    });

    it('tightens Date range intervals, detects Date contradictions, and deduplicates $nin arrays', () =>
    {
        const d1 = new Date('2025-01-01T00:00:00.000Z');
        const d2 = new Date('2025-06-01T00:00:00.000Z');
        const d3 = new Date('2025-12-01T00:00:00.000Z');

        // Tightens redundant Date lower bound
        expect(optimizeFilter({ createdAt: { $gt: d1, $gte: d2 } })).toEqual({
            createdAt: { $gte: d2 },
        });

        // Detects contradictory Date bounds
        expect(optimizeFilter({ createdAt: { $gt: d3, $lt: d1 } })).toEqual({
            createdAt: { $in: [] },
        });

        // Collapses equal inclusive Date bounds to direct Date equality
        expect(optimizeFilter({ createdAt: { $gte: d2, $lte: new Date(d2.getTime()) } })).toEqual({
            createdAt: d2,
        });

        // Invalid Date is left untouched
        const invalidDate = new Date('invalid');
        expect(optimizeFilter({ createdAt: { $gt: invalidDate } })).toEqual({
            createdAt: { $gt: invalidDate },
        });

        // Deduplicates $nin array elements
        expect(optimizeFilter({ status: { $nin: ['archived', 'deleted', 'archived'] } })).toEqual({
            status: { $nin: ['archived', 'deleted'] },
        });

        // Preserves already-unique $nin array
        expect(optimizeFilter({ status: { $nin: ['archived', 'deleted'] } })).toEqual({
            status: { $nin: ['archived', 'deleted'] },
        });
    });

    it('simplifies set-difference and equality-negation combinations ($in/$eq with $nin/$ne) and drops empty $match stages', () =>
    {
        // Prunes $in elements forbidden by $nin on the same field
        expect(optimizeFilter({
            status: { $in: ['a', 'b', 'c'], $nin: ['b', 'd'] },
        })).toEqual({
            status: { $in: ['a', 'c'], $nin: ['b', 'd'] },
        });

        // Prunes $in elements forbidden by $ne on the same field (preserving $ne for multikey array soundness)
        expect(optimizeFilter({
            status: { $in: ['a', 'b'], $ne: 'b' },
        })).toEqual({
            status: { $in: ['a'], $ne: 'b' },
        });

        // All $in candidates forbidden by $nin -> contradiction { $in: [] }
        expect(optimizeFilter({
            status: { $in: ['a', 'b'], $nin: ['a', 'b', 'c'] },
        })).toEqual({
            status: { $in: [] },
        });

        // Preserves regex elements in $in when $nin/$ne contains non-identical elements
        const regexFilter = {
            status: { $in: [/act/, 'archived'], $ne: 'archived' },
        };
        expect(optimizeFilter(regexFilter)).toEqual({
            status: { $in: [/act/], $ne: 'archived' },
        });

        // $eq with matching $ne -> contradiction { $in: [] }
        expect(optimizeFilter({
            status: { $eq: 'active', $ne: 'active' },
        })).toEqual({
            status: { $in: [] },
        });

        // $eq with non-matching $ne -> preserved (multikey array soundness)
        expect(optimizeFilter({
            status: { $eq: 'active', $ne: 'deleted' },
        })).toEqual({
            status: { $eq: 'active', $ne: 'deleted' },
        });

        // $eq with matching $nin element -> contradiction { $in: [] }
        expect(optimizeFilter({
            status: { $eq: 'active', $nin: ['pending', 'active'] },
        })).toEqual({
            status: { $in: [] },
        });

        // Preserves $ne/$nin alongside array $eq (multikey array semantics)
        const arrayEqWithNe = {
            tags: { $eq: ['a', 'b'], $ne: 'a' },
        };
        expect(optimizeFilter(arrayEqWithNe)).toEqual(arrayEqWithNe);

        // Eliminates no-op { $match: {} } stages in pipeline optimization
        expect(optimizePipeline([
            { $match: { $or: [{}, { a: 1 }] } },
            { $project: { a: 1 } },
        ])).toEqual([
            { $project: { a: 1 } },
        ]);

        // Normalizes $not over single-key $in, $nin, $eq, $ne
        expect(optimizeFilter({
            status: { $not: { $in: ['archived', 'deleted', 'archived'] } },
        })).toEqual({
            status: { $nin: ['archived', 'deleted'] },
        });
        expect(optimizeFilter({
            status: { $not: { $nin: ['active', 'active'] } },
        })).toEqual({
            status: 'active',
        });
        expect(optimizeFilter({
            status: { $not: { $eq: 'deleted' } },
        })).toEqual({
            status: { $ne: 'deleted' },
        });
        expect(optimizeFilter({
            status: { $not: { $ne: 'active' } },
        })).toEqual({
            status: 'active',
        });
        // Preserves $not over range operators ($gt) or multi-key operator objects or when flipped op already exists
        expect(optimizeFilter({
            score: { $not: { $gt: 10 } },
        })).toEqual({
            score: { $not: { $gt: 10 } },
        });
        expect(optimizeFilter({
            score: { $not: { $eq: 1, $ne: 2 } },
        })).toEqual({
            score: { $not: { $eq: 1, $ne: 2 } },
        });
        expect(optimizeFilter({
            status: { $not: { $eq: 'a' }, $ne: 'b' },
        })).toEqual({
            status: { $not: { $eq: 'a' }, $ne: 'b' },
        });

        // Prunes $in elements outside numeric and Date range bounds
        expect(optimizeFilter({
            score: { $in: [1, 5, 10, 15, 20], $gte: 5, $lt: 15 },
        })).toEqual({
            score: { $in: [5, 10], $gte: 5, $lt: 15 },
        });
        expect(optimizeFilter({
            score: { $in: [5, 10], $gt: 5, $lte: 10 },
        })).toEqual({
            score: { $in: [10], $gt: 5, $lte: 10 },
        });
        expect(optimizeFilter({
            score: { $in: [1, 2], $gt: 10 },
        })).toEqual({
            score: { $in: [] },
        });
        expect(optimizeFilter({
            score: { $in: [5, 'ten', 20], $lt: 10 },
        })).toEqual({
            score: { $in: [5, 'ten'], $lt: 10 },
        });
        const d1 = new Date('2025-01-01T00:00:00Z');
        const d2 = new Date('2025-06-01T00:00:00Z');
        const d3 = new Date('2025-12-01T00:00:00Z');
        expect(optimizeFilter({
            createdAt: { $in: [d1, d2, d3], $gt: d1, $lte: d2 },
        })).toEqual({
            createdAt: { $in: [d2], $gt: d1, $lte: d2 },
        });

        // Deduplicates $all and detects contradiction against $ne / $nin
        expect(optimizeFilter({
            tags: { $all: ['a', 'b', 'a', /foo/i, /foo/i] },
        })).toEqual({
            tags: { $all: ['a', 'b', /foo/i] },
        });
        expect(optimizeFilter({
            tags: { $all: ['a', 'b'], $ne: 'b' },
        })).toEqual({
            tags: { $in: [] },
        });
        expect(optimizeFilter({
            tags: { $all: ['a', 'b'], $nin: ['x', 'a'] },
        })).toEqual({
            tags: { $in: [] },
        });
        expect(optimizeFilter({
            tags: { $all: [/foo/], $ne: 'foo' },
        })).toEqual({
            tags: { $all: [/foo/], $ne: 'foo' },
        });

        // Consolidates same-field scalar equality / $in branches in $or (#18)
        expect(optimizeFilter({
            $or: [
                { status: 'active' },
                { status: { $eq: 'pending' } },
                { status: { $in: ['review', 'active'] } },
            ],
        })).toEqual({
            status: { $in: ['active', 'pending', 'review'] },
        });

        // Extracts common factors shared across all $or branches (#17)
        expect(optimizeFilter({
            $or: [
                { tenant: 'acme', role: 'admin' },
                { tenant: 'acme', role: 'owner' },
            ],
        })).toEqual({
            tenant: 'acme',
            role: { $in: ['admin', 'owner'] },
        });
    });
});

describe( 'production safe filter profile (8 active rules)', () =>
{
    it( 'deduplicates identical scalar and multikey range branches', () =>
    {
        expect( productionOptimizeFilter( {
            $and: [ { a: 1 }, { a: 1 } ]
        } ) ).toEqual( { a: 1 } );

        expect( productionOptimizeFilter( {
            $and: [ { tags: { $gt: 5 } }, { tags: { $gt: 5 } } ]
        } ) ).toEqual( { tags: { $gt: 5 } } );
    } );

    it( 'flattens nested associative logical arrays and merges non-conflicting conjunctions', () =>
    {
        expect( productionOptimizeFilter( {
            $and: [
                { $and: [ { a: 1 }, { b: 2 } ] },
                { c: 3 }
            ]
        } ) ).toEqual( {
            a: 1,
            b: 2,
            c: 3
        } );

        expect( productionOptimizeFilter( {
            $or: [
                { $or: [ { a: 1 }, { b: 2 } ] },
                { c: 3 }
            ]
        } ) ).toEqual( {
            $or: [ { a: 1 }, { b: 2 }, { c: 3 } ]
        } );
    } );

    it( 'simplifies conjunction identities and unwraps single-condition conjunctions', () =>
    {
        expect( productionOptimizeFilter( {
            $and: [ {}, { a: 1 } ]
        } ) ).toEqual( { a: 1 } );

        expect( productionOptimizeFilter( {
            $and: [ { a: 1 } ]
        } ) ).toEqual( { a: 1 } );

        expect( productionOptimizeFilter( {
            $and: [ {} ]
        } ) ).toEqual( {} );
    } );

    it( 'simplifies disjunction identities and handles tautological empty filters', () =>
    {
        expect( productionOptimizeFilter( {
            $or: [ {}, { a: 1 } ]
        } ) ).toEqual( {} );

        expect( productionOptimizeFilter( {
            $or: [ { a: 1 }, { a: 1 } ]
        } ) ).toEqual( { a: 1 } );

        expect( productionOptimizeFilter( {
            $or: [ { a: 1 } ]
        } ) ).toEqual( { a: 1 } );
    } );

    it( 'preserves separate multikey branches across distinct conditions on the same field', () =>
    {
        // Crucial invariant: must NOT collapse into { tags: { $gt: 5, $lt: 10 } }
        expect( productionOptimizeFilter( {
            $and: [
                { tags: { $gt: 5 } },
                { tags: { $lt: 10 } }
            ]
        } ) ).toEqual( {
            tags: { $gt: 5 },
            $and: [
                { tags: { $lt: 10 } }
            ]
        } );
    } );

    it( 'preserves non-deterministic and dynamic expressions untouched', () =>
    {
        const dynamic = {
            $and: [
                { a: 1 },
                { $expr: { $rand: {} } }
            ]
        };

        expect( productionOptimizeFilter( dynamic ) ).toEqual( dynamic );
    } );

    it( 'normalizes constant $expr, $nor single-branch/contradiction/tautology, and $and/$or boolean absorption', () =>
    {
        // Constant $expr truthy drops $expr; falsy collapses to contradiction
        expect( productionOptimizeFilter({ $expr: true, a: 1 }) ).toEqual({ a: 1 });
        expect( productionOptimizeFilter({ $expr: 42 }) ).toEqual({});
        expect( productionOptimizeFilter({ $expr: false, a: 1 }) ).toEqual({ _id: { $in: [] } });
        expect( productionOptimizeFilter({ $expr: 0 }) ).toEqual({ _id: { $in: [] } });
        expect( productionOptimizeFilter({ $expr: null }) ).toEqual({ _id: { $in: [] } });

        // $nor tautological branch -> contradiction; contradictory branch -> pruned; single branch -> $ne / $nin
        expect( productionOptimizeFilter({
            $nor: [ {}, { a: 1 } ]
        }) ).toEqual({ _id: { $in: [] } });

        expect( productionOptimizeFilter({
            $nor: [ { a: { $in: [] } }, { b: 'x' } ]
        }) ).toEqual({ b: { $ne: 'x' } });

        expect( productionOptimizeFilter({
            $nor: [ { b: { $eq: 10 } } ]
        }) ).toEqual({ b: { $ne: 10 } });

        expect( productionOptimizeFilter({
            $nor: [ { b: { $in: [ 1, 2 ] } } ]
        }) ).toEqual({ b: { $nin: [ 1, 2 ] } });

        expect( productionOptimizeFilter({
            $nor: [ { a: { $in: [] } } ]
        }) ).toEqual({});

        // Boolean absorption: A && (A || B) -> A, A || (A && B) -> A
        expect( productionOptimizeFilter({
            $and: [
                { a: 1 },
                { $or: [ { a: 1 }, { b: 2 } ] }
            ]
        }) ).toEqual({ a: 1 });

        expect( productionOptimizeFilter({
            $or: [
                { a: 1 },
                { $and: [ { a: 1 }, { b: 2 } ] }
            ]
        }) ).toEqual({ a: 1 });
    } );

    it( 'AE2: collapses duplicate ObjectId while retaining key-order-distinct subdocuments in order', () =>
    {
        const oid1 = new ObjectId( '65b9f1a0e4b0a1b2c3d4e5f6' );
        const oid2 = new ObjectId( '65b9f1a0e4b0a1b2c3d4e5f6' );
        const sub1 = { a: 1, b: 2 };
        const sub2 = { b: 2, a: 1 };
        const input = {
            tags: { $in: [ oid1, oid2, sub1, sub2 ] }
        };

        const optimized = optimizeFilter( input );

        expect( optimized ).toEqual({
            tags: { $in: [ oid1, sub1, sub2 ] }
        });
        expect( optimized.tags.$in[ 0 ] ).toBe( oid1 );
        expect( optimized.tags.$in[ 1 ] ).toBe( sub1 );
        expect( optimized.tags.$in[ 2 ] ).toBe( sub2 );
    } );

    it( 'enforces 64 vs 65 element cap on logical AST branches while supporting unconstrained linear value arrays', () =>
    {
        const in64 = [ ...Array.from({ length: 63 }, ( _, i ) => i ), 0 ];
        const in65 = [ ...Array.from({ length: 64 }, ( _, i ) => i ), 0 ];

        expect( optimizeFilter({ a: { $in: in64 } }).a.$in ).toHaveLength( 63 );

        const resIn65 = optimizeFilter({ a: { $in: in65 }, b: { $eq: 1 } });
        expect( resIn65.a.$in ).toHaveLength( 64 );
        expect( resIn65.b ).toBe( 1 );

        expect( optimizeFilter({ a: { $nin: in64 } }).a.$nin ).toHaveLength( 63 );
        const resNin65 = optimizeFilter({ a: { $nin: in65 }, b: { $eq: 1 } });
        expect( resNin65.a.$nin ).toHaveLength( 64 );
        expect( resNin65.b ).toBe( 1 );

        expect( optimizeFilter({ a: { $all: in64 } }).a.$all ).toHaveLength( 63 );
        const resAll65 = optimizeFilter({ a: { $all: in65 }, b: { $eq: 1 } });
        expect( resAll65.a.$all ).toHaveLength( 64 );
        expect( resAll65.b ).toBe( 1 );

        // Cross-filtering and range pruning supported on large value arrays
        const crossIn65 = optimizeFilter({ a: { $in: in65, $ne: 0, $gt: 10 } });
        expect( crossIn65.a.$in.every(( x: number ) => x > 10 && x !== 0 )).toBe( true );

        const crossNin65 = optimizeFilter({ a: { $in: [ 0, 1 ], $nin: in65 } });
        expect( crossNin65.a.$in ).toEqual([]);

        const crossEqNin65 = optimizeFilter({ a: { $eq: 0, $nin: in65 } });
        expect( crossEqNin65.a.$in ).toEqual([]);

        const crossAll65 = optimizeFilter({ a: { $all: in65, $ne: 0 } });
        expect( crossAll65.a.$in ).toEqual([]);

        // $and 64 vs 65 (with root 'a' occupied so conflicting branches remain in $and)
        const and64 = [ ...Array.from({ length: 63 }, ( _, i ) => ({ a: { $gt: i + 1 } })), { a: { $gt: 1 } } ];
        const and65 = [ ...Array.from({ length: 64 }, ( _, i ) => ({ a: { $gt: i + 1 } })), { a: { $gt: 1 } } ];

        expect( productionOptimizeFilter({ a: { $gt: 0 }, $and: and64 }).$and ).toHaveLength( 63 );
        const resAnd65 = productionOptimizeFilter({ a: { $gt: 0 }, $and: and65, tenant: 'acme' });
        expect( resAnd65.$and ).toBe( and65 );
        expect( resAnd65.tenant ).toBe( 'acme' );

        // $or 64 vs 65
        const or64 = [ ...Array.from({ length: 63 }, ( _, i ) => ({ a: i })), { a: 0 } ];
        const or65 = [ ...Array.from({ length: 64 }, ( _, i ) => ({ a: i })), { a: 0 } ];

        expect( optimizeFilter({ $or: or64 }) ).toEqual({
            a: { $in: Array.from({ length: 63 }, ( _, i ) => i ) }
        });
        const resOr65 = optimizeFilter({ $or: or65, b: { $eq: 2 } });
        expect( resOr65.$or ).toBe( or65 );
        expect( resOr65.b ).toBe( 2 );

        // $or with > 64 branches still collapses empty-object tautology and prunes contradictions
        const or65WithEmpty = [ ...Array.from({ length: 64 }, ( _, i ) => ({ a: i })), {} ];
        expect( optimizeFilter({ $or: or65WithEmpty, b: { $eq: 2 } }) ).toEqual({ b: 2 });

        // $or-to-$in branch cap (> 64 elements in a branch $in) and accumulator cap (> 64 combined unique values)
        const resOrBranchIn65 = optimizeFilter({ $or: [ { a: { $in: in65 } }, { a: 99 } ] });
        expect( resOrBranchIn65 ).toEqual({ $or: [ { a: { $in: optimizeFilter({ a: { $in: in65 } }).a.$in } }, { a: 99 } ] });

        const in40First = Array.from({ length: 40 }, ( _, i ) => i );
        const in40Second = Array.from({ length: 40 }, ( _, i ) => i + 40 );
        const resOrCombined80 = optimizeFilter({
            $or: [ { a: { $in: in40First } }, { a: { $in: in40Second } } ]
        });
        expect( resOrCombined80 ).toEqual({
            $or: [ { a: { $in: in40First } }, { a: { $in: in40Second } } ]
        });

        // $nor 64 vs 65
        const nor64 = [ ...Array.from({ length: 63 }, ( _, i ) => ({ a: i })), { a: 0 } ];
        const nor65 = [ ...Array.from({ length: 64 }, ( _, i ) => ({ a: i })), { a: 0 } ];

        expect( optimizeFilter({ $nor: nor64 }).$nor ).toHaveLength( 63 );
        const resNor65 = optimizeFilter({ $nor: nor65, b: { $eq: 2 } });
        expect( resNor65.$nor ).toBe( nor65 );
        expect( resNor65.b ).toBe( 2 );
    } );

    it( 'sweeps $elemMatch children inside $all arrays and preserves copy-on-write references', () =>
    {
        const firstElem = { $elemMatch: { a: 1 } };
        const secondElem = { $elemMatch: { b: { $eq: 2 } } };
        const input = {
            items: { $all: [ firstElem, secondElem ] }
        };

        const optimized = optimizeFilter( input );

        expect( optimized ).toEqual({
            items: { $all: [ { $elemMatch: { a: 1 } }, { $elemMatch: { b: 2 } } ] }
        });
        expect( optimized.items.$all[ 0 ] ).toBe( firstElem );
        expect( optimized.items.$all[ 1 ] ).toEqual({ $elemMatch: { b: 2 } });

        const optimalAll = [ { $elemMatch: { a: 1 } }, { $elemMatch: { b: 2 } } ];
        const optimalInput = { items: { $all: optimalAll } };
        const optimalResult = optimizeFilter( optimalInput );

        expect( optimalResult.items ).toBe( optimalInput.items );
        expect( optimalResult.items.$all ).toBe( optimalAll );
    } );

    it( 'preserves copy-on-write reference identity on already-optimal filters', () =>
    {
        const oid = new ObjectId( '65b9f1a0e4b0a1b2c3d4e5f6' );
        const date = new Date( '2026-01-01T00:00:00.000Z' );
        const regex = /^active/i;
        const meta = { region: 'eu', tier: 2 };
        const inArr = [ 'open', 'pending' ];
        const notCond = { $gt: 100 };
        const elemMatchCond = { score: { $gt: 5 } };
        const tagsRoot = { $gt: 1 };
        const andBranches = [ { tags: { $lt: 10 } }, { tags: { $ne: 5 } } ];
        const orBranches = [ { x: 1 }, { y: 2 } ];

        const input = {
            _id: oid,
            createdAt: date,
            pattern: regex,
            meta,
            status: { $in: inArr },
            amount: { $not: notCond },
            items: { $elemMatch: elemMatchCond },
            tags: tagsRoot,
            $and: andBranches,
            $or: orBranches
        };

        const optimized = productionOptimizeFilter( input );

        expect( optimized ).not.toBe( input );
        expect( optimized ).toEqual( input );
        expect( optimized._id ).toBe( oid );
        expect( optimized.createdAt ).toBe( date );
        expect( optimized.pattern ).toBe( regex );
        expect( optimized.meta ).toBe( meta );
        expect( optimized.status ).toBe( input.status );
        expect( optimized.status.$in ).toBe( inArr );
        expect( optimized.amount ).toBe( input.amount );
        expect( optimized.amount.$not ).toBe( notCond );
        expect( optimized.items ).toBe( input.items );
        expect( optimized.items.$elemMatch ).toBe( elemMatchCond );
        expect( optimized.tags ).toBe( tagsRoot );
        expect( optimized.$and ).toBe( andBranches );
        expect( optimized.$or ).toBe( orBranches );

        const contextResult = optimizeFilterWithContext( input, resolveFilterGuarantees() );
        expect( contextResult ).toBe( input );
    } );

    it( 'deduplicates identical fields across $and branches, absorbs multi-key $or branches, and prunes $elemMatch-subsumed dotted fields', () =>
    {
        const oid = new ObjectId( '65b9f1a0e4b0a1b2c3d4e5f6' );

        // Partial conjunction merge: deduplicates 'deleted' while preserving conflicting 'score' range
        expect( optimizeFilter({
            $and: [
                { score: { $gt: 1 }, deleted: { $ne: true } },
                { score: { $lt: 10 }, deleted: { $ne: true } }
            ]
        }) ).toEqual({
            score: { $gt: 1 },
            deleted: { $ne: true },
            $and: [
                { score: { $lt: 10 } }
            ]
        });

        // Multi-key $or branch absorbed by enclosing conjunction
        expect( optimizeFilter({
            a: 'HIRED',
            b: { $gte: 10 },
            $or: [
                { a: 'HIRED', b: { $gte: 10 } },
                { c: 'fallback' }
            ]
        }) ).toEqual({
            a: 'HIRED',
            b: { $gte: 10 }
        });

        // $elemMatch subsumption of redundant top-level dotted equality (both uncloned and cloned)
        expect( optimizeFilter({
            members: {
                $elemMatch: {
                    accountID: oid,
                    active: true,
                    $or: [ { role: 'admin' }, { role: 'owner' } ]
                }
            },
            'members.accountID': oid,
            'members.other': 'keep'
        }) ).toEqual({
            members: {
                $elemMatch: {
                    accountID: oid,
                    active: true,
                    $or: [ { role: 'admin' }, { role: 'owner' } ]
                }
            },
            'members.other': 'keep'
        });

        expect( optimizeFilter({
            $and: [
                {
                    members: {
                        $elemMatch: {
                            accountID: { $eq: oid },
                            active: { $eq: true }
                        }
                    },
                    deleted: { $ne: true }
                },
                {
                    'members.accountID': { $eq: oid },
                    deleted: { $ne: true }
                }
            ]
        }) ).toEqual({
            members: {
                $elemMatch: {
                    accountID: oid,
                    active: true
                }
            },
            deleted: { $ne: true }
        });
    } );

    it( 'hoists non-conflicting field predicates from $and branches that also contain $or and unwraps remaining $or', () =>
    {
        const oid = new ObjectId( 'a7c0b7c058eff18075755c1b' );

        // Simulates Query #11 / #17 / #52 pattern
        expect( optimizeFilter({
            type: 'job-document',
            $and: [
                {
                    deleted: { $ne: true },
                    active: { $ne: false },
                    $or: [
                        { 'briefingID': { $exists: false } },
                        { 'briefingID': null }
                    ]
                },
                {
                    'relations.jobIDs': oid
                }
            ]
        }) ).toEqual({
            type: 'job-document',
            'relations.jobIDs': oid,
            deleted: { $ne: true },
            active: { $ne: false },
            $or: [
                { 'briefingID': { $exists: false } },
                { 'briefingID': null }
            ]
        });

        // Simulates Query #54 nested conjunction unwrapping
        expect( optimizeFilter({
            deleted: { $ne: true },
            $and: [
                {
                    deleted: { $ne: true },
                    $and: [
                        {
                            status: 'open',
                            $and: [
                                {
                                    deleted: { $ne: true },
                                    $or: [
                                        { 'app.status': 'submitted' },
                                        { 'app.status': 'interviewing' }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            ]
        }) ).toEqual({
            deleted: { $ne: true },
            status: 'open',
            'app.status': {
                $in: [ 'submitted', 'interviewing' ]
            }
        });
    } );

    it( 'canonicalizes singleton $in and explicit $eq for BSON ObjectId and Date instances', () =>
    {
        const oid = new ObjectId( '40946bd76a4a1e4489a6a406' );
        const date = new Date( '2026-10-14T12:00:00.000Z' );

        expect( optimizeFilter({
            'account.id': { $eq: oid },
            'created.at': { $eq: date }
        }) ).toEqual({
            'account.id': oid,
            'created.at': date
        });

        expect( optimizeFilter({
            'account.id': { $in: [ oid ] },
            'created.at': { $in: [ date ] }
        }) ).toEqual({
            'account.id': oid,
            'created.at': date
        });
    } );
} );


