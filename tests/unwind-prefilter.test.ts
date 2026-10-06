import { describe, expect, it } from 'vitest';
import {
    proveUnwindPrefilter
} from '../src/passes/unwind-proofs.js';
import {
    UnwindPrefilterPass
} from '../src/passes/unwind-prefilter.js';
import { optimizePipeline } from './helpers/pre-gate-optimizer.js';
import { runMockPipeline } from './helpers/mock-engine.js';
import { GuaranteeContext } from '../src/guarantees.js';

describe( 'proveUnwindPrefilter', () =>
{
    it( 'proves synthesis for simple string path unwind followed by child path match', () =>
    {
        const unwind = { $unwind: '$orders' };
        const match = { $match: { 'orders.total': { $gt: 50 } } };

        const proof = proveUnwindPrefilter( unwind, match );
        expect( proof ).not.toBeNull();
        expect( proof?.prefilterStage ).toEqual({
            $match: {
                $or: [
                    { 'orders.total': { $gt: 50 } },
                    { orders: { $elemMatch: { $type: 'array' } } }
                ]
            }
        });
    } );

    it( 'proves synthesis for object-form unwind with preserveNullAndEmptyArrays: false', () =>
    {
        const unwind =
        {
            $unwind:
            {
                path: '$items',
                preserveNullAndEmptyArrays: false
            }
        };
        const match =
        {
            $match:
            {
                'items.status': 'available',
                'items.qty': { $gte: 1 }
            }
        };

        const proof = proveUnwindPrefilter( unwind, match );
        expect( proof ).not.toBeNull();
        expect( proof?.prefilterStage ).toEqual({
            $match: {
                $or: [
                    {
                        'items.status': 'available',
                        'items.qty': { $gte: 1 }
                    },
                    { items: { $elemMatch: { $type: 'array' } } }
                ]
            }
        });
    } );

    it( 'extracts only child conditions when match contains other unrelated fields', () =>
    {
        const unwind = { $unwind: '$items' };
        const match =
        {
            $match:
            {
                'items.status': 'active',
                orgId: 'corp1'
            }
        };

        const proof = proveUnwindPrefilter( unwind, match );
        expect( proof ).not.toBeNull();
        expect( proof?.prefilterStage ).toEqual({
            $match: {
                $or: [
                    { 'items.status': 'active' },
                    { items: { $elemMatch: { $type: 'array' } } }
                ]
            }
        });
    } );

    it( 'rejects when preserveNullAndEmptyArrays is true', () =>
    {
        const unwind =
        {
            $unwind:
            {
                path: '$items',
                preserveNullAndEmptyArrays: true
            }
        };
        const match = { $match: { 'items.status': 'active' } };

        expect( proveUnwindPrefilter( unwind, match ) ).toBeNull();
    } );

    it( 'rejects when downstream match references includeArrayIndex', () =>
    {
        const unwind =
        {
            $unwind:
            {
                path: '$items',
                includeArrayIndex: 'itemIndex'
            }
        };
        const match =
        {
            $match:
            {
                'items.status': 'active',
                itemIndex: { $gt: 0 }
            }
        };

        expect( proveUnwindPrefilter( unwind, match ) ).toBeNull();

        const matchSubKey =
        {
            $match:
            {
                'items.status': 'active',
                'itemIndex.sub': 1
            }
        };

        expect( proveUnwindPrefilter( unwind, matchSubKey ) ).toBeNull();
    } );

    it( 'permits includeArrayIndex when match does not reference it', () =>
    {
        const unwind =
        {
            $unwind:
            {
                path: '$items',
                includeArrayIndex: 'itemIndex'
            }
        };
        const match =
        {
            $match:
            {
                'items.status': 'active'
            }
        };

        const proof = proveUnwindPrefilter( unwind, match );
        expect( proof ).not.toBeNull();
        expect( proof?.prefilterStage ).toEqual({
            $match: {
                $or: [
                    { 'items.status': 'active' },
                    { items: { $elemMatch: { $type: 'array' } } }
                ]
            }
        });
    } );

    it( 'rejects when match has no conditions on unwound array', () =>
    {
        const unwind = { $unwind: '$items' };
        const match = { $match: { status: 'active', score: 100 } };

        expect( proveUnwindPrefilter( unwind, match ) ).toBeNull();
    } );

    it( 'rejects when match contains non-deterministic expressions', () =>
    {
        const unwind = { $unwind: '$items' };
        const match =
        {
            $match:
            {
                'items.val': { $expr: { $gt: [ { $rand: {} }, 0.5 ] } }
            }
        };

        expect( proveUnwindPrefilter( unwind, match ) ).toBeNull();
    } );

    it( 'handles null prototype and custom class objects gracefully', () =>
    {
        const nullProtoMatch = Object.create( null );
        nullProtoMatch[ 'orders.total' ] = { $gt: 50 };

        const proof = proveUnwindPrefilter( { $unwind: '$orders' }, { $match: nullProtoMatch } );
        expect( proof ).not.toBeNull();

        class CustomClass {}
        expect( proveUnwindPrefilter( new CustomClass(), { $match: {} } ) ).toBeNull();
        expect( proveUnwindPrefilter( { $unwind: '$orders' }, new CustomClass() ) ).toBeNull();
    } );

    it( 'rejects invalid unwind or match stages', () =>
    {
        expect( proveUnwindPrefilter( null, { $match: {} } ) ).toBeNull();
        expect( proveUnwindPrefilter( { $unwind: '$a' }, null ) ).toBeNull();
        expect( proveUnwindPrefilter( 'not-object', { $match: {} } ) ).toBeNull();
        expect( proveUnwindPrefilter( { $unwind: 123 }, { $match: {} } ) ).toBeNull();
        expect( proveUnwindPrefilter( { $unwind: 'invalid-path-no-dollar' }, { $match: {} } ) ).toBeNull();
        expect( proveUnwindPrefilter( { $unwind: '$' }, { $match: {} } ) ).toBeNull();
        expect( proveUnwindPrefilter( { $unwind: { path: 123 } }, { $match: {} } ) ).toBeNull();
        expect( proveUnwindPrefilter( { $unwind: { path: 'no-dollar' } }, { $match: {} } ) ).toBeNull();
        expect( proveUnwindPrefilter( { $unwind: { path: '$' } }, { $match: {} } ) ).toBeNull();
        expect( proveUnwindPrefilter( { $unwind: '$a', extra: 1 }, { $match: {} } ) ).toBeNull();
        expect( proveUnwindPrefilter( { $unwind: '$a' }, { $match: 'not-object' } ) ).toBeNull();
        expect( proveUnwindPrefilter( { $unwind: '$a' }, { notMatch: {} } ) ).toBeNull();
        expect( proveUnwindPrefilter( { $unwind: '$a' }, { $match: {}, extra: 1 } ) ).toBeNull();
    } );

    it( 'handles qualifying and non-qualifying predicates under KTD12', () =>
    {
        const unwind = { $unwind: '$items' };

        // Qualifying scalars
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': 'bob' } } ) ).not.toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.count': 10 } } ) ).not.toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.active': true } } ) ).not.toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.big': 100n } } ) ).not.toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.date': new Date( '2026-01-01' ) } } ) ).not.toBeNull();

        // Qualifying operators
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.a': { $eq: 'yes' } } } ) ).not.toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.b': { $gt: 5, $lte: 10 } } } ) ).not.toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.c': { $lt: 20, $gte: 1 } } } ) ).not.toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.d': { $in: [ 'x', 'y' ] } } } ) ).not.toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.e': { $exists: true } } } ) ).not.toBeNull();

        // Non-qualifying operators and values (must skip / return null)
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': null } } ) ).toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': undefined } } ) ).toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': /abc/ } } ) ).toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': [ 1, 2 ] } } ) ).toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': {} } } ) ).toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': { $ne: 'abc' } } } ) ).toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': { $nin: [ 'abc' ] } } } ) ).toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': { $not: { $eq: 'abc' } } } } ) ).toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': { $exists: false } } } ) ).toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': { $in: [ 1, null ] } } } ) ).toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': { $in: [] } } } ) ).toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': { $in: 'not-array' } } } ) ).toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': { $eq: null } } } ) ).toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': { $gt: null } } } ) ).toBeNull();
        expect( proveUnwindPrefilter( unwind, { $match: { 'items.name': { $unknownOp: 1 } } } ) ).toBeNull();
    } );

    it( 'respects strictErrors context flag', () =>
    {
        const unwind = { $unwind: '$items' };
        const safeMatch = { $match: { 'items.total': 100 } };
        const errorMatch =
        {
            $match:
            {
                'items.total': 100,
                errField: { $expr: { $toInt: '$x' } }
            }
        };

        const strictCtx: GuaranteeContext = { strictFieldOrder: false, strictErrors: true };
        const defaultCtx: GuaranteeContext = { strictFieldOrder: false, strictErrors: false };

        expect( proveUnwindPrefilter( unwind, safeMatch, defaultCtx ) ).not.toBeNull();
        expect( proveUnwindPrefilter( unwind, safeMatch, strictCtx ) ).not.toBeNull();

        // Malformed or error-prone stages rejected under strictErrors
        expect( proveUnwindPrefilter( unwind, errorMatch, strictCtx ) ).toBeNull();
        expect( proveUnwindPrefilter( { $unwind: '$$nested' }, safeMatch, strictCtx ) ).toBeNull();
    } );
} );

describe( 'UnwindPrefilterPass', () =>
{
    const pass = new UnwindPrefilterPass();

    it( 'has expected pass name and stageTypes', () =>
    {
        expect( pass.name ).toBe( 'unwind-prefilter' );
        expect( pass.stageTypes ).toEqual( [ '$unwind' ] );
    } );

    it( 'inserts synthesized superset prefilter ahead of $unwind and keeps downstream $match intact', () =>
    {
        const pipeline =
        [
            { $match: { orgId: '123' } },
            { $unwind: '$items' },
            { $match: { 'items.available': true } }
        ];

        const result = pass.execute( pipeline );
        expect( result ).toEqual([
            { $match: { orgId: '123' } },
            {
                $match: {
                    $or: [
                        { 'items.available': true },
                        { items: { $elemMatch: { $type: 'array' } } }
                    ]
                }
            },
            { $unwind: '$items' },
            { $match: { 'items.available': true } }
        ]);

        const firstStageUnwindPipeline =
        [
            { $unwind: '$items' },
            { $match: { 'items.available': true } }
        ];
        expect( pass.execute( firstStageUnwindPipeline ) ).toEqual([
            {
                $match: {
                    $or: [
                        { 'items.available': true },
                        { items: { $elemMatch: { $type: 'array' } } }
                    ]
                }
            },
            { $unwind: '$items' },
            { $match: { 'items.available': true } }
        ]);
    } );

    it( 'is idempotent and does not duplicate prefilter if already present', () =>
    {
        const prefilter =
        {
            $match: {
                $or: [
                    { 'items.available': true },
                    { items: { $elemMatch: { $type: 'array' } } }
                ]
            }
        };

        const pipeline =
        [
            { $match: { orgId: '123' } },
            prefilter,
            { $unwind: '$items' },
            { $match: { 'items.available': true } }
        ];

        const result = pass.execute( pipeline );
        expect( result ).toEqual( pipeline );

        const mergedPipeline =
        [
            {
                $match: {
                    $and: [
                        { orgId: '123' },
                        prefilter.$match
                    ]
                }
            },
            { $unwind: '$items' },
            { $match: { 'items.available': true } }
        ];
        expect( pass.execute( mergedPipeline ) ).toEqual( mergedPipeline );

        const nonMatchingAndPipeline =
        [
            {
                $match: {
                    $and: [
                        { orgId: '123' },
                        { items: { other: 1 } }
                    ]
                }
            },
            { $unwind: '$items' },
            { $match: { 'items.available': true } }
        ];
        const nonMatchingResult = pass.execute( nonMatchingAndPipeline );
        expect( nonMatchingResult.length ).toBe( 4 );

        const nonObjectMatchPipeline =
        [
            { $match: null as any },
            { $unwind: '$items' },
            { $match: { 'items.available': true } }
        ];
        expect( pass.execute( nonObjectMatchPipeline ).length ).toBe( 4 );
    } );

    it( 'skips synthesis when preceded by a pipeline lookup for the same path', () =>
    {
        const pipelineWithLookup =
        [
            {
                $lookup: {
                    from: 'items',
                    as: 'items',
                    pipeline: [ { $match: { active: true } } ]
                }
            },
            { $unwind: '$items' },
            { $match: { 'items.available': true } }
        ];

        expect( pass.execute( pipelineWithLookup ) ).toEqual( pipelineWithLookup );

        // Different path lookup does not suppress prefilter
        const pipelineWithOtherLookup =
        [
            {
                $lookup: {
                    from: 'other',
                    as: 'other',
                    pipeline: [ { $match: { active: true } } ]
                }
            },
            { $unwind: '$items' },
            { $match: { 'items.available': true } }
        ];

        const res = pass.execute( pipelineWithOtherLookup );
        expect( res.length ).toBe( 4 );

        // Non-pipeline lookup does not suppress
        const pipelineWithSimpleLookup =
        [
            {
                $lookup: {
                    from: 'items',
                    localField: 'x',
                    foreignField: 'y',
                    as: 'items'
                }
            },
            { $unwind: '$items' },
            { $match: { 'items.available': true } }
        ];
        expect( pass.execute( pipelineWithSimpleLookup ).length ).toBe( 4 );
    } );

    it( 'leaves pipelines without applicable unwind unchanged', () =>
    {
        const pipeline =
        [
            { $unwind: { path: '$items', preserveNullAndEmptyArrays: true } },
            { $match: { 'items.available': true } }
        ];

        const result = pass.execute( pipeline );
        expect( result ).toEqual( pipeline );
    } );
} );

describe( 'optimizePipeline execution parity for unwind prefilter', () =>
{
    const ordersDataset =
    [
        {
            _id: 1,
            orderId: 'ORD-1',
            customer: 'Alice',
            items: [
                { sku: 'A', price: 60, inStock: true },
                { sku: 'B', price: 20, inStock: false }
            ]
        },
        {
            _id: 2,
            orderId: 'ORD-2',
            customer: 'Bob',
            items: [
                { sku: 'C', price: 15, inStock: true }
            ]
        },
        {
            _id: 3,
            orderId: 'ORD-3',
            customer: 'Charlie',
            items: []
        },
        {
            _id: 4,
            orderId: 'ORD-4',
            customer: 'Diana'
        }
    ];

    it( 'synthesizes superset prefilter and preserves execution parity on array unwind', () =>
    {
        const pipeline =
        [
            { $unwind: '$items' },
            { $match: { 'items.price': { $gt: 50 } } }
        ];

        const optimized = optimizePipeline( pipeline );
        expect( optimized[0] ).toEqual({
            $match: {
                $or: [
                    { 'items.price': { $gt: 50 } },
                    { items: { $elemMatch: { $type: 'array' } } }
                ]
            }
        });

        const originalResults = runMockPipeline( ordersDataset, pipeline );
        const optimizedResults = runMockPipeline( ordersDataset, optimized );

        expect( optimizedResults ).toEqual( originalResults );
        expect( optimizedResults ).toEqual([
            {
                _id: 1,
                orderId: 'ORD-1',
                customer: 'Alice',
                items: { sku: 'A', price: 60, inStock: true }
            }
        ]);
    } );

    it( 'synthesizes compound conditions with status and price and preserves execution parity', () =>
    {
        const pipeline =
        [
            { $unwind: '$items' },
            {
                $match: {
                    'items.inStock': true,
                    'items.price': { $gte: 20 }
                }
            }
        ];

        const optimized = optimizePipeline( pipeline );
        expect( optimized[0] ).toEqual({
            $match: {
                $or: [
                    {
                        'items.inStock': true,
                        'items.price': { $gte: 20 }
                    },
                    { items: { $elemMatch: { $type: 'array' } } }
                ]
            }
        });

        const originalResults = runMockPipeline( ordersDataset, pipeline );
        const optimizedResults = runMockPipeline( ordersDataset, optimized );

        expect( optimizedResults ).toEqual( originalResults );
    } );

    it( 'handles pipeline with preceding match, sort, and project while preserving parity', () =>
    {
        const pipeline =
        [
            { $match: { customer: { $ne: 'Charlie' } } },
            { $unwind: '$items' },
            { $match: { 'items.price': { $gt: 10 } } },
            {
                $project: {
                    orderId: 1,
                    sku: '$items.sku',
                    price: '$items.price'
                }
            },
            { $sort: { price: -1 } }
        ];

        const optimized = optimizePipeline( pipeline );
        const originalResults = runMockPipeline( ordersDataset, pipeline );
        const optimizedResults = runMockPipeline( ordersDataset, optimized );

        expect( optimizedResults ).toEqual( originalResults );
        expect( optimizedResults.length ).toBe( 3 );
        expect( optimizedResults[0].sku ).toBe( 'A' );
    } );

    it( 'preserves execution parity on AE3 object unwind', () =>
    {
        const dataset =
        [
            { _id: 1, items: { score: 5 } },
            { _id: 2, items: [ { score: 5 } ] },
            { _id: 3, items: [ { score: 10 } ] }
        ];

        const pipeline =
        [
            { $unwind: '$items' },
            { $match: { 'items.score': 5 } },
            { $sort: { _id: 1 } }
        ];

        const optimized = optimizePipeline( pipeline );
        const orig = runMockPipeline( dataset, pipeline );
        const opt = runMockPipeline( dataset, optimized );

        expect( opt ).toEqual( orig );
        expect( opt.length ).toBe( 2 );
        expect( opt.map( ( d: any ) => d._id ) ).toEqual( [ 1, 2 ] );
    } );

    it( 'skips prefilter for AE4 missing field match and preserves parity', () =>
    {
        const dataset =
        [
            { _id: 1, items: [ 1, 2 ] },
            { _id: 2, items: [ { score: 10 } ] }
        ];

        const pipeline =
        [
            { $unwind: '$items' },
            { $match: { 'items.score': { $exists: false } } },
            { $sort: { _id: 1 } }
        ];

        const optimized = optimizePipeline( pipeline );
        expect( optimized ).toEqual( pipeline );

        const orig = runMockPipeline( dataset, pipeline );
        const opt = runMockPipeline( dataset, optimized );

        expect( opt ).toEqual( orig );
        expect( opt.length ).toBe( 2 );
    } );

    it( 'allows nested arrays to survive through escape branch', () =>
    {
        const dataset =
        [
            { _id: 1, items: [ [ { score: 5 } ] ] },
            { _id: 2, items: [ 1, 2 ] }
        ];

        const pipeline =
        [
            { $unwind: '$items' },
            { $match: { 'items.score': 5 } }
        ];

        const optimized = optimizePipeline( pipeline );
        expect( optimized[0] ).toEqual({
            $match: {
                $or: [
                    { 'items.score': 5 },
                    { items: { $elemMatch: { $type: 'array' } } }
                ]
            }
        });

        // The nested array document matches prefilter because of escape branch
        const prefilteredDocs = runMockPipeline( dataset, [ optimized[0] ] );
        expect( prefilteredDocs.map( ( d: any ) => d._id ) ).toEqual( [ 1 ] );
    } );

    it( 'returns nothing for array of scalars with positive match', () =>
    {
        const dataset =
        [
            { _id: 1, items: [ 1, 2 ] },
            { _id: 2, items: [ 3, 4 ] }
        ];

        const pipeline =
        [
            { $unwind: '$items' },
            { $match: { 'items.score': 5 } }
        ];

        const optimized = optimizePipeline( pipeline );
        const orig = runMockPipeline( dataset, pipeline );
        const opt = runMockPipeline( dataset, optimized );

        expect( opt ).toEqual( orig );
        expect( opt.length ).toBe( 0 );
    } );
} );
