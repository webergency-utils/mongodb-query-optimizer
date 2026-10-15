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

    it( 'merges consecutive adjacent match stages into a single match document', () =>
    {
        const pipeline = [
            { $match: { status: 'active' } },
            { $match: { score: { $gt: 10 } } }
        ];

        expect( pass.execute( pipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( [
            {
                $match: {
                    status: 'active',
                    score: { $gt: 10 }
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
                    a: 1,
                    b: 2,
                    c: 3,
                    d: 4
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
                    tags: { $gt: 5 },
                    $and: [
                        { tags: { $lt: 10 } }
                    ]
                }
            }
        ] );
    } );

    it( 'eliminates dominated $match conjuncts across intervening stages that do not modify the checked field', () =>
    {
        const pipeline = [
            { $match: { deleted: { $ne: true } } },
            { $unwind: '$positions' },
            {
                $match: {
                    $and: [
                        {
                            deleted: { $ne: true },
                            'positions.deleted': { $ne: true }
                        },
                        {
                            $expr: {
                                $function: {
                                    lang: 'js',
                                    args: [ '$positions' ],
                                    body: 'function(p) { return true; }'
                                }
                            }
                        }
                    ]
                }
            }
        ];

        expect( pass.execute( pipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( [
            { $match: { deleted: { $ne: true } } },
            { $unwind: '$positions' },
            {
                $match: {
                    'positions.deleted': { $ne: true },
                    $expr: {
                        $function: {
                            lang: 'js',
                            args: [ '$positions' ],
                            body: 'function(p) { return true; }'
                        }
                    }
                }
            }
        ] );

        // Drops the entire downstream $match stage when all of its conjuncts are dominated
        expect( pass.execute( [
            { $match: { deleted: { $ne: true } } },
            { $unwind: '$positions' },
            { $match: { deleted: { $ne: true } } }
        ], DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( [
            { $match: { deleted: { $ne: true } } },
            { $unwind: '$positions' }
        ] );

        // Does NOT eliminate a downstream conjunct when an intermediate stage modifies the field
        const overwrittenPipeline = [
            { $match: { deleted: { $ne: true } } },
            { $set: { deleted: '$positions.deleted' } },
            { $match: { deleted: { $ne: true }, active: true } }
        ];
        expect( pass.execute( overwrittenPipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( overwrittenPipeline );

        // Does NOT eliminate downstream conjunct when intermediate $project has unknown projection or hides the field
        const unknownProjectPipeline = [
            { $match: { deleted: { $ne: true } } },
            { $project: { unknownField: { $unknownOp: 1 } } },
            { $match: { deleted: { $ne: true } } }
        ];
        expect( pass.execute( unknownProjectPipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( unknownProjectPipeline );

        const hidingProjectPipeline = [
            { $match: { deleted: { $ne: true } } },
            { $project: { other: 1, _id: 0 } },
            { $match: { deleted: { $ne: true } } }
        ];
        expect( pass.execute( hidingProjectPipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( hidingProjectPipeline );

        // Does NOT eliminate when intermediate stage removes the field via $unset
        const unsettingPipeline = [
            { $match: { deleted: { $ne: true } } },
            { $unset: 'deleted' },
            { $match: { deleted: { $ne: true } } }
        ];
        expect( pass.execute( unsettingPipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( unsettingPipeline );

        // Handles malformed downstream match stage
        const malformedPipeline = [
            { $match: { deleted: { $ne: true } } },
            { $unwind: '$positions' },
            { $match: { items: { $elemMatch: 'not-object' } } }
        ];
        expect( pass.execute( malformedPipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual( malformedPipeline );

        // Eliminates multiple dominated conjuncts across stages (hits current !== pipeline)
        const multiDominatedPipeline = [
            { $match: { a: 1, b: 2 } },
            { $unwind: '$items' },
            { $match: { a: 1, x: 10 } },
            { $sort: { x: 1 } },
            { $match: { b: 2, y: 20 } }
        ];
        expect( pass.execute( multiDominatedPipeline, DEFAULT_GUARANTEE_CONTEXT ) ).toEqual([
            { $match: { a: 1, b: 2 } },
            { $unwind: '$items' },
            { $match: { x: 10 } },
            { $sort: { x: 1 } },
            { $match: { y: 20 } }
        ]);
    } );
} );

