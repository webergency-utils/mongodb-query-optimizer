import { describe, expect, it } from 'vitest';
import { optimizePipeline } from '../src/index.js';
import { DeadAssignmentEliminationPass } from '../src/passes/dead-assignment-elimination';
import
{
    proveDeadAssignmentElimination,
    proveNoOpSelfAssignmentElimination
}
from '../src/passes/dead-assignment-proofs';
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

    it( 'handles dotted paths and unsafe expressions', () =>
    {
        // Dotted path with only sub-path overwrite is not eliminated (parent object creation side effect)
        expect( proveDeadAssignmentElimination(
            { $set: { 'a.b': 1 } },
            [ { $set: { 'a.b': 2 } } ]
        )).toBeNull();

        // Dotted path when entire top-level root field is killed is eliminated in default mode
        expect( proveDeadAssignmentElimination(
            { $set: { 'a.b': 1, keep: 2 } },
            [ { $unset: 'a' } ]
        )).toEqual({
            replacementStage: { $set: { keep: 2 } },
            eliminatedFields: [ 'a.b' ]
        });

        // Dotted path is preserved under strictErrors: true
        expect( proveDeadAssignmentElimination(
            { $set: { 'a.b': 1, keep: 2 } },
            [ { $unset: 'a' } ],
            { strictFieldOrder: false, strictErrors: true }
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
        expect( pass.stageTypes ).toEqual([ '$addFields', '$set', '$project', '$unset' ]);
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

    it( 'keeps an assignment a later let reads, even when a project would drop it', () =>
    {
        expect( proveDeadAssignmentElimination(
            { $set: { tmp: '$price' } },
            [
                { $set: { shown: { $let: { vars: { v: '$tmp' }, in: '$$v' } } } },
                { $project: { name: 1 } }
            ]
        )).toBeNull();
    });

    it( 'keeps an assignment when an unbound variable appears before the drop', () =>
    {
        expect( proveDeadAssignmentElimination(
            { $set: { tmp: 1 } },
            [
                { $set: { shown: '$$name' } },
                { $unset: 'tmp' }
            ]
        )).toBeNull();
    });

    it( 'removes an unread assignment when a later let reads a different field', () =>
    {
        const proof = proveDeadAssignmentElimination(
            { $set: { tmp: 1 } },
            [
                { $set: { shown: { $let: { vars: { v: '$other' }, in: '$$v' } } } },
                { $project: { name: 1 } }
            ]
        );

        expect( proof ).not.toBeNull();
        expect( proof?.eliminatedFields ).toEqual([ 'tmp' ]);
        expect( proof?.replacementStage ).toBeNull();
    });

    it( 'removes an unread assignment when a later group does not read it', () =>
    {
        const proof = proveDeadAssignmentElimination(
            { $set: { tmp: 1 } },
            [ { $group: { _id: '$customerId', n: { $sum: '$amount' } } } ]
        );

        expect( proof ).not.toBeNull();
        expect( proof?.eliminatedFields ).toEqual([ 'tmp' ]);
        expect( proof?.replacementStage ).toBeNull();
    });

    it( 'keeps an assignment a later group reads', () =>
    {
        expect( proveDeadAssignmentElimination(
            { $set: { customerId: 1 } },
            [ { $group: { _id: '$customerId' } } ]
        )).toBeNull();
    });

    it( 'keeps an assignment when a later group reads the whole document', () =>
    {
        expect( proveDeadAssignmentElimination(
            { $set: { tmp: 1 } },
            [ { $group: { _id: '$$ROOT' } } ]
        )).toBeNull();

        expect( proveDeadAssignmentElimination(
            { $set: { tmp: 1 } },
            [ { $group: { _id: { $let: { vars: { v: '$$ROOT' }, in: '$$v' } } } } ]
        )).toBeNull();
    });

    it( 'removes an unread assignment when a later count drops every field', () =>
    {
        const proof = proveDeadAssignmentElimination(
            { $set: { tmp: 1 } },
            [ { $count: 'n' } ]
        );

        expect( proof?.eliminatedFields ).toEqual([ 'tmp' ]);
        expect( proof?.replacementStage ).toBeNull();
    });

    it( 'removes an unread assignment when a later sortByCount does not read it', () =>
    {
        const proof = proveDeadAssignmentElimination(
            { $set: { tmp: 1 } },
            [ { $sortByCount: '$customerId' } ]
        );

        expect( proof?.eliminatedFields ).toEqual([ 'tmp' ]);
        expect( proof?.replacementStage ).toBeNull();
    });

    it( 'removes an unread assignment when a later $bucket or $bucketAuto does not read it', () =>
    {
        const bucketProof = proveDeadAssignmentElimination(
            { $set: { tmp: 1, year: 2000 } },
            [
                {
                    $bucket: {
                        groupBy: '$year',
                        boundaries: [ 1990, 2010 ],
                        default: 'other',
                        output: { count: { $sum: 1 } }
                    }
                }
            ]
        );
        expect( bucketProof?.eliminatedFields ).toEqual([ 'tmp' ]);
        expect( bucketProof?.replacementStage ).toEqual({ $set: { year: 2000 } });

        const bucketAutoProof = proveDeadAssignmentElimination(
            { $set: { tmp: 1 } },
            [
                {
                    $bucketAuto: {
                        groupBy: '$score',
                        buckets: 3
                    }
                }
            ]
        );
        expect( bucketAutoProof?.eliminatedFields ).toEqual([ 'tmp' ]);
        expect( bucketAutoProof?.replacementStage ).toBeNull();
    });

    it( 'keeps a source field that a chain of plain copies still reads', () =>
    {
        expect( proveDeadAssignmentElimination(
            { $set: { price: 1 } },
            [
                { $set: { tmp: '$price' } },
                { $set: { shown: '$tmp' } },
                { $project: { shown: 1 } }
            ]
        )).toBeNull();

        expect( proveDeadAssignmentElimination(
            { $set: { a: 1 } },
            [
                { $set: { b: '$a' } },
                { $set: { c: '$b' } },
                { $project: { c: 1 } }
            ]
        )).toBeNull();
    });

    it( 'keeps a source field copied through an expression', () =>
    {
        expect( proveDeadAssignmentElimination(
            { $set: { a: 1 } },
            [
                { $set: { b: { $add: [ '$a', 1 ] } } },
                { $project: { b: 1 } }
            ]
        )).toBeNull();
    });

    it( 'does not keep an assignment a copy reads only after the field is dropped', () =>
    {
        const proof = proveDeadAssignmentElimination(
            { $set: { a: 1 } },
            [
                { $project: { name: 1 } },
                { $set: { b: '$a' } }
            ]
        );

        expect( proof?.eliminatedFields ).toEqual([ 'a' ]);
        expect( proof?.replacementStage ).toBeNull();
    });

    it( 'keeps an assignment a projection copies into another field', () =>
    {
        expect( proveDeadAssignmentElimination(
            { $set: { tmp: '$price' } },
            [ { $project: { shown: '$tmp' } } ]
        )).toBeNull();
    });

    it( 'eliminates a throwing assignment when strict errors are off and keeps it when strict errors are on', () =>
    {
        const suffix = [ { $unset: 'tmp' } ];
        const source = { $set: { tmp: { $divide: [ '$a', 0 ] } } };

        const proof = proveDeadAssignmentElimination( source, suffix );
        expect( proof?.eliminatedFields ).toEqual([ 'tmp' ]);
        expect( proof?.replacementStage ).toBeNull();

        expect( proveDeadAssignmentElimination(
            source,
            suffix,
            { strictFieldOrder: false, strictErrors: true }
        )).toBeNull();
    });

    it( 'keeps an overwritten field when strict field order is on', () =>
    {
        const source = { $set: { tmp: 1 } };
        const suffix = [ { $set: { kept: '$name', tmp: 'later' } } ];

        expect( proveDeadAssignmentElimination(
            source,
            suffix,
            { strictFieldOrder: true, strictErrors: false }
        )).toBeNull();

        const proof = proveDeadAssignmentElimination( source, suffix );
        expect( proof?.eliminatedFields ).toEqual([ 'tmp' ]);
        expect( proof?.replacementStage ).toBeNull();
    });

    it( 'still drops an unread field before a group when strict field order is on', () =>
    {
        const proof = proveDeadAssignmentElimination(
            { $set: { tmp: 1 } },
            [ { $group: { _id: '$customerId', n: { $sum: '$amount' } } } ],
            { strictFieldOrder: true, strictErrors: false }
        );

        expect( proof?.eliminatedFields ).toEqual([ 'tmp' ]);
    });

    it( 'eliminates redundant $unset fields completely or partially when downstream discards them', () =>
    {
        expect( proveDeadAssignmentElimination(
            { $unset: 'a' },
            [ { $project: { b: 1 } } ]
        )).toEqual({
            replacementStage: null,
            eliminatedFields: [ 'a' ]
        });

        expect( proveDeadAssignmentElimination(
            { $unset: [ 'a', 'b', 'c' ] },
            [ { $project: { b: 1 } } ]
        )).toEqual({
            replacementStage: { $unset: 'b' },
            eliminatedFields: [ 'a', 'c' ]
        });

        expect( proveDeadAssignmentElimination(
            { $unset: [ 'a', 'b', 'c' ] },
            [ { $project: { b: 1, c: 1 } } ]
        )).toEqual({
            replacementStage: { $unset: [ 'b', 'c' ] },
            eliminatedFields: [ 'a' ]
        });

        expect( proveDeadAssignmentElimination(
            { $unset: 'a' },
            [ { $project: { a: 1 } } ]
        )).toBeNull();

        // Eliminates dotted $unset when parent path is discarded downstream
        expect( proveDeadAssignmentElimination(
            { $unset: [ 'profile.secret', 'kept.field' ] },
            [ { $project: { kept: 1 } } ]
        )).toEqual({
            replacementStage: { $unset: 'kept.field' },
            eliminatedFields: [ 'profile.secret' ]
        });

        expect( proveDeadAssignmentElimination(
            { $unset: [] },
            [ { $project: { b: 1 } } ]
        )).toBeNull();
    });

    it( 'prunes unused computed fields in inclusion $project while keeping required or only-field projections', () =>
    {
        expect( proveDeadAssignmentElimination(
            { $project: { a: 1, computed: { $add: [ '$x', 1 ] } } },
            [ { $project: { a: 1 } } ]
        )).toEqual({
            replacementStage: { $project: { a: 1 } },
            eliminatedFields: [ 'computed' ]
        });

        // Keeps computed field when it is the only included/computed field and _id is excluded
        expect( proveDeadAssignmentElimination(
            { $project: { _id: 0, computed: { $add: [ '$x', 1 ] } } },
            [ { $count: 'total' } ]
        )).toBeNull();

        // Can prune computed field when _id: 1 remains
        expect( proveDeadAssignmentElimination(
            { $project: { _id: 1, computed: { $add: [ '$x', 1 ] } } },
            [ { $project: { _id: 1 } } ]
        )).toEqual({
            replacementStage: { $project: { _id: 1 } },
            eliminatedFields: [ 'computed' ]
        });

        // Skips computed _id, dotted paths, volatile expressions, and unknown dependencies
        expect( proveDeadAssignmentElimination(
            { $project: { _id: '$customId', a: 1, 'nested.x': { $add: [ '$x', 1 ] }, r: { $rand: {} } } },
            [ { $project: { a: 1 } } ]
        )).toBeNull();

        expect( proveDeadAssignmentElimination(
            { $project: { a: 1, bad: '$$unboundVar' } },
            [ { $project: { a: 1 } } ]
        )).toBeNull();
    });

    it( 'eliminates no-op self-assignments when field is guaranteed present by upstream stage', () =>
    {
        const pass = new DeadAssignmentEliminationPass();

        // Direct $x, $$ROOT.x, $$CURRENT.x self-assignments after upstream $set
        expect( proveNoOpSelfAssignmentElimination(
            [ { $set: { a: 1, b: 2, c: 3 } } ],
            { $set: { a: '$a', b: '$$ROOT.b', c: '$$CURRENT.c' } }
        )).toEqual({
            replacementStage: null,
            eliminatedFields: [ 'a', 'b', 'c' ]
        });

        // Partial self-assignment elimination keeps non-self fields
        expect( proveNoOpSelfAssignmentElimination(
            [ { $addFields: { a: 1, 'nested.x': 2 } }, { $match: { active: true } } ],
            { $addFields: { a: '$a', d: 4 } }
        )).toEqual({
            replacementStage: { $addFields: { d: 4 } },
            eliminatedFields: [ 'a' ]
        });

        // End-to-end pass execution removes full self-assignment stage
        expect( pass.execute([
            { $set: { a: 10 } },
            { $set: { a: '$a' } }
        ])).toEqual([
            { $set: { a: 10 } }
        ]);

        // Unset or projection clears guaranteed fields
        expect( proveNoOpSelfAssignmentElimination(
            [ { $set: { a: 1 } }, { $unset: 'a' } ],
            { $set: { a: '$a' } }
        )).toBeNull();
        expect( proveNoOpSelfAssignmentElimination(
            [ { $set: { a: 1 } }, { $project: { b: 1 } } ],
            { $set: { a: '$a' } }
        )).toBeNull();

        // Rejects under strictFieldOrder, empty prefix, or non-addFields source
        expect( proveNoOpSelfAssignmentElimination(
            [ { $set: { a: 1 } } ],
            { $set: { a: '$a' } },
            { strictFieldOrder: true, strictErrors: false }
        )).toBeNull();
        expect( proveNoOpSelfAssignmentElimination(
            [],
            { $set: { a: '$a' } }
        )).toBeNull();
        expect( proveNoOpSelfAssignmentElimination(
            [ { $set: { a: 1 } } ],
            { $match: { a: 1 } }
        )).toBeNull();
        expect( proveNoOpSelfAssignmentElimination(
            [ { $set: { a: 1 } } ],
            { $set: { a: '$b' } }
        )).toBeNull();
    });
});

describe( 'production dead-assignment optimization', () =>
{
    it( 'removes an unread assignment and keeps the projected documents', () =>
    {
        const docs = [
            { _id: 1, name: 'a', price: 10 },
            { _id: 2, name: 'b', price: 20 }
        ];
        const pipeline = [
            { $set: { tmp: '$price' } },
            { $project: { name: 1 } }
        ];
        const optimized = optimizePipeline( pipeline );

        expect( optimized ).toEqual([
            { $project: { name: 1 } }
        ]);
        expect( runMockPipeline( docs, optimized ) ).toEqual( runMockPipeline( docs, pipeline ) );
    });

    it( 'keeps document count and order when both rewrites apply', () =>
    {
        const docs = [
            { _id: 1, customerId: 'a', amount: 10, note: 'x' },
            { _id: 2, customerId: 'b', amount: 4, note: 'y' },
            { _id: 3, customerId: 'a', amount: 1, note: 'z' }
        ];
        const pipeline = [
            { $set: { tmp: 1 } },
            { $group: { _id: '$customerId', n: { $sum: '$amount' } } }
        ];
        const optimized = optimizePipeline( pipeline );

        expect( optimized ).toEqual([
            { $project: { amount: 1, customerId: 1, _id: 0 } },
            { $group: { _id: '$customerId', n: { $sum: '$amount' } } }
        ]);
        expect( runMockPipeline( docs, optimized ) ).toEqual( runMockPipeline( docs, pipeline ) );
    });

    it( 'leaves an $expr match unchanged', () =>
    {
        const pipeline = [
            { $match: { $expr: { $eq: [ '$a', 1 ] } } }
        ];

        expect( optimizePipeline( pipeline ) ).toEqual( pipeline );
    });
});
