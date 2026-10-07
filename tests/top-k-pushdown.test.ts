import { describe, expect, it } from 'vitest';
import { TopKPushdownPass } from '../src/passes/top-k-pushdown.js';
import
{
    arePathsDisjoint,
    canTopKPushAcrossStage,
    collectExpressionDependencies,
    isExpressionCompletelyDeterministic,
    parseSafeSortKeys,
    parseTopKFollower,
    proveHeuristicTopKPushdown,
    proveTopKPushdown,
}
from '../src/passes/top-k-proofs.js';
import { resolvePipelineGuarantees } from '../src/guarantees.js';
import { optimizePipeline as optimizePipelineProduction } from '../src/index.js';
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

    it( 'refuses to push across stage with errors under strictErrors mode (AE5)', () =>
    {
        const pipeline =
        [
            {
                $addFields:
                {
                    parsed: { $toInt: '$val' }
                }
            },
            {
                $sort: { rank: 1, _id: 1 }
            },
            {
                $limit: 1
            }
        ];

        const defaultContext = { strictFieldOrder: false, strictErrors: false };
        const strictErrorsContext = { strictFieldOrder: false, strictErrors: true };

        // canTopKPushAcrossStage
        expect( canTopKPushAcrossStage( pipeline[ 0 ], [ 'rank', '_id' ], defaultContext )).toBe( true );
        expect( canTopKPushAcrossStage( pipeline[ 0 ], [ 'rank', '_id' ], strictErrorsContext )).toBe( false );

        // proveTopKPushdown
        expect( proveTopKPushdown( pipeline, 1, defaultContext )).not.toBeNull();
        expect( proveTopKPushdown( pipeline, 1, strictErrorsContext )).toBeNull();

        // Pass execution
        const pass = new TopKPushdownPass();

        expect( pass.execute( pipeline, strictErrorsContext )).toEqual( pipeline );

        const pushed = pass.execute( pipeline, defaultContext );

        expect( pushed[ 0 ] ).toHaveProperty( '$sort' );
        expect( pushed[ 1 ] ).toHaveProperty( '$limit' );
        expect( pushed[ 2 ] ).toHaveProperty( '$addFields' );
    });

    it( 'enforces strictErrors when pipeline contains a write stage ($merge / $out) (AE6)', () =>
    {
        const mergePipeline =
        [
            {
                $addFields:
                {
                    parsed: { $toInt: '$val' }
                }
            },
            {
                $sort: { rank: 1, _id: 1 }
            },
            {
                $limit: 5
            },
            {
                $merge: { into: 'targetColl' }
            }
        ];

        const pass = new TopKPushdownPass();
        const writeContext = resolvePipelineGuarantees( mergePipeline, {} );

        expect( writeContext.strictErrors ).toBe( true );
        expect( pass.execute( mergePipeline, writeContext )).toEqual( mergePipeline );

        // Production optimizePipeline only runs active gated passes and preserves strictErrors on write pipelines
        expect( optimizePipelineProduction( mergePipeline )).toEqual( mergePipeline );
    });

    it( 'preserves sort semantics over documents with array sort keys and mixed values', () =>
    {
        const docs =
        [
            { _id: 1, tags: [ 5, 20 ], name: 'A' },
            { _id: 2, tags: [ 2, 50 ], name: 'B' },
            { _id: 3, tags: 10, name: 'C' },
            { _id: 4, tags: [ 1, 15 ], name: 'D' }
        ];

        const pipeline =
        [
            { $addFields: { note: 'active' } },
            { $sort: { tags: 1, _id: 1 } },
            { $limit: 2 }
        ];

        const pass = new TopKPushdownPass();
        const optimized = pass.execute( pipeline );

        expect( optimized[ 0 ] ).toHaveProperty( '$sort' );
        expect( optimized[ 1 ] ).toHaveProperty( '$limit' );
        expect( optimized[ 2 ] ).toHaveProperty( '$addFields' );

        const originalOutput = runMockPipeline( docs, pipeline );
        const optimizedOutput = runMockPipeline( docs, optimized );

        expect( optimizedOutput ).toEqual( originalOutput );
    });

    describe( 'heuristic shadow sort-pushdown proofs and pass execution', () =>
    {
        it( 'evaluates isExpressionCompletelyDeterministic across all branches', () =>
        {
            // Scalars and plain values
            expect( isExpressionCompletelyDeterministic( 42 )).toBe( true );
            expect( isExpressionCompletelyDeterministic( 'hello' )).toBe( true );
            expect( isExpressionCompletelyDeterministic( '$field' )).toBe( true );

            // Deterministic MQL
            expect( isExpressionCompletelyDeterministic( { $size: '$tags' } )).toBe( true );
            expect( isExpressionCompletelyDeterministic( { $add: [ '$a', '$b' ] } )).toBe( true );

            // Volatile and non-deterministic MQL
            expect( isExpressionCompletelyDeterministic( '$$NOW' )).toBe( false );
            expect( isExpressionCompletelyDeterministic( '$$CLUSTER_TIME' )).toBe( false );
            expect( isExpressionCompletelyDeterministic( { $rand: {} } )).toBe( false );
            expect( isExpressionCompletelyDeterministic( { $eq: [ '$a', '$$NOW' ] } )).toBe( false );
            expect( isExpressionCompletelyDeterministic( { $unknownOp: 1 } )).toBe( false );

            // strictErrors constraint
            expect( isExpressionCompletelyDeterministic( { $divide: [ '$a', '$b' ] }, true )).toBe( false );
            expect( isExpressionCompletelyDeterministic( 42, true )).toBe( true );

            // $function edge cases
            expect( isExpressionCompletelyDeterministic( { $function: null } )).toBe( false );
            expect( isExpressionCompletelyDeterministic( { $function: { body: 123, args: [] } } )).toBe( false );
            expect( isExpressionCompletelyDeterministic( { $function: { body: 'return 1;', args: null } } )).toBe( false );

            // Non-deterministic tokens in $function body
            expect( isExpressionCompletelyDeterministic( { $function: { body: 'return Date.now();', args: [] } } )).toBe( false );
            expect( isExpressionCompletelyDeterministic( { $function: { body: 'return new Date();', args: [] } } )).toBe( false );
            expect( isExpressionCompletelyDeterministic( { $function: { body: 'return Math.random();', args: [] } } )).toBe( false );
            expect( isExpressionCompletelyDeterministic( { $function: { body: 'return crypto.randomUUID();', args: [] } } )).toBe( false );
            expect( isExpressionCompletelyDeterministic( { $function: { body: 'return performance.now();', args: [] } } )).toBe( false );

            // $function under strictErrors
            expect( isExpressionCompletelyDeterministic( { $function: { body: 'return a + b;', args: [ '$a', '$b' ] } }, true )).toBe( false );

            // $function args validity
            expect( isExpressionCompletelyDeterministic( { $function: { body: 'return 1;', args: [ '$$ROOT' ] } } )).toBe( false );
            expect( isExpressionCompletelyDeterministic( { $function: { body: 'return 1;', args: [ '$$NOW' ] } } )).toBe( false );
            expect( isExpressionCompletelyDeterministic( { $function: { body: 'return 1;', args: [ { $rand: {} } ] } } )).toBe( false );
            expect( isExpressionCompletelyDeterministic( { $function: { body: 'return 1;', args: [ '$a' ] } } )).toBe( true );
        });

        it( 'collects expression dependencies correctly', () =>
        {
            expect( collectExpressionDependencies( '$user.name' )).toEqual( new Set([ 'user.name' ]) );
            expect( collectExpressionDependencies( { $size: '$items' } )).toEqual( new Set([ 'items' ]) );

            const fnDeps = collectExpressionDependencies({
                $function: {
                    body: 'return a + b;',
                    args: [ '$user.id', '$score' ]
                }
            });
            expect( fnDeps ).toEqual( new Set([ 'user.id', 'score' ]) );

            const fnNoArgsDeps = collectExpressionDependencies({
                $function: {
                    body: 'return 1;',
                    args: null
                }
            });
            expect( fnNoArgsDeps ).toEqual( new Set() );
        });

        it( 'rejects heuristic top-k pushdown when boundary conditions are not satisfied', () =>
        {
            const context = resolvePipelineGuarantees( [], {} );

            // sortIndex out of bounds
            expect( proveHeuristicTopKPushdown( [], 0, context )).toBeNull();
            expect( proveHeuristicTopKPushdown( [ { $sort: { a: 1 } } ], 2, context )).toBeNull();

            // strictFieldOrder: true
            const strictOrderContext = resolvePipelineGuarantees( [], { strictFieldOrder: true } );
            expect( proveHeuristicTopKPushdown( [
                { $addFields: { score: { $size: '$tags' } } },
                { $sort: { score: 1 } },
                { $limit: 10 }
            ], 1, strictOrderContext )).toBeNull();

            // Missing or invalid follower
            expect( proveHeuristicTopKPushdown( [
                { $addFields: { score: { $size: '$tags' } } },
                { $sort: { score: 1 } }
            ], 1, context )).toBeNull();

            // Downstream reads field order
            expect( proveHeuristicTopKPushdown( [
                { $addFields: { score: { $size: '$tags' } } },
                { $sort: { score: 1 } },
                { $limit: 10 },
                { $project: { $objectToArray: '$$ROOT' } }
            ], 1, context )).toBeNull();

            // Invalid sort keys
            expect( proveHeuristicTopKPushdown( [
                { $addFields: { score: { $size: '$tags' } } },
                { $sort: 'invalid' },
                { $limit: 10 }
            ], 1, context )).toBeNull();

            // Provider stage is not $addFields or $set
            expect( proveHeuristicTopKPushdown( [
                { $project: { score: 1 } },
                { $sort: { score: 1 } },
                { $limit: 10 }
            ], 1, context )).toBeNull();

            // Computed field expression is undefined in provider
            expect( proveHeuristicTopKPushdown( [
                { $addFields: { other: 1 } },
                { $sort: { score: 1 } },
                { $limit: 10 }
            ], 1, context )).toBeNull();

            // Provider writes a prefix or nested field but the exact key expression is undefined
            expect( proveHeuristicTopKPushdown( [
                { $set: { 'score.sub': 1 } },
                { $sort: { score: 1 } },
                { $limit: 10 }
            ], 1, context )).toBeNull();

            // Expression is non-deterministic
            expect( proveHeuristicTopKPushdown( [
                { $addFields: { score: { $rand: {} } } },
                { $sort: { score: 1 } },
                { $limit: 10 }
            ], 1, context )).toBeNull();

            // No computed sort keys (all root fields)
            expect( proveHeuristicTopKPushdown( [
                { $lookup: { from: 'items', as: 'items' } },
                { $sort: { rootField: 1 } },
                { $limit: 10 }
            ], 1, context )).toBeNull();

            // Provider stage cannot move earlier (targetIndex === minProviderIndex)
            expect( proveHeuristicTopKPushdown( [
                { $addFields: { score: { $size: '$tags' } } },
                { $sort: { score: 1 } },
                { $limit: 10 }
            ], 1, context )).toBeNull();

            // Intermediate stage between provider and sort modifies row count ($match)
            expect( proveHeuristicTopKPushdown( [
                { $addFields: { score: { $size: '$tags' } } },
                { $match: { active: true } },
                { $sort: { score: 1 } },
                { $limit: 10 }
            ], 2, context )).toBeNull();

            // Intermediate stage between provider and sort modifies row count when targetIndex < minProviderIndex
            expect( proveHeuristicTopKPushdown( [
                { $lookup: { from: 'items', as: 'items' } },
                { $addFields: { score: { $size: '$tags' } } },
                { $match: { active: true } },
                { $sort: { score: 1 } },
                { $limit: 10 }
            ], 3, context )).toBeNull();

            // Preceding stage writes to required dependency
            expect( proveHeuristicTopKPushdown( [
                { $addFields: { tags: [ 1, 2 ] } },
                { $lookup: { from: 'other', as: 'tags' } },
                { $addFields: { score: { $size: '$tags' } } },
                { $sort: { score: 1 } },
                { $limit: 10 }
            ], 3, context )).toBeNull();

            // Intermediate stage is not proven error-free under strictErrors
            const strictErrorsContext2 = resolvePipelineGuarantees( [], { strictErrors: true } );
            expect( proveHeuristicTopKPushdown( [
                { $addFields: { div: { $divide: [ '$a', '$b' ] } } },
                { $addFields: { score: 10 } },
                { $sort: { score: 1 } },
                { $limit: 10 }
            ], 2, strictErrorsContext2 )).toBeNull();
        });

        it( 'handles shadow key collisions by deterministically appending counter', () =>
        {
            const context = resolvePipelineGuarantees( [], {} );

            const pipeline =
            [
                { $match: { deleted: false } },
                { $lookup: { from: 'comments', as: 'comments' } },
                { $addFields: { __heuristic_score: 1, score: { $size: '$tags' } } },
                { $sort: { score: 1 } },
                { $limit: 10 }
            ];

            const proof = proveHeuristicTopKPushdown( pipeline, 3, context );

            expect( proof ).not.toBeNull();
            expect( proof!.targetIndex ).toBe( 1 );
            expect( Object.keys( proof!.shadowAddFields )[ 0 ] ).toBe( '__heuristic_score_0' );
            expect( proof!.shadowUnsetKeys ).toEqual([ '__heuristic_score_0' ]);

            // Collision between two computed sort keys in the same pipeline that sanitize to the same name
            const multiCollisionPipeline =
            [
                { $match: { deleted: false } },
                { $lookup: { from: 'comments', as: 'comments' } },
                { $addFields: { 'k_1': { $size: '$tags' }, 'k-1': { $size: '$tags' } } },
                { $sort: { 'k_1': 1, 'k-1': 1 } },
                { $limit: 10 }
            ];

            const multiProof = proveHeuristicTopKPushdown( multiCollisionPipeline, 3, context );

            expect( multiProof ).not.toBeNull();
            expect( Object.keys( multiProof!.shadowAddFields ) ).toEqual([ '__heuristic_k_1', '__heuristic_k_1_0' ]);
            expect( multiProof!.shadowUnsetKeys ).toEqual([ '__heuristic_k_1', '__heuristic_k_1_0' ]);
        });

        it( 'executes heuristic top-k pushdown for single and multiple computed keys', () =>
        {
            const pass = new TopKPushdownPass();

            // Single key pushdown
            const singleKeyPipeline =
            [
                { $match: { deleted: false } },
                { $lookup: { from: 'briefings', as: 'briefings' } },
                { $addFields: { ragStatus: { $function: { body: 'return job.briefings;', args: [ '$$ROOT' ] } } } },
                { $addFields: { activeCount: { $size: '$engagements' } } },
                { $sort: { activeCount: 1, _id: -1 } },
                { $limit: 10 }
            ];

            const singleOptimized = pass.execute( singleKeyPipeline );

            expect( singleOptimized.length ).toBe( 8 );
            expect( singleOptimized[ 0 ] ).toEqual( { $match: { deleted: false } } );
            expect( Object.keys( singleOptimized[ 1 ].$addFields )[ 0 ] ).toBe( '__heuristic_activeCount' );
            expect( singleOptimized[ 2 ] ).toEqual( { $sort: { __heuristic_activeCount: 1, _id: -1 } } );
            expect( singleOptimized[ 3 ] ).toEqual( { $limit: 10 } );
            expect( singleOptimized[ 4 ] ).toEqual( { $unset: '__heuristic_activeCount' } );
            expect( singleOptimized[ 5 ] ).toEqual( { $lookup: { from: 'briefings', as: 'briefings' } } );

            // Multiple keys pushdown (testing array $unset)
            const multiKeyPipeline =
            [
                { $match: { active: true } },
                { $lookup: { from: 'extra', as: 'extra' } },
                { $addFields: {
                    rankA: { $size: '$tags' },
                    rankB: { $size: '$skills' }
                } },
                { $sort: { rankA: 1, rankB: -1, _id: 1 } },
                { $skip: 5 },
                { $limit: 20 }
            ];

            const multiOptimized = pass.execute( multiKeyPipeline );

            expect( multiOptimized.length ).toBe( 8 );
            expect( multiOptimized[ 0 ] ).toEqual( { $match: { active: true } } );
            expect( Object.keys( multiOptimized[ 1 ].$addFields ) ).toEqual([
                '__heuristic_rankA',
                '__heuristic_rankB'
            ]);
            expect( multiOptimized[ 2 ] ).toEqual( {
                $sort: {
                    __heuristic_rankA: 1,
                    __heuristic_rankB: -1,
                    _id: 1
                }
            } );
            expect( multiOptimized[ 3 ] ).toEqual( { $skip: 5 } );
            expect( multiOptimized[ 4 ] ).toEqual( { $limit: 20 } );
            expect( multiOptimized[ 5 ] ).toEqual( {
                $unset: [ '__heuristic_rankA', '__heuristic_rankB' ]
            } );
            expect( multiOptimized[ 6 ] ).toEqual( { $lookup: { from: 'extra', as: 'extra' } } );
        });
    });
});

describe( 'heuristic top-k hardening (multi-provider, dotted, profitability)', () =>
{
    const context = resolvePipelineGuarantees( [], {} );
    const pass = new TopKPushdownPass();
    const docs = [
        { _id: 1, tags: [ 'a' ] },
        { _id: 2, tags: [ 'a', 'b', 'c' ] },
        { _id: 3, tags: [] },
        { _id: 4, tags: [ 'a', 'b', 'c', 'd', 'e' ] },
    ];
    const lookup = { $lookup: { from: 'extra', localField: '_id', foreignField: 'ref', as: 'extra' } };
    const ids = ( pipeline: any[] ): unknown[] => runMockPipeline( docs, pipeline ).map(( doc ) => doc._id );

    it( 'rejects providers split by a stage that writes a later key dependency (AE1)', () =>
    {
        const pipeline = [
            lookup,
            { $addFields: { k1: 0 } },
            { $set: { base: -1 } },
            { $addFields: { k2: { $multiply: [ { $size: '$tags' }, '$base' ] } } },
            { $sort: { k1: 1, k2: 1, _id: 1 } },
            { $limit: 2 },
        ];

        expect( ids( pipeline )).toEqual([ 4, 2 ]);
        expect( proveHeuristicTopKPushdown( pipeline, 4, context )).toBeNull();
        expect( ids( pass.execute( pipeline ))).toEqual([ 4, 2 ]);
    });

    it( 'rejects a sort key that reads another computed sort key (AE2)', () =>
    {
        const pipeline = [
            lookup,
            { $addFields: { k1: 0 } },
            { $addFields: { k2: { $multiply: [ { $size: '$tags' }, { $add: [ '$k1', -1 ] } ] } } },
            { $sort: { k1: 1, k2: 1, _id: 1 } },
            { $limit: 2 },
        ];

        expect( ids( pipeline )).toEqual([ 4, 2 ]);
        expect( proveHeuristicTopKPushdown( pipeline, 3, context )).toBeNull();
        expect( ids( pass.execute( pipeline ))).toEqual([ 4, 2 ]);
    });

    it( 'rejects dotted computed sort keys (AE3)', () =>
    {
        const pipeline = [
            lookup,
            { $addFields: { 'arr.v': { $size: '$tags' } } },
            { $sort: { 'arr.v': 1 } },
            { $limit: 2 },
        ];

        expect( proveHeuristicTopKPushdown( pipeline, 2, context )).toBeNull();
    });

    it( 'rejects a rewrite that only crosses cheap stages (AE4)', () =>
    {
        const pipeline = [
            { $match: { deleted: false } },
            { $addFields: { unrelated: 1 } },
            { $addFields: { k: { $size: '$tags' } } },
            { $sort: { k: 1 } },
            { $limit: 2 },
        ];

        expect( proveHeuristicTopKPushdown( pipeline, 3, context )).toBeNull();
    });

    it( 'never re-hoists a sort spec that already uses a shadow field', () =>
    {
        const pipeline = [
            lookup,
            { $addFields: { __heuristic_k: { $size: '$tags' } } },
            { $sort: { __heuristic_k: 1 } },
            { $limit: 2 },
        ];

        expect( proveHeuristicTopKPushdown( pipeline, 2, context )).toBeNull();
    });

    it( 'rejects when a stage between target and sort removes a root sort key', () =>
    {
        const pipeline = [
            lookup,
            { $addFields: { k: { $size: '$tags' } } },
            { $unset: 'rank' },
            { $sort: { k: 1, rank: 1 } },
            { $limit: 2 },
        ];

        expect( proveHeuristicTopKPushdown( pipeline, 3, context )).toBeNull();
    });

    it( 'requires every stage up to the sort to be error-free under strictErrors', () =>
    {
        const strict = resolvePipelineGuarantees( [], { strictErrors: true } );
        const pipeline = [
            lookup,
            { $addFields: { k: { $ifNull: [ '$score', 0 ] } } },
            { $addFields: { ratio: { $divide: [ 1, '$weight' ] } } },
            { $sort: { k: 1 } },
            { $limit: 2 },
        ];

        expect( proveHeuristicTopKPushdown( pipeline, 3, strict )).toBeNull();
        expect( proveHeuristicTopKPushdown( pipeline, 3, context )).not.toBeNull();
    });

    it( 'accepts two keys from one provider behind a lookup with one array unset', () =>
    {
        const pipeline = [
            lookup,
            { $addFields: { a: { $size: '$tags' }, b: { $multiply: [ { $size: '$tags' }, -1 ] } } },
            { $sort: { a: -1, b: 1, _id: 1 } },
            { $limit: 2 },
        ];
        const optimized = pass.execute( pipeline );

        expect( optimized[ 3 ] ).toEqual({ $unset: [ '__heuristic_a', '__heuristic_b' ] });
        expect( ids( optimized )).toEqual( ids( pipeline ));
    });

    it( 'accepts two keys from different providers with independent dependencies', () =>
    {
        const pipeline = [
            lookup,
            { $addFields: { a: { $size: '$tags' } } },
            { $addFields: { b: { $multiply: [ '$_id', -1 ] } } },
            { $sort: { a: 1, b: 1 } },
            { $limit: 3 },
        ];
        const proof = proveHeuristicTopKPushdown( pipeline, 3, context );

        expect( proof ).not.toBeNull();
        expect( proof!.targetIndex ).toBe( 0 );
        expect( ids( pass.execute( pipeline ))).toEqual( ids( pipeline ));
    });

    it( 'counts a $function stage as costly, but not the hoisted key itself', () =>
    {
        const fn = { $function: { body: 'function( x ) { return x; }', args: [ '$tags' ], lang: 'js' } };
        const costlyNeighbour = [
            { $match: { deleted: false } },
            { $addFields: { other: { $ifNull: [ fn, 0 ] } } },
            { $addFields: { k: { $size: '$tags' } } },
            { $sort: { k: 1 } },
            { $limit: 2 },
        ];
        const keyOnly = [
            { $match: { deleted: false } },
            { $addFields: { unrelated: 1 } },
            { $addFields: { k: { $size: '$tags' }, j: fn } },
            { $sort: { k: 1 } },
            { $limit: 2 },
        ];
        const keyIsFunction = [
            { $match: { deleted: false } },
            { $addFields: { unrelated: 1 } },
            { $addFields: { k: fn } },
            { $sort: { k: 1 } },
            { $limit: 2 },
        ];
        expect( proveHeuristicTopKPushdown( costlyNeighbour, 3, context )).not.toBeNull();
        expect( proveHeuristicTopKPushdown( keyOnly, 3, context )).not.toBeNull();
        expect( proveHeuristicTopKPushdown( keyIsFunction, 3, context )).toBeNull();
    });
});

