import { describe, expect, it } from 'vitest';
import {
    proveUnwindPrefilter,
} from '../src/passes/unwind-proofs.js';
import {
    UnwindPrefilterPass,
} from '../src/passes/unwind-prefilter.js';
import { optimizePipeline } from '../src/index.js';
import { runMockPipeline } from './helpers/mock-engine.js';

describe('proveUnwindPrefilter', () =>
{
    it('proves synthesis for simple string path unwind followed by child path match', () =>
    {
        const unwind = { $unwind: '$orders' };
        const match = { $match: { 'orders.total': { $gt: 50 } } };

        const proof = proveUnwindPrefilter(unwind, match);
        expect(proof).not.toBeNull();
        expect(proof?.prefilterStage).toEqual({
            $match: {
                orders: {
                    $elemMatch: {
                        total: { $gt: 50 },
                    },
                },
            },
        });
    });

    it('proves synthesis for object-form unwind with preserveNullAndEmptyArrays: false', () =>
    {
        const unwind = {
            $unwind: {
                path: '$items',
                preserveNullAndEmptyArrays: false,
            },
        };
        const match = {
            $match: {
                'items.status': 'available',
                'items.qty': { $gte: 1 },
            },
        };

        const proof = proveUnwindPrefilter(unwind, match);
        expect(proof).not.toBeNull();
        expect(proof?.prefilterStage).toEqual({
            $match: {
                items: {
                    $elemMatch: {
                        status: 'available',
                        qty: { $gte: 1 },
                    },
                },
            },
        });
    });

    it('extracts only child conditions when match contains other unrelated fields', () =>
    {
        const unwind = { $unwind: '$items' };
        const match = {
            $match: {
                'items.status': 'active',
                orgId: 'corp1',
            },
        };

        const proof = proveUnwindPrefilter(unwind, match);
        expect(proof).not.toBeNull();
        expect(proof?.prefilterStage).toEqual({
            $match: {
                items: {
                    $elemMatch: {
                        status: 'active',
                    },
                },
            },
        });
    });

    it('rejects when preserveNullAndEmptyArrays is true', () =>
    {
        const unwind = {
            $unwind: {
                path: '$items',
                preserveNullAndEmptyArrays: true,
            },
        };
        const match = { $match: { 'items.status': 'active' } };

        expect(proveUnwindPrefilter(unwind, match)).toBeNull();
    });

    it('rejects when downstream match references includeArrayIndex', () =>
    {
        const unwind = {
            $unwind: {
                path: '$items',
                includeArrayIndex: 'itemIndex',
            },
        };
        const match = {
            $match: {
                'items.status': 'active',
                itemIndex: { $gt: 0 },
            },
        };

        expect(proveUnwindPrefilter(unwind, match)).toBeNull();
    });

    it('permits includeArrayIndex when match does not reference it', () =>
    {
        const unwind = {
            $unwind: {
                path: '$items',
                includeArrayIndex: 'itemIndex',
            },
        };
        const match = {
            $match: {
                'items.status': 'active',
            },
        };

        const proof = proveUnwindPrefilter(unwind, match);
        expect(proof).not.toBeNull();
        expect(proof?.prefilterStage).toEqual({
            $match: {
                items: {
                    $elemMatch: {
                        status: 'active',
                    },
                },
            },
        });
    });

    it('rejects when match has no conditions on unwound array', () =>
    {
        const unwind = { $unwind: '$items' };
        const match = { $match: { status: 'active', score: 100 } };

        expect(proveUnwindPrefilter(unwind, match)).toBeNull();
    });

    it('rejects when match contains non-deterministic expressions', () =>
    {
        const unwind = { $unwind: '$items' };
        const match = {
            $match: {
                'items.val': { $expr: { $gt: [{ $rand: {} }, 0.5] } },
            },
        };

        expect(proveUnwindPrefilter(unwind, match)).toBeNull();
    });

    it('handles null prototype and custom class objects gracefully', () =>
    {
        const nullProtoMatch = Object.create(null);
        nullProtoMatch['orders.total'] = { $gt: 50 };

        const proof = proveUnwindPrefilter({ $unwind: '$orders' }, { $match: nullProtoMatch });
        expect(proof).not.toBeNull();

        class CustomClass {}
        expect(proveUnwindPrefilter(new CustomClass(), { $match: {} })).toBeNull();
        expect(proveUnwindPrefilter({ $unwind: '$orders' }, new CustomClass())).toBeNull();
    });

    it('rejects invalid unwind or match stages', () =>
    {
        expect(proveUnwindPrefilter(null, { $match: {} })).toBeNull();
        expect(proveUnwindPrefilter({ $unwind: '$a' }, null)).toBeNull();
        expect(proveUnwindPrefilter('not-object', { $match: {} })).toBeNull();
        expect(proveUnwindPrefilter({ $unwind: 123 }, { $match: {} })).toBeNull();
        expect(proveUnwindPrefilter({ $unwind: 'invalid-path-no-dollar' }, { $match: {} })).toBeNull();
        expect(proveUnwindPrefilter({ $unwind: { path: 123 } }, { $match: {} })).toBeNull();
        expect(proveUnwindPrefilter({ $unwind: { path: 'no-dollar' } }, { $match: {} })).toBeNull();
        expect(proveUnwindPrefilter({ $unwind: '$a', extra: 1 }, { $match: {} })).toBeNull();
        expect(proveUnwindPrefilter({ $unwind: '$a' }, { $match: 'not-object' })).toBeNull();
        expect(proveUnwindPrefilter({ $unwind: '$a' }, { notMatch: {} })).toBeNull();
        expect(proveUnwindPrefilter({ $unwind: '$a' }, { $match: {}, extra: 1 })).toBeNull();
    });

    it('rejects when downstream match has RegExp or negative operators', () =>
    {
        const unwind = { $unwind: '$items' };
        expect(proveUnwindPrefilter(unwind, { $match: { 'items.name': /abc/ } })).toBeNull();
        expect(proveUnwindPrefilter(unwind, { $match: { 'items.name': { $ne: 'abc' } } })).toBeNull();
        expect(proveUnwindPrefilter(unwind, { $match: { 'items.name': { $not: { $eq: 'abc' } } } })).toBeNull();
        expect(proveUnwindPrefilter(unwind, { $match: { 'items.name': { $nin: ['abc'] } } })).toBeNull();
    });
});

describe('UnwindPrefilterPass', () =>
{
    const pass = new UnwindPrefilterPass();

    it('has expected pass name', () =>
    {
        expect(pass.name).toBe('unwind-prefilter');
    });

    it('inserts synthesized prefilter ahead of $unwind and keeps downstream $match intact', () =>
    {
        const pipeline = [
            { $match: { orgId: '123' } },
            { $unwind: '$items' },
            { $match: { 'items.available': true } },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual([
            { $match: { orgId: '123' } },
            { $match: { items: { $elemMatch: { available: true } } } },
            { $unwind: '$items' },
            { $match: { 'items.available': true } },
        ]);

        const firstStageUnwindPipeline = [
            { $unwind: '$items' },
            { $match: { 'items.available': true } },
        ];
        expect(pass.execute(firstStageUnwindPipeline)).toEqual([
            { $match: { items: { $elemMatch: { available: true } } } },
            { $unwind: '$items' },
            { $match: { 'items.available': true } },
        ]);
    });

    it('is idempotent and does not duplicate prefilter if already present', () =>
    {
        const pipeline = [
            { $match: { orgId: '123' } },
            { $match: { items: { $elemMatch: { available: true } } } },
            { $unwind: '$items' },
            { $match: { 'items.available': true } },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual(pipeline);

        const mergedPipeline = [
            {
                $match: {
                    $and: [
                        { orgId: '123' },
                        { items: { $elemMatch: { available: true } } },
                    ],
                },
            },
            { $unwind: '$items' },
            { $match: { 'items.available': true } },
        ];
        expect(pass.execute(mergedPipeline)).toEqual(mergedPipeline);

        const nonMatchingAndPipeline = [
            {
                $match: {
                    $and: [
                        { orgId: '123' },
                        { items: { $elemMatch: { available: false } } },
                    ],
                },
            },
            { $unwind: '$items' },
            { $match: { 'items.available': true } },
        ];
        const nonMatchingResult = pass.execute(nonMatchingAndPipeline);
        expect(nonMatchingResult.length).toBe(4);

        const nonObjectMatchPipeline = [
            { $match: null as any },
            { $unwind: '$items' },
            { $match: { 'items.available': true } },
        ];
        expect(pass.execute(nonObjectMatchPipeline).length).toBe(4);
    });

    it('leaves pipelines without applicable unwind unchanged', () =>
    {
        const pipeline = [
            { $unwind: { path: '$items', preserveNullAndEmptyArrays: true } },
            { $match: { 'items.available': true } },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual(pipeline);
    });
});

describe('optimizePipeline execution parity for unwind prefilter', () =>
{
    const ordersDataset = [
        {
            _id: 1,
            orderId: 'ORD-1',
            customer: 'Alice',
            items: [
                { sku: 'A', price: 60, inStock: true },
                { sku: 'B', price: 20, inStock: false },
            ],
        },
        {
            _id: 2,
            orderId: 'ORD-2',
            customer: 'Bob',
            items: [
                { sku: 'C', price: 15, inStock: true },
            ],
        },
        {
            _id: 3,
            orderId: 'ORD-3',
            customer: 'Charlie',
            items: [],
        },
        {
            _id: 4,
            orderId: 'ORD-4',
            customer: 'Diana',
        },
    ];

    it('synthesizes elemMatch prefilter and preserves execution parity on array unwind', () =>
    {
        const pipeline = [
            { $unwind: '$items' },
            { $match: { 'items.price': { $gt: 50 } } },
        ];

        const optimized = optimizePipeline(pipeline);
        expect(optimized[0]).toEqual({
            $match: {
                items: {
                    $elemMatch: {
                        price: { $gt: 50 },
                    },
                },
            },
        });

        const originalResults = runMockPipeline(ordersDataset, pipeline);
        const optimizedResults = runMockPipeline(ordersDataset, optimized);

        expect(optimizedResults).toEqual(originalResults);
        expect(optimizedResults).toEqual([
            {
                _id: 1,
                orderId: 'ORD-1',
                customer: 'Alice',
                items: { sku: 'A', price: 60, inStock: true },
            },
        ]);
    });

    it('synthesizes compound conditions with status and price and preserves execution parity', () =>
    {
        const pipeline = [
            { $unwind: '$items' },
            {
                $match: {
                    'items.inStock': true,
                    'items.price': { $gte: 20 },
                },
            },
        ];

        const optimized = optimizePipeline(pipeline);
        expect(optimized[0]).toEqual({
            $match: {
                items: {
                    $elemMatch: {
                        inStock: true,
                        price: { $gte: 20 },
                    },
                },
            },
        });

        const originalResults = runMockPipeline(ordersDataset, pipeline);
        const optimizedResults = runMockPipeline(ordersDataset, optimized);

        expect(optimizedResults).toEqual(originalResults);
    });

    it('handles pipeline with preceding match, sort, and project while preserving parity', () =>
    {
        const pipeline = [
            { $match: { customer: { $ne: 'Charlie' } } },
            { $unwind: '$items' },
            { $match: { 'items.price': { $gt: 10 } } },
            {
                $project: {
                    orderId: 1,
                    sku: '$items.sku',
                    price: '$items.price',
                },
            },
            { $sort: { price: -1 } },
        ];

        const optimized = optimizePipeline(pipeline);
        const originalResults = runMockPipeline(ordersDataset, pipeline);
        const optimizedResults = runMockPipeline(ordersDataset, optimized);

        expect(optimizedResults).toEqual(originalResults);
        expect(optimizedResults.length).toBe(3);
        expect(optimizedResults[0].sku).toBe('A');
    });
});
