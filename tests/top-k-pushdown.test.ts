import { describe, expect, it } from 'vitest';
import { TopKPushdownPass } from '../src/passes/top-k-pushdown.js';
import
{
    arePathsDisjoint,
    canTopKPushAcrossStage,
    parseSafeSortKeys,
    parseTopKFollower,
    proveTopKPushdown,
}
from '../src/passes/top-k-proofs.js';
import { optimizePipeline } from './helpers/pre-gate-optimizer.js';
import { runMockPipeline } from './helpers/mock-engine.js';

describe( 'top-k-proofs unit and branch analysis', () =>
{
    it( 'tests arePathsDisjoint with disjoint and non-disjoint paths', () =>
    {
        expect( arePathsDisjoint( [ 'a.b' ], [ 'c.d' ] )).toBe( true );
        expect( arePathsDisjoint( [ 'a.b' ], [ 'a.b' ] )).toBe( false );
        expect( arePathsDisjoint( [ 'a' ], [ 'a.b' ] )).toBe( false );
        expect( arePathsDisjoint( [ 'a.b' ], [ 'a' ] )).toBe( false );
    });

    it( 'returns null in parseSafeSortKeys for invalid sort stages', () =>
    {
        expect( parseSafeSortKeys( null )).toBeNull();
        expect( parseSafeSortKeys( [] )).toBeNull();
        expect( parseSafeSortKeys( { $match: { a: 1 } } )).toBeNull();
        expect( parseSafeSortKeys( { $sort: 'invalid' } )).toBeNull();
        expect( parseSafeSortKeys( { $sort: {} } )).toBeNull();
        expect( parseSafeSortKeys( { $sort: { a: 2 } } )).toBeNull();
        expect( parseSafeSortKeys( { $sort: { a: -2 } } )).toBeNull();
        expect( parseSafeSortKeys( { $sort: { a: 'asc' } } )).toBeNull();
    });

    it( 'returns keys in parseSafeSortKeys for valid sort specifications', () =>
    {
        expect( parseSafeSortKeys( { $sort: { score: -1, _id: 1 } } )).toEqual([ 'score', '_id' ]);
    });

    it( 'parses top-k followers correctly', () =>
    {
        // Out of bounds
        expect( parseTopKFollower( [ { $sort: { a: 1 } } ], 0 )).toBeNull();

        // Invalid follower shape
        expect( parseTopKFollower( [ { $sort: { a: 1 } }, null ], 0 )).toBeNull();
        expect( parseTopKFollower( [ { $sort: { a: 1 } }, { $match: {} } ], 0 )).toBeNull();

        // Limit follower
        expect( parseTopKFollower( [ { $sort: { a: 1 } }, { $limit: 10 } ], 0 )).toEqual({ sliceLength: 2 });
        expect( parseTopKFollower( [ { $sort: { a: 1 } }, { $limit: -5 } ], 0 )).toBeNull();
        expect( parseTopKFollower( [ { $sort: { a: 1 } }, { $limit: 0 } ], 0 )).toBeNull();
        expect( parseTopKFollower( [ { $sort: { a: 1 } }, { $limit: 1.5 } ], 0 )).toBeNull();
        expect( parseTopKFollower( [ { $sort: { a: 1 } }, { $limit: '10' } ], 0 )).toBeNull();

        // Skip + Limit follower
        expect( parseTopKFollower( [
            { $sort: { a: 1 } },
            { $skip: 5 },
            { $limit: 10 },
        ], 0 )).toEqual({ sliceLength: 3 });

        // Skip without next stage
        expect( parseTopKFollower( [ { $sort: { a: 1 } }, { $skip: 5 } ], 0 )).toBeNull();

        // Skip with invalid skip value
        expect( parseTopKFollower( [
            { $sort: { a: 1 } },
            { $skip: -1 },
            { $limit: 10 },
        ], 0 )).toBeNull();
        expect( parseTopKFollower( [
            { $sort: { a: 1 } },
            { $skip: 1.5 },
            { $limit: 10 },
        ], 0 )).toBeNull();
        expect( parseTopKFollower( [
            { $sort: { a: 1 } },
            { $skip: '5' },
            { $limit: 10 },
        ], 0 )).toBeNull();

        // Skip followed by non-limit stage
        expect( parseTopKFollower( [
            { $sort: { a: 1 } },
            { $skip: 5 },
            { $match: {} },
        ], 0 )).toBeNull();
        expect( parseTopKFollower( [
            { $sort: { a: 1 } },
            { $skip: 5 },
            null,
        ], 0 )).toBeNull();

        // Skip followed by invalid limit
        expect( parseTopKFollower( [
            { $sort: { a: 1 } },
            { $skip: 5 },
            { $limit: -10 },
        ], 0 )).toBeNull();
    });

    it( 'checks canTopKPushAcrossStage for various stage types', () =>
    {
        const sortKeys = [ 'score', '_id' ];

        // Non-object or non-passive operator
        expect( canTopKPushAcrossStage( null, sortKeys )).toBe( false );
        expect( canTopKPushAcrossStage( { $match: { a: 1 } }, sortKeys )).toBe( false );
        expect( canTopKPushAcrossStage( { $unwind: '$items' }, sortKeys )).toBe( false );
        expect( canTopKPushAcrossStage( { $group: { _id: '$cat' } }, sortKeys )).toBe( false );

        // Malformed stage
        expect( canTopKPushAcrossStage( { $lookup: 'invalid' }, sortKeys )).toBe( false );

        // Passive stages disjoint from sort keys
        expect( canTopKPushAcrossStage(
            { $lookup: { from: 'items', localField: 'sku', foreignField: 'sku', as: 'items' } },
            sortKeys
        )).toBe( true );

        expect( canTopKPushAcrossStage(
            { $addFields: { computed: 1 } },
            sortKeys
        )).toBe( true );

        expect( canTopKPushAcrossStage(
            { $set: { label: 'active' } },
            sortKeys
        )).toBe( true );

        expect( canTopKPushAcrossStage(
            { $unset: 'unrelatedField' },
            sortKeys
        )).toBe( true );

        // Stage writes/modifies sort key
        expect( canTopKPushAcrossStage(
            { $addFields: { score: 100 } },
            sortKeys
        )).toBe( false );

        expect( canTopKPushAcrossStage(
            { $set: { 'score.sub': 100 } },
            sortKeys
        )).toBe( false );

        // Stage removes sort key
        expect( canTopKPushAcrossStage(
            { $unset: 'score' },
            sortKeys
        )).toBe( false );

        // Project stage is not in TOP_K_PASSIVE_OPERATORS (keeps project in place)
        expect( canTopKPushAcrossStage(
            { $project: { score: 1, _id: 1, extra: 1 } },
            sortKeys
        )).toBe( false );
    });

    it( 'handles proveTopKPushdown edge cases and movements', () =>
    {
        // Out of bounds sortIndex
        expect( proveTopKPushdown( [], 0 )).toBeNull();
        expect( proveTopKPushdown( [ { $sort: { a: 1 } }, { $limit: 10 } ], 0 )).toBeNull();
        expect( proveTopKPushdown( [ { $sort: { a: 1 } }, { $limit: 10 } ], 2 )).toBeNull();

        // Invalid sort stage
        expect( proveTopKPushdown( [ { $match: {} }, { $limit: 10 } ], 1 )).toBeNull();

        // Invalid follower
        expect( proveTopKPushdown( [ { $match: {} }, { $sort: { a: 1 } } ], 1 )).toBeNull();

        // Preceding stage cannot be crossed
        expect( proveTopKPushdown( [
            { $match: { a: 1 } },
            { $sort: { score: 1 } },
            { $limit: 10 },
        ], 1 )).toBeNull();

        // Successful pushdown past addFields and lookup
        const pipeline = [
            { $match: { active: true } },
            { $lookup: { from: 'items', localField: 'sku', foreignField: 'sku', as: 'items' } },
            { $addFields: { label: 'sale' } },
            { $sort: { score: -1, _id: 1 } },
            { $limit: 10 },
        ];

        expect( proveTopKPushdown( pipeline, 3 )).toEqual({
            sortIndex: 3,
            targetIndex: 1,
            sliceLength: 2,
        });

        // Pushdown with skip + limit
        const skipPipeline = [
            { $match: { active: true } },
            { $addFields: { label: 'sale' } },
            { $sort: { score: -1, _id: 1 } },
            { $skip: 5 },
            { $limit: 10 },
        ];

        expect( proveTopKPushdown( skipPipeline, 2 )).toEqual({
            sortIndex: 2,
            targetIndex: 1,
            sliceLength: 3,
        });
    });
});

describe( 'TopKPushdownPass execution and mock verification', () =>
{
    it( 'returns unchanged pipeline when no top-k block can be pushed', () =>
    {
        const pass = new TopKPushdownPass();
        const pipeline = [ { $match: { a: 1 } }, { $sort: { score: 1 } }, { $limit: 10 } ];
        expect( pass.execute( pipeline )).toEqual( pipeline );
    });

    it( 'pushes sort and limit before lookup and addFields', () =>
    {
        const pass = new TopKPushdownPass();
        const pipeline = [
            { $match: { deleted: false } },
            { $lookup: { from: 'briefings', localField: '_id', foreignField: 'jobId', as: 'briefings' } },
            { $addFields: { status: 'open' } },
            { $sort: { 'events.created': -1, _id: -1 } },
            { $limit: 100 },
        ];

        const expected = [
            { $match: { deleted: false } },
            { $sort: { 'events.created': -1, _id: -1 } },
            { $limit: 100 },
            { $lookup: { from: 'briefings', localField: '_id', foreignField: 'jobId', as: 'briefings' } },
            { $addFields: { status: 'open' } },
        ];

        expect( pass.execute( pipeline )).toEqual( expected );
    });

    it( 'pushes sort, skip, and limit as a slice', () =>
    {
        const pass = new TopKPushdownPass();
        const pipeline = [
            { $match: { active: true } },
            { $addFields: { tag: 1 } },
            { $sort: { rank: 1 } },
            { $skip: 10 },
            { $limit: 5 },
        ];

        const expected = [
            { $match: { active: true } },
            { $sort: { rank: 1 } },
            { $skip: 10 },
            { $limit: 5 },
            { $addFields: { tag: 1 } },
        ];

        expect( pass.execute( pipeline )).toEqual( expected );
    });

    it( 'verifies execution equivalence against mock engine', () =>
    {
        const docs = [
            { _id: 1, score: 20, sku: 'A' },
            { _id: 2, score: 50, sku: 'B' },
            { _id: 3, score: 10, sku: 'C' },
            { _id: 4, score: 40, sku: 'D' },
        ];

        const pipeline = [
            { $addFields: { tag: 'verified' } },
            { $sort: { score: -1, _id: 1 } },
            { $limit: 2 },
        ];

        const optimized = optimizePipeline( pipeline );

        expect( optimized ).toEqual([
            { $sort: { score: -1, _id: 1 } },
            { $limit: 2 },
            { $addFields: { tag: 'verified' } },
        ]);

        const originalOutput = runMockPipeline( docs, pipeline );
        const optimizedOutput = runMockPipeline( docs, optimized );

        expect( optimizedOutput ).toEqual( originalOutput );
    });
});
