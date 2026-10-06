import { describe, expect, it } from 'vitest';
import {
    AddFieldPushdownPass,
} from '../src/passes/add-field-pushdown.js';
import {
    arePathsDisjoint,
    canPushFieldAcrossStage,
    collectDownstreamDemandedKeys,
    proveAddFieldPushdown,
} from '../src/passes/add-field-pushdown-proofs.js';
import { optimizePipeline } from '../src/index.js';

describe('AddFieldPushdownPass', () =>
{
    it('pushes an entire $addFields stage before a $lookup when all fields are pushable and demanded', () =>
    {
        const pipeline = [
            {
                $lookup: {
                    from: 'foreign',
                    localField: 'tenant',
                    foreignField: 'tenant',
                    as: 'items',
                },
            },
            {
                $addFields: {
                    computedVal: { $add: [ '$score', 1 ] },
                },
            },
            {
                $sort: { computedVal: 1 },
            },
            {
                $limit: 10,
            },
        ];

        const pass = new AddFieldPushdownPass();
        const optimized = pass.execute( pipeline );

        expect( optimized[ 0 ] ).toEqual({
            $addFields: {
                computedVal: { $add: [ '$score', 1 ] },
            },
        });
        expect( optimized[ 1 ] ).toHaveProperty( '$lookup' );
    });

    it('splits demanded fields from multi-field $addFields and pushes only the demanded field across lookups', () =>
    {
        const pipeline = [
            {
                $lookup: {
                    from: 'briefings',
                    localField: '_id',
                    foreignField: 'jobId',
                    as: 'briefings',
                },
            },
            {
                $lookup: {
                    from: 'placements',
                    localField: 'appId',
                    foreignField: '_id',
                    as: 'latestPlacement',
                },
            },
            {
                $addFields: {
                    furthestStage: { $concat: [ '$stage', '-active' ] },
                    heavyCalculation: { $add: [ '$val', 100 ] },
                },
            },
            {
                $sort: { furthestStage: 1, _id: -1 },
            },
            {
                $limit: 10,
            },
        ];

        const pass = new AddFieldPushdownPass();
        const optimized = pass.execute( pipeline );

        expect( optimized[ 0 ] ).toEqual({
            $addFields: {
                furthestStage: { $concat: [ '$stage', '-active' ] },
            },
        });
        expect( optimized[ 1 ] ).toHaveProperty( '$lookup' );
        expect( optimized[ 2 ] ).toHaveProperty( '$lookup' );
        expect( optimized[ 3 ] ).toEqual({
            $addFields: {
                heavyCalculation: { $add: [ '$val', 100 ] },
            },
        });
    });

    it('supports $set stages identically to $addFields', () =>
    {
        const pipeline = [
            {
                $lookup: {
                    from: 'foreign',
                    localField: 'foreignId',
                    foreignField: '_id',
                    as: 'foreignDocs',
                },
            },
            {
                $set: {
                    computed: { $multiply: [ '$amount', 2 ] },
                },
            },
            {
                $sort: { computed: -1 },
            },
        ];

        const pass = new AddFieldPushdownPass();
        const optimized = pass.execute( pipeline );

        expect( optimized[ 0 ] ).toEqual({
            $set: {
                computed: { $multiply: [ '$amount', 2 ] },
            },
        });
        expect( optimized[ 1 ] ).toHaveProperty( '$lookup' );
    });

    it('composes with top-k-pushdown to hoist $sort and $limit before lookups', () =>
    {
        const pipeline = [
            {
                $match: { active: true },
            },
            {
                $lookup: {
                    from: 'foreign',
                    localField: 'fId',
                    foreignField: '_id',
                    as: 'foreignList',
                },
            },
            {
                $addFields: {
                    rank: { $add: [ '$score', 5 ] },
                    unusedHeavy: { $multiply: [ '$count', 10 ] },
                },
            },
            {
                $sort: { rank: -1, _id: 1 },
            },
            {
                $limit: 5,
            },
        ];

        const optimized = optimizePipeline( pipeline );

        expect( optimized[ 0 ] ).toHaveProperty( '$match' );
        expect( optimized[ 1 ] ).toEqual({
            $addFields: {
                rank: { $add: [ '$score', 5 ] },
            },
        });
        expect( optimized[ 2 ] ).toEqual({
            $sort: { rank: -1, _id: 1 },
        });
        expect( optimized[ 3 ] ).toEqual({
            $limit: 5,
        });
        expect( optimized[ 4 ] ).toHaveProperty( '$lookup' );
        expect( optimized[ 5 ] ).toEqual({
            $addFields: {
                unusedHeavy: { $multiply: [ '$count', 10 ] },
            },
        });
    });

    it('does not push when field expression reads from preceding stage write alias', () =>
    {
        const pipeline = [
            {
                $lookup: {
                    from: 'foreign',
                    localField: 'fId',
                    foreignField: '_id',
                    as: 'items',
                },
            },
            {
                $addFields: {
                    itemCount: { $size: '$items' },
                },
            },
            {
                $sort: { itemCount: -1 },
            },
        ];

        const pass = new AddFieldPushdownPass();
        const result = pass.execute( pipeline );

        expect( result ).toEqual( pipeline );
    });

    it('does not push across cardinality altering stages like $match or $unwind', () =>
    {
        const pipeline = [
            {
                $match: { status: 'open' },
            },
            {
                $addFields: {
                    computed: { $add: [ '$score', 1 ] },
                },
            },
            {
                $sort: { computed: 1 },
            },
        ];

        const pass = new AddFieldPushdownPass();
        const result = pass.execute( pipeline );

        expect( result ).toEqual( pipeline );
    });

    it('returns null proof for out of bounds, invalid stage shapes, and empty keys', () =>
    {
        expect( proveAddFieldPushdown( [], 0 ) ).toBeNull();
        expect( proveAddFieldPushdown( [ { $match: {} } ], 2 ) ).toBeNull();
        expect( proveAddFieldPushdown( [ { $match: {} }, { $project: { a: 1 } } ], 1 ) ).toBeNull();
        expect( proveAddFieldPushdown( [ { $match: {} }, { $addFields: null } ], 1 ) ).toBeNull();
        expect( proveAddFieldPushdown( [ { $match: {} }, { $addFields: {} } ], 1 ) ).toBeNull();
    });

    it('handles canPushFieldAcrossStage error and edge cases thoroughly', () =>
    {
        expect( canPushFieldAcrossStage( 'a', 1, null ) ).toBe( false );
        expect( canPushFieldAcrossStage( 'a', 1, { $unknownStage: true } ) ).toBe( false );
        expect( canPushFieldAcrossStage( 'a', 1, { $match: { x: 1 } } ) ).toBe( false );
        expect( canPushFieldAcrossStage( 'a', 1, { $sort: { x: 1 } } ) ).toBe( false );
        expect( canPushFieldAcrossStage( 'a', 1, { $lookup: 123 } ) ).toBe( false );

        // Preceding lookup reading $$ROOT
        expect( canPushFieldAcrossStage(
            'furthestStage',
            { $concat: [ '$a', '$b' ] },
            {
                $lookup: {
                    from: 'f',
                    let: { doc: '$$ROOT' },
                    pipeline: [],
                    as: 'items',
                },
            }
        )).toBe( false );

        // Preceding lookup with unknown dependency
        expect( canPushFieldAcrossStage(
            'furthestStage',
            { $concat: [ '$a', '$b' ] },
            {
                $lookup: {
                    from: 'f',
                    let: { doc: '$$UNSUPPORTED_SPECIAL_VAR' },
                    pipeline: [],
                    as: 'items',
                },
            }
        )).toBe( false );

        // Pushed expression reading $$ROOT
        expect( canPushFieldAcrossStage(
            'selfDoc',
            {
                $function: {
                    body: 'function(doc){ return doc; }',
                    args: [ '$$ROOT' ],
                    lang: 'js',
                },
            },
            {
                $lookup: {
                    from: 'foreign',
                    localField: 'f',
                    foreignField: 'f',
                    as: 'foreignItems',
                },
            }
        )).toBe( false );

        // Pushed field name conflicts with preceding stage read or write
        expect( canPushFieldAcrossStage(
            'foreignItems',
            10,
            {
                $lookup: {
                    from: 'foreign',
                    localField: 'f',
                    foreignField: 'f',
                    as: 'foreignItems',
                },
            }
        )).toBe( false );
    });

    it('tests arePathsDisjoint utility', () =>
    {
        expect( arePathsDisjoint( [ 'a.b' ], [ 'c.d' ] ) ).toBe( true );
        expect( arePathsDisjoint( [ 'a.b' ], [ 'a' ] ) ).toBe( false );
    });

    it('handles collectDownstreamDemandedKeys branches', () =>
    {
        const pipeline = [
            { $addFields: { x: 1 } },
            null,
            { $sort: { s1: 1, s2: -1 } },
            { $sort: 'not-object' },
            { $match: { m1: 'val' } },
            { $match: 123 },
            { $limit: 10 },
        ];

        const keys = collectDownstreamDemandedKeys( pipeline, 0 );
        expect( keys.has( 's1' ) ).toBe( true );
        expect( keys.has( 's2' ) ).toBe( true );
        expect( keys.has( 'm1' ) ).toBe( true );
    });

    it('returns null proof when demanded keys do not overlap with stage keys', () =>
    {
        const pipeline = [
            {
                $lookup: {
                    from: 'foreign',
                    localField: 'f',
                    foreignField: 'f',
                    as: 'items',
                },
            },
            {
                $addFields: {
                    unrelated: 123,
                },
            },
            {
                $sort: { otherKey: 1 },
            },
        ];

        expect( proveAddFieldPushdown( pipeline, 1 ) ).toBeNull();
    });

    it('handles pushable keys that cannot reach furthestTarget', () =>
    {
        // Stage 0: $lookup writing 'aliasA'
        // Stage 1: $lookup writing 'aliasB'
        // Stage 2: $addFields with keyA reading 'aliasA' (can cross stage 1 only) and keyB reading local (can cross both)
        const pipeline = [
            {
                $lookup: {
                    from: 'fA',
                    localField: 'f',
                    foreignField: 'f',
                    as: 'aliasA',
                },
            },
            {
                $lookup: {
                    from: 'fB',
                    localField: 'f',
                    foreignField: 'f',
                    as: 'aliasB',
                },
            },
            {
                $addFields: {
                    keyA: '$aliasA',
                    keyB: '$local',
                },
            },
            {
                $sort: { keyA: 1, keyB: 1 },
            },
        ];

        const proof = proveAddFieldPushdown( pipeline, 2 );
        expect( proof ).not.toBeNull();
        expect( proof!.targetIndex ).toBe( 0 );
        expect( Object.keys( proof!.pushedFields ) ).toEqual([ 'keyB' ]);
        expect( Object.keys( proof!.remainingFields! ) ).toEqual([ 'keyA' ]);
    });

    it('handles pushable keys evaluated where later key reaches a less distant target', () =>
    {
        const pipeline = [
            {
                $lookup: {
                    from: 'fA',
                    localField: 'f',
                    foreignField: 'f',
                    as: 'aliasA',
                },
            },
            {
                $lookup: {
                    from: 'fB',
                    localField: 'f',
                    foreignField: 'f',
                    as: 'aliasB',
                },
            },
            {
                $addFields: {
                    keyB: '$local',
                    keyA: '$aliasA',
                },
            },
            {
                $sort: { keyA: 1, keyB: 1 },
            },
        ];

        const proof = proveAddFieldPushdown( pipeline, 2 );
        expect( proof ).not.toBeNull();
        expect( proof!.targetIndex ).toBe( 0 );
        expect( Object.keys( proof!.pushedFields ) ).toEqual([ 'keyB' ]);
        expect( Object.keys( proof!.remainingFields! ) ).toEqual([ 'keyA' ]);
    });

    it('returns null when no candidate keys can push anywhere', () =>
    {
        const pipeline = [
            {
                $lookup: {
                    from: 'fA',
                    localField: 'f',
                    foreignField: 'f',
                    as: 'aliasA',
                },
            },
            {
                $addFields: {
                    keyA: '$aliasA',
                },
            },
            {
                $sort: { keyA: 1 },
            },
        ];

        expect( proveAddFieldPushdown( pipeline, 1 ) ).toBeNull();
    });
});
