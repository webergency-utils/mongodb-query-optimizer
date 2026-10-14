import { describe, expect, it } from 'vitest';
import {
    proveCorrelatedLookupEqualityNormalization,
    proveExprToNativeMatch,
} from '../src/passes/expr-normalization-proofs.js';
import {
    ExprMatchNormalizationPass,
} from '../src/passes/expr-match-normalization.js';
import { optimizePipeline } from './helpers/pre-gate-optimizer.js';
import { runMockPipeline } from './helpers/mock-engine.js';

describe('proveExprToNativeMatch', () =>
{
    it('normalizes simple equality with field path first', () =>
    {
        const expr = { $eq: ['$sku', 'ABC-123'] };
        const proof = proveExprToNativeMatch(expr);
        expect(proof).toEqual({ sku: 'ABC-123' });
    });

    it('normalizes simple equality with literal first', () =>
    {
        const expr = { $eq: ['ABC-123', '$sku'] };
        const proof = proveExprToNativeMatch(expr);
        expect(proof).toEqual({ sku: 'ABC-123' });
    });

    it('normalizes range operators with standard order', () =>
    {
        expect(proveExprToNativeMatch({ $gt: ['$score', 50] })).toEqual({
            score: { $gt: 50 },
        });
        expect(proveExprToNativeMatch({ $gte: ['$score', 50] })).toEqual({
            score: { $gte: 50 },
        });
        expect(proveExprToNativeMatch({ $lt: ['$score', 50] })).toEqual({
            score: { $lt: 50 },
        });
        expect(proveExprToNativeMatch({ $lte: ['$score', 50] })).toEqual({
            score: { $lte: 50 },
        });
        expect(proveExprToNativeMatch({ $ne: ['$score', 50] })).toEqual({
            score: { $ne: 50 },
        });
    });

    it('normalizes range operators with inverted order', () =>
    {
        // 50 > score <=> score < 50
        expect(proveExprToNativeMatch({ $gt: [50, '$score'] })).toEqual({
            score: { $lt: 50 },
        });
        // 50 >= score <=> score <= 50
        expect(proveExprToNativeMatch({ $gte: [50, '$score'] })).toEqual({
            score: { $lte: 50 },
        });
        // 50 < score <=> score > 50
        expect(proveExprToNativeMatch({ $lt: [50, '$score'] })).toEqual({
            score: { $gt: 50 },
        });
        // 50 <= score <=> score >= 50
        expect(proveExprToNativeMatch({ $lte: [50, '$score'] })).toEqual({
            score: { $gte: 50 },
        });
        expect(proveExprToNativeMatch({ $ne: [50, '$score'] })).toEqual({
            score: { $ne: 50 },
        });
    });

    it('normalizes $in with array literal', () =>
    {
        const expr = { $in: ['$status', ['active', 'pending']] };
        const proof = proveExprToNativeMatch(expr);
        expect(proof).toEqual({
            status: { $in: ['active', 'pending'] },
        });
    });

    it('normalizes $and with multiple simple expressions', () =>
    {
        const expr = {
            $and: [
                { $eq: ['$category', 'electronics'] },
                { $gt: ['$price', 100] },
            ],
        };
        const proof = proveExprToNativeMatch(expr);
        expect(proof).toEqual({
            category: 'electronics',
            price: { $gt: 100 },
        });
    });

    it('merges multiple range conditions on the same field in $and', () =>
    {
        const expr = {
            $and: [
                { $gte: ['$price', 10] },
                { $lte: ['$price', 100] },
            ],
        };
        const proof = proveExprToNativeMatch(expr);
        expect(proof).toEqual({
            price: { $gte: 10, $lte: 100 },
        });
    });

    it('rejects two document field comparisons', () =>
    {
        expect(proveExprToNativeMatch({ $eq: ['$salePrice', '$costPrice'] })).toBeNull();
        expect(proveExprToNativeMatch({ $gt: ['$a', '$b'] })).toBeNull();
    });

    it('rejects system variable references ($$ROOT, $$CURRENT)', () =>
    {
        expect(proveExprToNativeMatch({ $eq: ['$$ROOT.val', 1] })).toBeNull();
        expect(proveExprToNativeMatch({ $eq: [1, '$$CURRENT.val'] })).toBeNull();
    });

    it('rejects non-invertible or unsupported expressions', () =>
    {
        expect(proveExprToNativeMatch({ $mod: ['$qty', 2] })).toBeNull();
        expect(proveExprToNativeMatch({ $eq: [{ $add: ['$qty', 1] }, 5] })).toBeNull();
        expect(proveExprToNativeMatch({ $in: [5, '$arrayField'] })).toBeNull();
        expect(proveExprToNativeMatch({ $in: ['$status', 'not-an-array'] })).toBeNull();
        expect(proveExprToNativeMatch({ $eq: [1, 1] })).toBeNull();
        expect(proveExprToNativeMatch({ $customOp: ['$a', 1] })).toBeNull();
    });

    it('handles object literals, functions, symbols, and nested expressions in literals', () =>
    {
        expect(proveExprToNativeMatch({ $eq: ['$meta', { tag: 'book' }] })).toEqual({
            meta: { tag: 'book' },
        });
        expect(proveExprToNativeMatch({ $eq: ['$meta', { $nested: 1 }] })).toBeNull();
        expect(proveExprToNativeMatch({ $eq: ['$meta', { fn: () => {} }] })).toBeNull();
        expect(proveExprToNativeMatch({ $eq: ['$meta', () => {}] })).toBeNull();
        expect(proveExprToNativeMatch({ $eq: ['$meta', Symbol('test')] })).toBeNull();
        expect(proveExprToNativeMatch({ $eq: ['$meta', undefined] })).toBeNull();
        expect(proveExprToNativeMatch({ $eq: ['$a', '$$ROOT'] })).toBeNull();
    });

    it('rejects unmergable duplicate field conditions in $and', () =>
    {
        const expr = {
            $and: [
                { $eq: ['$status', 'active'] },
                { $eq: ['$status', 'pending'] },
            ],
        };
        expect(proveExprToNativeMatch(expr)).toBeNull();
    });

    it('handles null prototype and custom class objects gracefully', () =>
    {
        const nullProto = Object.create(null);
        nullProto.$eq = ['$sku', 'ABC'];
        expect(proveExprToNativeMatch(nullProto)).toEqual({ sku: 'ABC' });

        class CustomClass {}
        expect(proveExprToNativeMatch(new CustomClass())).toBeNull();
    });

    it('rejects invalid inputs gracefully', () =>
    {
        expect(proveExprToNativeMatch(null)).toBeNull();
        expect(proveExprToNativeMatch(undefined)).toBeNull();
        expect(proveExprToNativeMatch('string')).toBeNull();
        expect(proveExprToNativeMatch([])).toBeNull();
        expect(proveExprToNativeMatch({})).toBeNull();
        expect(proveExprToNativeMatch({ $eq: [] })).toBeNull();
        expect(proveExprToNativeMatch({ $eq: ['$a'] })).toBeNull();
        expect(proveExprToNativeMatch({ $eq: ['$a', 1, 2] })).toBeNull();
        expect(proveExprToNativeMatch({ $eq: ['$a', 1], extra: 1 })).toBeNull();
        expect(proveExprToNativeMatch({ $and: 'not-an-array' })).toBeNull();
        expect(proveExprToNativeMatch({ $and: [] })).toBeNull();
        expect(proveExprToNativeMatch({ $and: [{ $eq: ['$a', '$b'] }] })).toBeNull();
    });
});

describe('ExprMatchNormalizationPass', () =>
{
    const pass = new ExprMatchNormalizationPass();

    it('has expected pass name', () =>
    {
        expect(pass.name).toBe('expr-match-normalization');
    });

    it('rewrites $expr to native match filter', () =>
    {
        const pipeline = [
            { $match: { $expr: { $eq: ['$sku', 'ABC-123'] } } },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual([
            { $match: { sku: 'ABC-123' } },
        ]);
    });

    it('preserves surrounding conditions in $match when normalizing $expr', () =>
    {
        const pipeline = [
            {
                $match: {
                    orgId: 'tenant1',
                    $expr: { $gt: ['$amount', 500] },
                },
            },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual([
            {
                $match: {
                    orgId: 'tenant1',
                    amount: { $gt: 500 },
                },
            },
        ]);
    });

    it('leaves un-normalizable $expr unchanged', () =>
    {
        const pipeline = [
            { $match: { $expr: { $eq: ['$fieldA', '$fieldB'] } } },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual(pipeline);
    });

    it('leaves non-match stages unchanged', () =>
    {
        class CustomStage {}
        const nullProto = Object.create(null);
        nullProto.$match = { $expr: { $eq: ['$a', 1] } };

        const pipeline = [
            { $project: { field: 1 } },
            { $sort: { field: 1 } },
            'not-an-object',
            null,
            new CustomStage(),
            nullProto,
            { $match: { $expr: { $eq: ['$a', 1] } }, extra: 1 },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual([
            { $project: { field: 1 } },
            { $sort: { field: 1 } },
            'not-an-object',
            null,
            new CustomStage(),
            { $match: { a: 1 } },
            { $match: { $expr: { $eq: ['$a', 1] } }, extra: 1 },
        ]);
    });

    it('normalizes $or, $not ($eq, $ne, $in), and $literal in proveExprToNativeMatch and guards collisions', () =>
    {
        // $literal unwrapping in $eq (including operator-shaped literal object) and $in
        expect(proveExprToNativeMatch({
            $eq: ['$tag', { $literal: '$admin' }]
        })).toEqual({ tag: '$admin' });

        expect(proveExprToNativeMatch({
            $eq: [{ $literal: '$admin' }, '$tag']
        })).toEqual({ tag: '$admin' });

        expect(proveExprToNativeMatch({
            $eq: ['$doc', { $literal: { $gt: 5 } }]
        })).toEqual({ doc: { $eq: { $gt: 5 } } });

        expect(proveExprToNativeMatch({
            $eq: [{ $literal: { $gt: 5 } }, '$doc']
        })).toEqual({ doc: { $eq: { $gt: 5 } } });

        expect(proveExprToNativeMatch({
            $in: ['$tag', [{ $literal: '$a' }, 'b']]
        })).toEqual({ tag: { $in: ['$a', 'b'] } });

        // $or normalization and rejection
        expect(proveExprToNativeMatch({
            $or: [
                { $eq: ['$status', 'open'] },
                { $gt: ['$priority', 3] }
            ]
        })).toEqual({
            $or: [
                { status: 'open' },
                { priority: { $gt: 3 } }
            ]
        });

        expect(proveExprToNativeMatch({ $or: [] })).toBeNull();
        expect(proveExprToNativeMatch({ $or: 'not-array' })).toBeNull();
        expect(proveExprToNativeMatch({
            $or: [
                { $eq: ['$status', 'open'] },
                { $eq: ['$a', '$b'] }
            ]
        })).toBeNull();

        // $not over $eq, $ne, $in, and rejection cases
        expect(proveExprToNativeMatch({
            $not: [{ $eq: ['$status', 'archived'] }]
        })).toEqual({ status: { $ne: 'archived' } });

        expect(proveExprToNativeMatch({
            $not: { $ne: ['$status', 'active'] }
        })).toEqual({ status: 'active' });

        expect(proveExprToNativeMatch({
            $not: [{ $in: ['$role', ['guest', { $literal: '$bot' }]] }]
        })).toEqual({ role: { $nin: ['guest', '$bot'] } });

        expect(proveExprToNativeMatch({ $not: 'invalid' })).toBeNull();
        expect(proveExprToNativeMatch({ $not: [{ $eq: 1, $ne: 2 }] })).toBeNull();
        expect(proveExprToNativeMatch({ $not: [{ $eq: ['$a'] }] })).toBeNull();
        expect(proveExprToNativeMatch({ $not: [{ $gt: ['$a', 5] }] })).toBeNull();
        expect(proveExprToNativeMatch({ $not: [{ $in: ['$a', 'not-array'] }] })).toBeNull();
        expect(proveExprToNativeMatch({
            $not: [{ $not: [{ $eq: ['$status', 'open'] }] }]
        })).toEqual({ status: 'open' });
        expect(proveExprToNativeMatch({
            $not: { $not: { $gt: ['$price', 100] } }
        })).toEqual({ price: { $gt: 100 } });
        expect(proveExprToNativeMatch({
            $not: [{ $not: 'invalid' }]
        })).toBeNull();

        // Collision guard in ExprMatchNormalizationPass when $match already has the normalized key
        const collidingPipeline = [
            {
                $match: {
                    $or: [{ a: 1 }, { b: 2 }],
                    $expr: {
                        $or: [
                            { $eq: ['$c', 3] },
                            { $eq: ['$d', 4] }
                        ]
                    }
                }
            }
        ];
        expect(pass.execute(collidingPipeline)).toEqual(collidingPipeline);
    });

    it('normalizes $nor and $regexMatch in proveExprToNativeMatch', () =>
    {
        expect(proveExprToNativeMatch({
            $nor: [
                { $eq: ['$status', 'deleted'] },
                { $lt: ['$score', 0] }
            ]
        })).toEqual({
            $nor: [
                { status: 'deleted' },
                { score: { $lt: 0 } }
            ]
        });

        expect(proveExprToNativeMatch({ $nor: [] })).toBeNull();
        expect(proveExprToNativeMatch({ $nor: [{ $eq: ['$a', '$b'] }] })).toBeNull();

        // $regexMatch without and with options, and with RegExp instance
        expect(proveExprToNativeMatch({
            $regexMatch: { input: '$email', regex: '^admin@' }
        })).toEqual({
            email: { $regex: '^admin@' }
        });

        expect(proveExprToNativeMatch({
            $regexMatch: { input: '$email', regex: '^admin@', options: 'i' }
        })).toEqual({
            email: { $regex: '^admin@', $options: 'i' }
        });

        expect(proveExprToNativeMatch({
            $regexMatch: { input: '$email', regex: /^admin@/i }
        })).toEqual({
            email: { $regex: /^admin@/i }
        });

        // Invalid $regexMatch shapes
        expect(proveExprToNativeMatch({ $regexMatch: 'invalid' })).toBeNull();
        expect(proveExprToNativeMatch({ $regexMatch: { input: 'email', regex: 'a' } })).toBeNull();
        expect(proveExprToNativeMatch({ $regexMatch: { input: '$email' } })).toBeNull();
        expect(proveExprToNativeMatch({ $regexMatch: { input: '$email', regex: 'a', extra: 1 } })).toBeNull();
        expect(proveExprToNativeMatch({ $regexMatch: { input: '$email', regex: 123 } })).toBeNull();
        expect(proveExprToNativeMatch({ $regexMatch: { input: '$email', regex: 'a', options: 123 } })).toBeNull();
    });

    it('normalizes correlated $lookup with let + pipeline $expr equality into localField / foreignField', () =>
    {
        // Full collapse when pipeline only has the correlated $match and let only has the join var
        expect(pass.execute([
            {
                $lookup: {
                    from: 'orders',
                    let: { uid: '$userId' },
                    pipeline: [
                        { $match: { $expr: { $eq: [ '$customerId', '$$uid' ] } } }
                    ],
                    as: 'orders'
                }
            }
        ])).toEqual([
            {
                $lookup: {
                    from: 'orders',
                    localField: 'userId',
                    foreignField: 'customerId',
                    as: 'orders'
                }
            }
        ]);

        // Reversed $eq order ($$uid first) and remaining subpipeline stages + still-used let variable
        expect(proveCorrelatedLookupEqualityNormalization({
            $lookup: {
                from: 'orders',
                let: { uid: '$userId', minAmt: '$minOrder' },
                pipeline: [
                    { $match: { $expr: { $eq: [ '$$uid', '$customerId' ] } } },
                    { $match: { $expr: { $gte: [ '$amount', '$$minAmt' ] } }, extra: [ 123, '$$uid.sub' ] }
                ],
                as: 'orders'
            }
        })).toEqual({
            $lookup: {
                from: 'orders',
                localField: 'userId',
                foreignField: 'customerId',
                let: { uid: '$userId', minAmt: '$minOrder' },
                pipeline: [
                    { $match: { $expr: { $gte: [ '$amount', '$$minAmt' ] } }, extra: [ 123, '$$uid.sub' ] }
                ],
                as: 'orders'
            }
        });

        // Rejection guards
        expect(proveCorrelatedLookupEqualityNormalization(null)).toBeNull();
        expect(proveCorrelatedLookupEqualityNormalization({ $match: {} })).toBeNull();
        expect(proveCorrelatedLookupEqualityNormalization({
            $lookup: { from: '', as: 'out', let: { a: '$a' }, pipeline: [] }
        })).toBeNull();
        expect(proveCorrelatedLookupEqualityNormalization({
            $lookup: { from: 'c', as: 'out', localField: 'a', foreignField: 'b', let: { a: '$a' }, pipeline: [ { $match: {} } ] }
        })).toBeNull();
        expect(proveCorrelatedLookupEqualityNormalization({
            $lookup: { from: 'c', as: 'out', let: { a: '$a' }, pipeline: [ { $limit: 1 } ] }
        })).toBeNull();
        expect(proveCorrelatedLookupEqualityNormalization({
            $lookup: { from: 'c', as: 'out', let: { a: '$a' }, pipeline: [ { $match: { $expr: { $gt: [ '$x', '$$a' ] } } } ] }
        })).toBeNull();
        expect(proveCorrelatedLookupEqualityNormalization({
            $lookup: { from: 'c', as: 'out', let: { a: '$a' }, pipeline: [ { $match: { $expr: { $eq: [ '$x', '$y' ] } } } ] }
        })).toBeNull();
        expect(proveCorrelatedLookupEqualityNormalization({
            $lookup: { from: 'c', as: 'out', let: { a: '$a' }, pipeline: [ { $match: { $expr: { $eq: [ '$x', 123 ] } } } ] }
        })).toBeNull();
        expect(proveCorrelatedLookupEqualityNormalization({
            $lookup: { from: 'c', as: 'out', let: { a: 123 }, pipeline: [ { $match: { $expr: { $eq: [ '$x', '$$a' ] } } } ] }
        })).toBeNull();
    });
});

describe('optimizePipeline execution parity for expr match normalization', () =>
{
    const productDataset = [
        { _id: 1, sku: 'PROD-1', category: 'audio', price: 150, rating: 4.8 },
        { _id: 2, sku: 'PROD-2', category: 'video', price: 300, rating: 4.2 },
        { _id: 3, sku: 'PROD-3', category: 'audio', price: 50, rating: 3.9 },
        { _id: 4, sku: 'PROD-4', category: 'computing', price: 800, rating: 4.9 },
        { _id: 5, sku: 'PROD-5', category: 'video', price: 120, rating: 4.0 },
    ];

    it('normalizes $expr equality into native match and preserves execution parity', () =>
    {
        const pipeline = [
            {
                $match: {
                    $expr: {
                        $eq: ['$category', 'audio'],
                    },
                },
            },
        ];

        const optimized = optimizePipeline(pipeline);
        expect(optimized).toEqual([
            {
                $match: {
                    category: 'audio',
                },
            },
        ]);

        const originalResults = runMockPipeline(productDataset, pipeline);
        const optimizedResults = runMockPipeline(productDataset, optimized);

        expect(optimizedResults).toEqual(originalResults);
        expect(optimizedResults).toHaveLength(2);
    });

    it('normalizes inverted range $expr and preserves execution parity', () =>
    {
        // 200 < price <=> price > 200
        const pipeline = [
            {
                $match: {
                    $expr: {
                        $lt: [200, '$price'],
                    },
                },
            },
        ];

        const optimized = optimizePipeline(pipeline);
        expect(optimized).toEqual([
            {
                $match: {
                    price: { $gt: 200 },
                },
            },
        ]);

        const originalResults = runMockPipeline(productDataset, pipeline);
        const optimizedResults = runMockPipeline(productDataset, optimized);

        expect(optimizedResults).toEqual(originalResults);
        expect(optimizedResults.map((p) => p.sku)).toEqual(['PROD-2', 'PROD-4']);
    });

    it('normalizes compound $expr and downstream group/sort with parity', () =>
    {
        const pipeline = [
            {
                $match: {
                    $expr: {
                        $gte: ['$price', 100],
                    },
                },
            },
            {
                $group: {
                    _id: '$category',
                    totalRevenue: { $sum: '$price' },
                    itemCount: { $sum: 1 },
                },
            },
            {
                $sort: { totalRevenue: -1 },
            },
        ];

        const optimized = optimizePipeline(pipeline);
        expect(optimized[0]).toEqual({
            $match: {
                price: { $gte: 100 },
            },
        });

        const originalResults = runMockPipeline(productDataset, pipeline);
        const optimizedResults = runMockPipeline(productDataset, optimized);

        expect(optimizedResults).toEqual(originalResults);
        expect(optimizedResults).toEqual([
            { _id: 'computing', totalRevenue: 800, itemCount: 1 },
            { _id: 'video', totalRevenue: 420, itemCount: 2 },
            { _id: 'audio', totalRevenue: 150, itemCount: 1 },
        ]);
    });

    it('demonstrates polymorphic divergence: $expr equality over array does not match in production', () =>
    {
        // In production, optimizePipeline does not normalize $expr on array fields
        const pipeline = [
            {
                $match: {
                    $expr: {
                        $eq: ['$tags', 'x'],
                    },
                },
            },
        ];

        const dataset = [
            { _id: 1, tags: ['x', 'y'] },
            { _id: 2, tags: 'x' },
        ];

        // Original $expr matches only doc 2 (where tags is scalar 'x')
        const results = runMockPipeline(dataset, pipeline);
        expect(results.map((d: any) => d._id)).toEqual([2]);
    });
});

