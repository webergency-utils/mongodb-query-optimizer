import { describe, expect, it } from 'vitest';
import { resolvePipelineGuarantees } from '../src/guarantees.js';
import { optimizePipeline as optimizePipelineProduction } from '../src/index.js';
import
{
    HeuristicMatchPushdownPass,
    proveHeuristicMatchPushdown
}
from '../src/passes/heuristic-match-pushdown.js';
import { runMockPipeline } from './helpers/mock-engine.js';

describe( 'HeuristicMatchPushdownPass proof and execution', () =>
{
    const context = resolvePipelineGuarantees( [], {} );
    const strictErrors = resolvePipelineGuarantees( [], { strictErrors: true } );
    const strictOrder = resolvePipelineGuarantees( [], { strictFieldOrder: true } );
    const pass = new HeuristicMatchPushdownPass();

    const lookup = { $lookup: { from: 'extra', localField: '_id', foreignField: 'ref', as: 'extra' } };
    const docs = [
        { _id: 1, tags: [ 'a' ], score: 10, meta: { val: 2 } },
        { _id: 2, tags: [ 'a', 'b', 'c' ], score: 20, meta: { val: 15 } },
        { _id: 3, tags: [], score: 30, meta: { val: 1 } },
        { _id: 4, tags: [ 'a', 'b' ], score: 5, meta: { val: 7 } },
    ];
    const ids = ( pipeline: any[] ): unknown[] => runMockPipeline( docs, pipeline ).map(( doc ) => doc._id );

    it( 'hoists count filter behind a $lookup and a $$ROOT reader (AE5)', () =>
    {
        const rootReader = {
            $addFields: {
                summary: {
                    $function: {
                        body: 'function( doc ) { return doc._id; }',
                        args: [ '$$ROOT' ],
                        lang: 'js'
                    }
                }
            }
        };
        const pipeline = [
            lookup,
            rootReader,
            { $addFields: { cnt: { $size: '$tags' } } },
            { $match: { cnt: { $gt: 1 } } }
        ];

        const proof = proveHeuristicMatchPushdown( pipeline, 3, context );
        expect( proof ).not.toBeNull();
        expect( proof!.targetIndex ).toBe( 0 );
        expect( proof!.shadowUnsetKeys ).toEqual([ '__heuristic_cnt' ]);
        expect( proof!.residualFilter ).toBeNull();

        const optimized = pass.execute( pipeline );
        expect( optimized.length ).toBe( 6 );
        expect( optimized[ 0 ] ).toEqual({ $addFields: { __heuristic_cnt: { $size: '$tags' } } });
        expect( optimized[ 1 ] ).toEqual({ $match: { __heuristic_cnt: { $gt: 1 } } });
        expect( optimized[ 2 ] ).toEqual({ $unset: '__heuristic_cnt' });
        expect( ids( optimized )).toEqual( ids( pipeline ));
        expect( ids( optimized )).toEqual([ 2, 4 ]);
    });

    it( 'handles mixed conjuncts by hoisting only the computed key and leaving residual', () =>
    {
        const pipeline = [
            lookup,
            { $addFields: { cnt: { $size: '$tags' } } },
            { $match: { cnt: { $gt: 1 }, score: { $lt: 20 } } }
        ];

        const proof = proveHeuristicMatchPushdown( pipeline, 2, context );
        expect( proof ).not.toBeNull();
        expect( proof!.targetIndex ).toBe( 0 );
        expect( proof!.shadowFilter ).toEqual({ __heuristic_cnt: { $gt: 1 } });
        expect( proof!.residualFilter ).toEqual({ score: { $lt: 20 } });

        const optimized = pass.execute( pipeline );
        expect( optimized.length ).toBe( 6 );
        expect( optimized[ 0 ] ).toEqual({ $addFields: { __heuristic_cnt: { $size: '$tags' } } });
        expect( optimized[ 1 ] ).toEqual({ $match: { __heuristic_cnt: { $gt: 1 } } });
        expect( optimized[ 2 ] ).toEqual({ $unset: '__heuristic_cnt' });
        expect( optimized[ 3 ] ).toEqual( lookup );
        expect( optimized[ 4 ] ).toEqual({ $addFields: { cnt: { $size: '$tags' } } });
        expect( optimized[ 5 ] ).toEqual({ $match: { score: { $lt: 20 } } });
        expect( ids( optimized )).toEqual( ids( pipeline ));
        expect( ids( optimized )).toEqual([ 4 ]);
    });

    it( 'renames a conjunct on a dotted sub-path of a computed document (k.sub) to __heuristic_k.sub', () =>
    {
        const pipeline = [
            lookup,
            { $addFields: { info: '$meta' } },
            { $match: { 'info.val': { $gt: 5 } } }
        ];

        const proof = proveHeuristicMatchPushdown( pipeline, 2, context );
        expect( proof ).not.toBeNull();
        expect( proof!.targetIndex ).toBe( 0 );
        expect( proof!.shadowFilter ).toEqual({ '__heuristic_info.val': { $gt: 5 } });

        const optimized = pass.execute( pipeline );
        expect( ids( optimized )).toEqual( ids( pipeline ));
        expect( ids( optimized )).toEqual([ 2, 4 ]);
    });

    it( 'preserves exact semantics when filtering with equality on array-valued computed field', () =>
    {
        const pipeline = [
            lookup,
            { $addFields: { k: '$tags' } },
            { $match: { k: 'b' } }
        ];

        const proof = proveHeuristicMatchPushdown( pipeline, 2, context );
        expect( proof ).not.toBeNull();

        const optimized = pass.execute( pipeline );
        expect( ids( optimized )).toEqual( ids( pipeline ));
        expect( ids( optimized )).toEqual([ 2, 4 ]);
    });

    it( 'pushes multiple computed keys and unsets them with array notation', () =>
    {
        const pipeline = [
            lookup,
            { $addFields: { k1: { $size: '$tags' }, k2: '$score' } },
            { $match: { k1: { $gt: 1 }, k2: { $gte: 20 } } }
        ];

        const proof = proveHeuristicMatchPushdown( pipeline, 2, context );
        expect( proof ).not.toBeNull();
        expect( proof!.shadowUnsetKeys ).toEqual([ '__heuristic_k1', '__heuristic_k2' ]);

        const optimized = pass.execute( pipeline );
        expect( optimized[ 2 ] ).toEqual({ $unset: [ '__heuristic_k1', '__heuristic_k2' ] });
        expect( ids( optimized )).toEqual( ids( pipeline ));
        expect( ids( optimized )).toEqual([ 2 ]);
    });

    it( 'rejects non-deterministic or dotted computed provider keys', () =>
    {
        const nonDet = [
            lookup,
            { $addFields: { k: { $rand: {} } } },
            { $match: { k: { $gt: 0.5 } } }
        ];
        expect( proveHeuristicMatchPushdown( nonDet, 2, context )).toBeNull();

        const dotted = [
            lookup,
            { $addFields: { 'sub.k': { $size: '$tags' } } },
            { $match: { 'sub.k': { $gt: 1 } } }
        ];
        expect( proveHeuristicMatchPushdown( dotted, 2, context )).toBeNull();
    });

    it( 'rejects when an intervening stage changes cardinality other than filter (e.g. $limit)', () =>
    {
        const pipeline = [
            lookup,
            { $addFields: { k: { $size: '$tags' } } },
            { $limit: 2 },
            { $match: { k: { $gt: 1 } } }
        ];

        expect( proveHeuristicMatchPushdown( pipeline, 3, context )).toBeNull();
    });

    it( 'rejects unsafe conjuncts with whole-document dependency ($where, $jsonSchema) or $getField', () =>
    {
        const wherePipeline = [
            lookup,
            { $addFields: { k: { $size: '$tags' } } },
            { $match: { $where: 'this.k > 1' } }
        ];
        expect( proveHeuristicMatchPushdown( wherePipeline, 2, context )).toBeNull();

        const jsonSchemaPipeline = [
            lookup,
            { $addFields: { k: { $size: '$tags' } } },
            { $match: { $jsonSchema: { required: [ 'k' ] } } }
        ];
        expect( proveHeuristicMatchPushdown( jsonSchemaPipeline, 2, context )).toBeNull();

        const getFieldPipeline = [
            lookup,
            { $addFields: { k: { $size: '$tags' } } },
            { $match: { $expr: { $gt: [ { $getField: 'k' }, 1 ] } } }
        ];
        expect( proveHeuristicMatchPushdown( getFieldPipeline, 2, context )).toBeNull();
    });

    it( 'rejects when crossed range has only cheap stages', () =>
    {
        const pipeline = [
            { $unset: 'unrelated' },
            { $addFields: { k: { $size: '$tags' } } },
            { $match: { k: { $gt: 1 } } }
        ];

        expect( proveHeuristicMatchPushdown( pipeline, 2, context )).toBeNull();
    });

    it( 'rejects under strictFieldOrder', () =>
    {
        const pipeline = [
            lookup,
            { $addFields: { k: { $size: '$tags' } } },
            { $match: { k: { $gt: 1 } } }
        ];

        expect( proveHeuristicMatchPushdown( pipeline, 2, strictOrder )).toBeNull();
        expect( pass.execute( pipeline, strictOrder )).toBe( pipeline );
    });

    it( 'rejects under strictErrors when match or crossed stage is not proven error-free', () =>
    {
        const errorMatch = [
            lookup,
            { $addFields: { k: { $ifNull: [ '$score', 0 ] } } },
            { $match: { $expr: { $divide: [ 1, '$k' ] } } }
        ];
        expect( proveHeuristicMatchPushdown( errorMatch, 2, strictErrors )).toBeNull();

        const errorStage = [
            lookup,
            { $addFields: { bad: { $divide: [ 1, '$score' ] } } },
            { $addFields: { k: { $ifNull: [ '$score', 0 ] } } },
            { $match: { k: { $gt: 0 } } }
        ];
        expect( proveHeuristicMatchPushdown( errorStage, 3, strictErrors )).toBeNull();
    });

    it( 'handles filtering stages in crossed range and validates error safety', () =>
    {
        const pipeline = [
            lookup,
            { $match: { active: true } },
            { $addFields: { k: { $size: '$tags' } } },
            { $match: { k: { $gt: 0 } } }
        ];

        // $size on $tags is error-prone on missing/non-array, so across filter it requires deterministic error-free
        const proof = proveHeuristicMatchPushdown( pipeline, 3, context );
        expect( proof ).toBeNull();

        const safePipeline = [
            lookup,
            { $match: { active: true } },
            { $addFields: { k: { $ifNull: [ '$score', 0 ] } } },
            { $match: { k: { $gt: 0 } } }
        ];
        const safeProof = proveHeuristicMatchPushdown( safePipeline, 3, context );
        expect( safeProof ).not.toBeNull();
        expect( safeProof!.targetIndex ).toBe( 0 );
    });

    it( 'reaches a fixed point under full-registry optimization without double-prefixing', () =>
    {
        const pipeline = [
            lookup,
            { $addFields: { k: { $size: '$tags' } } },
            { $match: { k: { $gt: 1 } } }
        ];

        const optimizedOnce = optimizePipelineProduction( pipeline );
        const optimizedTwice = optimizePipelineProduction( optimizedOnce );

        expect( JSON.stringify( optimizedOnce )).toBe( JSON.stringify( optimizedTwice ));
        expect( JSON.stringify( optimizedOnce ).includes( '__heuristic___heuristic_' )).toBe( false );
    });

    it( 'covers boundary conditions and invalid match stages', () =>
    {
        expect( proveHeuristicMatchPushdown( [], 0, context )).toBeNull();
        expect( proveHeuristicMatchPushdown([ { $match: { a: 1 } } ], 0, context )).toBeNull();
        expect( proveHeuristicMatchPushdown([ { $match: { a: 1 } }, { $sort: { a: 1 } } ], 1, context )).toBeNull();
        expect( pass.execute([ { $sort: { a: 1 } } ], context )).toEqual([ { $sort: { a: 1 } } ]);
    });
});
