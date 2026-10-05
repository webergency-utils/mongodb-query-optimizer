import { describe, expect, it } from 'vitest';
import {
    proveExprToNativeMatch,
} from '../src/passes/expr-normalization-proofs.js';
import {
    ExprMatchNormalizationPass,
} from '../src/passes/expr-match-normalization.js';
import { optimizePipeline } from '../src/index.js';
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
});
