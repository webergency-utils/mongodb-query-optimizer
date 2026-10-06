import { describe, expect, it } from 'vitest';
import { CoveredProjectionSynthesisPass } from '../src/passes/covered-projection-synthesis';
import { proveCoveredProjectionSynthesis } from '../src/passes/covered-projection-proofs';
import { optimizePipelineWithCandidateProfile } from '../src/passes/registry';
import { runMockPipeline } from './helpers/mock-engine';

describe( 'covered-projection-proofs unit and branch analysis', () =>
{
    it( 'returns null for invalid or empty pipeline inputs', () =>
    {
        expect( proveCoveredProjectionSynthesis( null as any )).toBeNull();
        expect( proveCoveredProjectionSynthesis( undefined as any )).toBeNull();
        expect( proveCoveredProjectionSynthesis( 'not-an-array' as any )).toBeNull();
        expect( proveCoveredProjectionSynthesis( 123 as any )).toBeNull();
        expect( proveCoveredProjectionSynthesis( [] )).toBeNull();
    });

    it( 'returns null if no collapsing stage is present in the pipeline', () =>
    {
        const pipeline =
        [
            { $match: { status: 'active' } },
            { $sort: { score: -1 } }
        ];

        expect( proveCoveredProjectionSynthesis( pipeline )).toBeNull();
    });

    it( 'rejects malformed or non-plain-object stages', () =>
    {
        expect( proveCoveredProjectionSynthesis([ null ])).toBeNull();
        expect( proveCoveredProjectionSynthesis([ 123 ])).toBeNull();
        expect( proveCoveredProjectionSynthesis([ 'string' ])).toBeNull();
        expect( proveCoveredProjectionSynthesis([ [ 1 ] ])).toBeNull();
        expect( proveCoveredProjectionSynthesis([ {} ])).toBeNull();
        expect( proveCoveredProjectionSynthesis([ { $match: {}, extraKey: 1 } ])).toBeNull();

        const nullProto = Object.create( null );
        nullProto.$group = { _id: '$dept' };

        const proof = proveCoveredProjectionSynthesis([ nullProto ]);
        expect( proof ).not.toBeNull();
        expect( proof?.synthesizedStage ).toEqual({
            $project: { dept: 1, _id: 0 }
        });
    });

    it( 'returns null if the collapsing stage itself is malformed or invalid', () =>
    {
        // Malformed group (missing _id)
        expect( proveCoveredProjectionSynthesis([ { $group: {} } ])).toBeNull();

        // Group reading $$ROOT
        expect( proveCoveredProjectionSynthesis([
            { $group: { _id: '$$ROOT' } }
        ])).toBeNull();

        // Group with non-deterministic expression
        expect( proveCoveredProjectionSynthesis([
            { $group: { _id: '$dept', val: { $rand: {} } } }
        ])).toBeNull();

        // Group with unknown expression operator
        expect( proveCoveredProjectionSynthesis([
            { $group: { _id: '$dept', val: { $unknownOp: '$score' } } }
        ])).toBeNull();
    });

    it( 'returns null if prefix contains disallowed operators or malformed stages', () =>
    {
        // Prefix with $project
        expect( proveCoveredProjectionSynthesis([
            { $project: { dept: 1 } },
            { $group: { _id: '$dept' } }
        ])).toBeNull();

        // Prefix with $unset
        expect( proveCoveredProjectionSynthesis([
            { $unset: 'secret' },
            { $group: { _id: '$dept' } }
        ])).toBeNull();

        // Prefix with $lookup
        expect( proveCoveredProjectionSynthesis([
            { $lookup: { from: 'other', localField: 'x', foreignField: 'y', as: 'z' } },
            { $group: { _id: '$dept' } }
        ])).toBeNull();

        // Prefix with $unwind
        expect( proveCoveredProjectionSynthesis([
            { $unwind: '$items' },
            { $group: { _id: '$dept' } }
        ])).toBeNull();

        // Prefix with $facet
        expect( proveCoveredProjectionSynthesis([
            { $facet: { b: [] } },
            { $group: { _id: '$dept' } }
        ])).toBeNull();

        // Prefix with malformed stage
        expect( proveCoveredProjectionSynthesis([
            { $match: 123 },
            { $group: { _id: '$dept' } }
        ])).toBeNull();

        // Prefix with multiple keys
        expect( proveCoveredProjectionSynthesis([
            { $match: { a: 1 }, extra: true },
            { $group: { _id: '$dept' } }
        ])).toBeNull();
    });

    it( 'returns null if live fields are empty', () =>
    {
        // $count does not read any input document fields
        expect( proveCoveredProjectionSynthesis([
            { $count: 'total' }
        ])).toBeNull();
    });

    it( 'synthesizes projection retaining _id when live fields reference _id directly or via subpath', () =>
    {
        // Direct read of _id
        const proofDirect = proveCoveredProjectionSynthesis([
            { $group: { _id: '$_id', total: { $sum: 1 } } }
        ]);

        expect( proofDirect ).not.toBeNull();
        expect( proofDirect?.synthesizedStage ).toEqual({
            $project: { _id: 1 }
        });

        // Read of _id.sub with payload field
        const proofSub = proveCoveredProjectionSynthesis([
            { $group: { _id: '$_id.sub', total: { $sum: '$qty' } } }
        ]);

        expect( proofSub ).not.toBeNull();
        expect( proofSub?.synthesizedStage ).toEqual({
            $project: { _id: 1, qty: 1 }
        });
    });

    it( 'returns null if path in collapsing stage or intermediate stage is invalid', () =>
    {
        // Collapsing stage with empty part path
        expect( proveCoveredProjectionSynthesis([
            { $group: { _id: '$dept..name' } }
        ])).toBeNull();

        // Intermediate stage with invalid path
        expect( proveCoveredProjectionSynthesis([
            { $sort: { 'invalid..key': 1 } },
            { $group: { _id: '$dept' } }
        ])).toBeNull();
    });

    it( 'synthesizes projection at index 0 when no leading $match exists', () =>
    {
        const pipeline =
        [
            { $group: { _id: '$dept', total: { $sum: '$qty' } } }
        ];

        const proof = proveCoveredProjectionSynthesis( pipeline );
        expect( proof ).not.toBeNull();
        expect( proof?.insertIndex ).toBe( 0 );
        expect( proof?.synthesizedStage ).toEqual({
            $project: {
                dept: 1,
                qty: 1,
                _id: 0
            }
        });
    });

    it( 'synthesizes projection after leading $match stages', () =>
    {
        const pipeline =
        [
            { $match: { status: 'A' } },
            { $group: { _id: '$category', total: { $sum: '$amount' } } }
        ];

        const proof = proveCoveredProjectionSynthesis( pipeline );
        expect( proof ).not.toBeNull();
        expect( proof?.insertIndex ).toBe( 1 );
        expect( proof?.synthesizedStage ).toEqual({
            $project: {
                amount: 1,
                category: 1,
                _id: 0
            }
        });
    });

    it( 'synthesizes projection after multiple consecutive leading $match stages', () =>
    {
        const pipeline =
        [
            { $match: { status: 'A' } },
            { $match: { tier: 'gold' } },
            { $group: { _id: '$category', count: { $sum: 1 } } }
        ];

        const proof = proveCoveredProjectionSynthesis( pipeline );
        expect( proof ).not.toBeNull();
        expect( proof?.insertIndex ).toBe( 2 );
        expect( proof?.synthesizedStage ).toEqual({
            $project: {
                category: 1,
                _id: 0
            }
        });
    });

    it( 'correctly tracks backward liveness across intermediate $addFields and $sort', () =>
    {
        const pipeline =
        [
            { $match: { status: 'active' } },
            { $addFields: { computedScore: { $add: [ '$baseScore', '$bonus' ] } } },
            { $sort: { priority: -1 } },
            { $group: { _id: '$computedScore', count: { $sum: 1 } } }
        ];

        const proof = proveCoveredProjectionSynthesis( pipeline );
        expect( proof ).not.toBeNull();
        expect( proof?.insertIndex ).toBe( 1 );
        // computedScore is overwritten by $addFields, so baseScore and bonus are needed, plus priority
        expect( proof?.synthesizedStage ).toEqual({
            $project: {
                baseScore: 1,
                bonus: 1,
                priority: 1,
                _id: 0
            }
        });
    });

    it( 'simplifies nested paths when an ancestor path is present', () =>
    {
        const pipeline =
        [
            { $sort: { 'profile.address.city': 1 } },
            { $group: { _id: '$profile' } }
        ];

        const proof = proveCoveredProjectionSynthesis( pipeline );
        expect( proof ).not.toBeNull();
        expect( proof?.insertIndex ).toBe( 0 );
        // profile is an ancestor of profile.address.city, so profile.address.city is dropped
        expect( proof?.synthesizedStage ).toEqual({
            $project: {
                profile: 1,
                _id: 0
            }
        });
    });

    it( 'works with $sortByCount stages', () =>
    {
        const pipeline =
        [
            { $match: { status: 'active' } },
            { $sortByCount: '$tag' }
        ];

        const proof = proveCoveredProjectionSynthesis( pipeline );
        expect( proof ).not.toBeNull();
        expect( proof?.insertIndex ).toBe( 1 );
        expect( proof?.synthesizedStage ).toEqual({
            $project: {
                tag: 1,
                _id: 0
            }
        });
    });
});

describe( 'CoveredProjectionSynthesisPass class and execution', () =>
{
    it( 'exposes required stage types and metadata', () =>
    {
        const pass = new CoveredProjectionSynthesisPass();
        expect( pass.name ).toBe( 'covered-projection-synthesis' );
        expect( pass.stageTypes ).toEqual([ '$group', '$count', '$sortByCount' ]);
    });

    it( 'returns unchanged copy if proof is not applicable', () =>
    {
        const pass = new CoveredProjectionSynthesisPass();
        const pipeline = [ { $match: { a: 1 } } ];
        const result = pass.execute( pipeline );

        expect( result ).toEqual( pipeline );
        expect( result ).not.toBe( pipeline );
    });

    it( 'inserts synthesized projection at the proven index', () =>
    {
        const pass = new CoveredProjectionSynthesisPass();
        const pipeline =
        [
            { $match: { dept: 'Sales' } },
            { $group: { _id: '$dept', total: { $sum: '$qty' } } }
        ];

        const result = pass.execute( pipeline );
        expect( result ).toEqual([
            { $match: { dept: 'Sales' } },
            { $project: { dept: 1, qty: 1, _id: 0 } },
            { $group: { _id: '$dept', total: { $sum: '$qty' } } }
        ]);

        // Second execution is idempotent (no double projection)
        const secondResult = pass.execute( result );
        expect( secondResult ).toEqual( result );
    });

    it( 'integrates with candidate profile and produces identical mock results', () =>
    {
        const docs =
        [
            { _id: 1, dept: 'Sales', qty: 10, secret: 'x' },
            { _id: 2, dept: 'Sales', qty: 20, secret: 'y' },
            { _id: 3, dept: 'Engineering', qty: 30, secret: 'z' }
        ];

        const originalPipeline =
        [
            { $match: { dept: 'Sales' } },
            { $group: { _id: '$dept', total: { $sum: '$qty' } } }
        ];

        const optimizedPipeline = optimizePipelineWithCandidateProfile(
            originalPipeline,
            [ 'covered-projection-synthesis' ]
        );

        expect( optimizedPipeline ).toEqual([
            { $match: { dept: 'Sales' } },
            { $project: { dept: 1, qty: 1, _id: 0 } },
            { $group: { _id: '$dept', total: { $sum: '$qty' } } }
        ]);

        const unoptimizedResult = runMockPipeline( docs, originalPipeline );
        const optimizedResult = runMockPipeline( docs, optimizedPipeline );

        expect( optimizedResult ).toEqual( unoptimizedResult );
    });
});
