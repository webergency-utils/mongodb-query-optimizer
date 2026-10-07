import { describe, expect, it } from 'vitest';
import { AdjacentMatchMergingPass } from '../src/passes/adjacent-match-merging.js';
import { DEFAULT_GUARANTEE_CONTEXT } from '../src/guarantees.js';

describe( 'AdjacentMatchMergingPass', () =>
{
    const pass = new AdjacentMatchMergingPass();

    it( 'returns empty array when given an empty pipeline', () =>
    {
        expect( pass.execute( [], DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( [] );
    } );

    it( 'preserves non-match stages and passes them through unchanged', () =>
    {
        const pipeline = [
            { $sort: { score: -1 } },
            { $limit: 10 },
            { $project: { _id: 1, name: 1 } }
        ];

        expect( pass.execute( pipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( pipeline );
    } );

    it( 'preserves an isolated single match stage without altering its shape', () =>
    {
        const pipeline = [
            { $match: { status: 'active' } }
        ];

        expect( pass.execute( pipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( pipeline );
    } );

    it( 'merges consecutive adjacent match stages into an $and conjunction', () =>
    {
        const pipeline = [
            { $match: { status: 'active' } },
            { $match: { score: { $gt: 10 } } }
        ];

        expect( pass.execute( pipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( [
            {
                $match: {
                    $and: [
                        { status: 'active' },
                        { score: { $gt: 10 } }
                    ]
                }
            }
        ] );
    } );

    it( 'deduplicates identical adjacent match stages into a single unwrapped condition', () =>
    {
        const pipeline = [
            { $match: { status: 'active' } },
            { $match: { status: 'active' } }
        ];

        expect( pass.execute( pipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( [
            { $match: { status: 'active' } }
        ] );
    } );

    it( 'merges runs of three or more adjacent match stages and flattens nested conjunctions', () =>
    {
        const pipeline = [
            { $match: { a: 1 } },
            { $match: { $and: [ { b: 2 }, { c: 3 } ] } },
            { $match: { d: 4 } }
        ];

        expect( pass.execute( pipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( [
            {
                $match: {
                    $and: [
                        { a: 1 },
                        { b: 2 },
                        { c: 3 },
                        { d: 4 }
                    ]
                }
            }
        ] );
    } );

    it( 'does not merge match stages separated by an intervening non-match stage', () =>
    {
        const pipeline = [
            { $match: { a: 1 } },
            { $sort: { score: 1 } },
            { $match: { b: 2 } }
        ];

        expect( pass.execute( pipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( pipeline );
    } );

    it( 'bypasses non-rewrite-safe match stages such as non-deterministic expressions', () =>
    {
        const pipeline = [
            { $match: { $expr: { $rand: {} } } },
            { $match: { status: 'active' } }
        ];

        expect( pass.execute( pipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( pipeline );

        const reversePipeline = [
            { $match: { status: 'active' } },
            { $match: { $expr: { $rand: {} } } }
        ];

        expect( pass.execute( reversePipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( reversePipeline );
    } );

    it( 'preserves separate multikey branches across adjacent match stages', () =>
    {
        const pipeline = [
            { $match: { tags: { $gt: 5 } } },
            { $match: { tags: { $lt: 10 } } }
        ];

        expect( pass.execute( pipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( [
            {
                $match: {
                    $and: [
                        { tags: { $gt: 5 } },
                        { tags: { $lt: 10 } }
                    ]
                }
            }
        ] );
    } );
} );
