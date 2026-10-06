import { describe, expect, it } from 'vitest';
import { DeadAssignmentEliminationPass } from '../src/passes/dead-assignment-elimination';
import { proveDeadAssignmentElimination } from '../src/passes/dead-assignment-proofs';
import { optimizePipelineWithCandidateProfile } from '../src/passes/registry';
import { runMockPipeline } from './helpers/mock-engine';

describe( 'dead-assignment-proofs unit and branch analysis', () =>
{
    it( 'returns null for invalid inputs or empty suffix', () =>
    {
        expect( proveDeadAssignmentElimination( null, [] )).toBeNull();
        expect( proveDeadAssignmentElimination( { $set: { a: 1 } }, null as any )).toBeNull();
        expect( proveDeadAssignmentElimination( { $set: { a: 1 } }, [] )).toBeNull();
        expect( proveDeadAssignmentElimination( { $match: { a: 1 } }, [ { $set: { a: 2 } } ] )).toBeNull();
        expect( proveDeadAssignmentElimination( null, [ { $set: { a: 2 } } ] )).toBeNull();
    });

    it( 'ignores non-top-level paths or unsafe expressions', () =>
    {
        // Dotted path (not top-level)
        expect( proveDeadAssignmentElimination(
            { $set: { 'a.b': 1 } },
            [ { $set: { 'a.b': 2 } } ]
        )).toBeNull();

        // Non-deterministic expression ($rand)
        expect( proveDeadAssignmentElimination(
            { $set: { a: { $rand: {} } } },
            [ { $set: { a: 2 } } ]
        )).toBeNull();

        // Unknown operator
        expect( proveDeadAssignmentElimination(
            { $set: { a: { $unknownOp: 1 } } },
            [ { $set: { a: 2 } } ]
        )).toBeNull();
    });

    it( 'proves dead assignment when overwritten by downstream $set', () =>
    {
        const proof = proveDeadAssignmentElimination(
            { $set: { a: '$x', b: 1 } },
            [ { $set: { a: '$y' } } ]
        );

        expect( proof ).not.toBeNull();
        expect( proof?.eliminatedFields ).toEqual([ 'a' ]);
        expect( proof?.replacementStage ).toEqual({
            $set: { b: 1 }
        });
    });

    it( 'proves complete elimination when all assignments are dead', () =>
    {
        const proof = proveDeadAssignmentElimination(
            { $set: { a: '$x' } },
            [ { $set: { a: '$y' } } ]
        );

        expect( proof ).not.toBeNull();
        expect( proof?.eliminatedFields ).toEqual([ 'a' ]);
        expect( proof?.replacementStage ).toBeNull();
    });

    it( 'proves dead assignment when killed by downstream $unset', () =>
    {
        const proof = proveDeadAssignmentElimination(
            { $addFields: { temp: '$raw', keep: 1 } },
            [ { $unset: 'temp' } ]
        );

        expect( proof ).not.toBeNull();
        expect( proof?.eliminatedFields ).toEqual([ 'temp' ]);
        expect( proof?.replacementStage ).toEqual({
            $addFields: { keep: 1 }
        });
    });

    it( 'proves dead assignment when discarded by downstream inclusion $project', () =>
    {
        const proof = proveDeadAssignmentElimination(
            { $set: { dead: '$computed', retained: 1 } },
            [ { $project: { retained: 1 } } ]
        );

        expect( proof ).not.toBeNull();
        expect( proof?.eliminatedFields ).toEqual([ 'dead' ]);
        expect( proof?.replacementStage ).toEqual({
            $set: { retained: 1 }
        });
    });

    it( 'proves dead assignment when discarded by downstream exclusion $project', () =>
    {
        const proof = proveDeadAssignmentElimination(
            { $set: { dead: '$computed', retained: 1 } },
            [ { $project: { dead: 0 } } ]
        );

        expect( proof ).not.toBeNull();
        expect( proof?.eliminatedFields ).toEqual([ 'dead' ]);
        expect( proof?.replacementStage ).toEqual({
            $set: { retained: 1 }
        });
    });

    it( 'does not eliminate if downstream project retains the field', () =>
    {
        const proof = proveDeadAssignmentElimination(
            { $set: { kept: '$computed' } },
            [ { $project: { kept: 1 } } ]
        );

        expect( proof ).toBeNull();
    });

    it( 'does not eliminate if downstream stage reads the field', () =>
    {
        // Downstream $match reads 'a'
        expect( proveDeadAssignmentElimination(
            { $set: { a: '$x' } },
            [ { $match: { a: { $gt: 0 } } }, { $set: { a: '$y' } } ]
        )).toBeNull();

        // Downstream $set reads 'a' while assigning 'a'
        expect( proveDeadAssignmentElimination(
            { $set: { a: '$x' } },
            [ { $set: { a: { $add: [ '$a', 1 ] } } } ]
        )).toBeNull();
    });

    it( 'scans past transparent stages ($match, $sort, $limit) to find overwrite', () =>
    {
        const proof = proveDeadAssignmentElimination(
            { $set: { temp: '$value', keep: 1 } },
            [
                { $match: { keep: 1 } },
                { $sort: { keep: -1 } },
                { $limit: 10 },
                { $set: { temp: 'final' } }
            ]
        );

        expect( proof ).not.toBeNull();
        expect( proof?.eliminatedFields ).toEqual([ 'temp' ]);
        expect( proof?.replacementStage ).toEqual({
            $set: { keep: 1 }
        });
    });

    it( 'stops scan if an intermediate stage is an observation barrier', () =>
    {
        // Barrier: $lookup might observe incoming document
        expect( proveDeadAssignmentElimination(
            { $set: { temp: '$value' } },
            [
                { $lookup: { from: 'orders', localField: 'id', foreignField: 'userId', as: 'orders' } },
                { $set: { temp: 'final' } }
            ]
        )).toBeNull();

        // Barrier: Unknown stage
        expect( proveDeadAssignmentElimination(
            { $set: { temp: '$value' } },
            [
                { $unknownStage: {} },
                { $set: { temp: 'final' } }
            ]
        )).toBeNull();
    });
});

describe( 'DeadAssignmentEliminationPass execution and parity', () =>
{
    const pass = new DeadAssignmentEliminationPass();

    it( 'has correct pass metadata', () =>
    {
        expect( pass.name ).toBe( 'dead-assignment-elimination' );
        expect( pass.stageTypes ).toEqual([ '$addFields', '$set' ]);
    });

    it( 'returns cloned pipeline if no optimizations apply', () =>
    {
        const pipeline = [ { $match: { a: 1 } } ];
        const result = pass.execute( pipeline );

        expect( result ).toEqual( pipeline );
        expect( result ).not.toBe( pipeline );
    });

    it( 'replaces partial dead assignments in place', () =>
    {
        const pipeline = [
            { $set: { dead: '$x', alive: '$y' } },
            { $set: { dead: '$z' } }
        ];

        const result = pass.execute( pipeline );

        expect( result ).toEqual([
            { $set: { alive: '$y' } },
            { $set: { dead: '$z' } }
        ]);
    });

    it( 'splices out completely dead stage', () =>
    {
        const pipeline = [
            { $set: { dead: '$x' } },
            { $set: { dead: '$z' } }
        ];

        const result = pass.execute( pipeline );

        expect( result ).toEqual([
            { $set: { dead: '$z' } }
        ]);
    });

    it( 'executes end-to-end with candidate profile and preserves execution parity', () =>
    {
        const dataset = [
            { _id: 1, base: 10, email: 'ALICE@EXAMPLE.COM' },
            { _id: 2, base: 20, email: 'BOB@EXAMPLE.COM' }
        ];

        const pipeline = [
            { $set: { tempEmail: '$email', factor: 2 } },
            { $match: { factor: 2 } },
            { $set: { tempEmail: 'final@example.com' } }
        ];

        const optimized = optimizePipelineWithCandidateProfile(
            pipeline,
            [ 'dead-assignment-elimination' ]
        );

        // tempEmail in the first stage was overwritten by stage 3, so it should be pruned
        expect( optimized ).toEqual([
            { $set: { factor: 2 } },
            { $match: { factor: 2 } },
            { $set: { tempEmail: 'final@example.com' } }
        ]);

        const rawResult = runMockPipeline( dataset, pipeline );
        const optimizedResult = runMockPipeline( dataset, optimized );

        expect( optimizedResult ).toEqual( rawResult );
        expect( optimizedResult ).toEqual([
            { _id: 1, base: 10, email: 'ALICE@EXAMPLE.COM', factor: 2, tempEmail: 'final@example.com' },
            { _id: 2, base: 20, email: 'BOB@EXAMPLE.COM', factor: 2, tempEmail: 'final@example.com' }
        ]);
    });
});
