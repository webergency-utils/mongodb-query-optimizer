import { describe, expect, it } from 'vitest';
import { optimizeFilter, optimizePipeline } from '../src/index.js';
import { optimizeFilterWithRulesForTesting } from '../src/filter-optimizer.js';
import { FilterRule } from '../src/filter-rule-registry.js';
import
{
    DEFAULT_GUARANTEE_CONTEXT,
    GuaranteeContext,
    hasWriteStage,
    resolveFilterGuarantees,
    resolvePipelineGuarantees
}
from '../src/guarantees.js';
import { optimizePipelineWithPasses } from '../src/passes/registry.js';
import { PipelinePass } from '../src/passes/types.js';

class RecordingPass implements PipelinePass
{
    readonly name = 'recording';
    readonly seen: Array<{ readonly stages: string[], readonly context: GuaranteeContext }> = [];

    execute( pipeline: any[], context: GuaranteeContext ): any[]
    {
        this.seen.push({ stages: pipeline.map(( stage ) => Object.keys( stage )[ 0 ]), context });

        return pipeline;
    }
}

function recordContexts( pipeline: any[], options?: Parameters<typeof optimizePipeline>[ 1 ] )
{
    const pass = new RecordingPass();

    optimizePipelineWithPasses( pipeline, [ pass ], undefined, options );

    return pass.seen;
}

describe( 'guarantee options resolution', () =>
{
    it( 'defaults both flags to false and reuses the frozen default context', () =>
    {
        expect( resolvePipelineGuarantees([])).toBe( DEFAULT_GUARANTEE_CONTEXT );
        expect( resolvePipelineGuarantees( [], {} )).toBe( DEFAULT_GUARANTEE_CONTEXT );
        expect( DEFAULT_GUARANTEE_CONTEXT ).toEqual({ strictFieldOrder: false, strictErrors: false });
        expect( Object.isFrozen( DEFAULT_GUARANTEE_CONTEXT )).toBe( true );
    });

    it( 'passes caller flags through unchanged and freezes the result', () =>
    {
        const both = resolvePipelineGuarantees( [], { strictFieldOrder: true, strictErrors: true });

        expect( both ).toEqual({ strictFieldOrder: true, strictErrors: true });
        expect( Object.isFrozen( both )).toBe( true );
        expect( resolvePipelineGuarantees( [], { strictFieldOrder: true })).toEqual({ strictFieldOrder: true, strictErrors: false });
        expect( resolvePipelineGuarantees( [], { strictErrors: true })).toEqual({ strictFieldOrder: false, strictErrors: true });
    });

    it( 'forces strict errors for top-level $merge and $out even when the caller disables it', () =>
    {
        const merge = [ { $match: { a: 1 } }, { $merge: { into: 'target' } } ];
        const out = [ { $match: { a: 1 } }, { $out: 'target' } ];

        expect( resolvePipelineGuarantees( merge, { strictErrors: false })).toEqual({ strictFieldOrder: false, strictErrors: true });
        expect( resolvePipelineGuarantees( out )).toEqual({ strictFieldOrder: false, strictErrors: true });
        expect( resolvePipelineGuarantees( out, { strictFieldOrder: true })).toEqual({ strictFieldOrder: true, strictErrors: true });
    });

    it( 'inspects only the top level for write stages', () =>
    {
        const nested = [ { $lookup: { from: 'x', as: 'y', pipeline: [ { $merge: { into: 'target' } } ] } } ];

        expect( hasWriteStage( nested )).toBe( false );
        expect( hasWriteStage( 'not-a-pipeline' )).toBe( false );
        expect( hasWriteStage([ null, 1, [ { $out: 'x' } ] ])).toBe( false );
        expect( resolvePipelineGuarantees( nested )).toBe( DEFAULT_GUARANTEE_CONTEXT );
    });

    it( 'ignores strictFieldOrder for filters', () =>
    {
        expect( resolveFilterGuarantees()).toBe( DEFAULT_GUARANTEE_CONTEXT );
        expect( resolveFilterGuarantees({ strictFieldOrder: true })).toBe( DEFAULT_GUARANTEE_CONTEXT );
        expect( resolveFilterGuarantees({ strictErrors: true })).toEqual({ strictFieldOrder: false, strictErrors: true });
    });
});

describe( 'guarantee context plumbing', () =>
{
    it( 'delivers the default context to passes when no options are given', () =>
    {
        const seen = recordContexts([ { $match: { a: 1 } } ]);

        expect( seen[ 0 ].context ).toBe( DEFAULT_GUARANTEE_CONTEXT );
    });

    it( 'delivers caller flags unchanged', () =>
    {
        const seen = recordContexts( [ { $match: { a: 1 } } ], { strictFieldOrder: true, strictErrors: false });

        expect( seen[ 0 ].context ).toEqual({ strictFieldOrder: true, strictErrors: false });
    });

    it( 'covers AE6: a $merge pipeline delivers strictErrors even when the caller passes false', () =>
    {
        const merge = recordContexts( [ { $match: { a: 1 } }, { $merge: { into: 't' } } ], { strictErrors: false });
        const out = recordContexts([ { $match: { a: 1 } }, { $out: 't' } ]);

        expect( merge[ 0 ].context.strictErrors ).toBe( true );
        expect( out[ 0 ].context.strictErrors ).toBe( true );
    });

    it( 'delivers the same context inside $lookup, $facet and $unionWith sub-pipelines', () =>
    {
        const seen = recordContexts(
            [
                { $lookup: { from: 'x', as: 'y', pipeline: [ { $limit: 1 } ] } },
                { $facet: { left: [ { $skip: 1 } ], right: [ { $count: 'n' } ], invalid: 'not-a-pipeline' } },
                { $unionWith: { coll: 'z', pipeline: [ { $sample: { size: 1 } } ] } },
                { $merge: { into: 't' } }
            ],
            { strictFieldOrder: true }
        );
        const contexts = new Set( seen.map(( entry ) => entry.context ));
        const levels = seen.map(( entry ) => entry.stages.join( ',' ));

        expect( contexts.size ).toBe( 1 );
        expect([ ...contexts ][ 0 ]).toEqual({ strictFieldOrder: true, strictErrors: true });
        expect( levels ).toEqual( expect.arrayContaining([ '$limit', '$skip', '$count', '$sample' ]));
    });

    it( 'keeps public results unchanged with no options and with an empty options object', () =>
    {
        const pipeline = [ { $match: { a: 1 } }, { $match: { b: 2 } }, { $limit: 10 }, { $limit: 5 } ];

        expect( optimizePipeline( pipeline, {} )).toEqual( optimizePipeline( pipeline ));
        expect( optimizeFilter( { $and: [ { a: 1 }, { b: 2 } ] }, {} )).toEqual( optimizeFilter({ $and: [ { a: 1 }, { b: 2 } ] }));
    });

    it( 'treats strictFieldOrder as a no-op for optimizeFilter', () =>
    {
        const filter = { $and: [ { a: { $in: [ 1 ] } }, { b: 2 } ] };

        expect( optimizeFilter( filter, { strictFieldOrder: true })).toEqual( optimizeFilter( filter ));
    });

    it( 'returns non-array pipeline input unchanged', () =>
    {
        const input: any = { not: 'a pipeline' };

        expect( optimizePipeline( input, { strictErrors: true })).toBe( input );
    });

    it( 'delivers the resolved filter context to every filter rule, including nested sweeps', () =>
    {
        const contexts: GuaranteeContext[] = [];
        const rule = { id: 'simplify-equality', apply: ( filter: any, context: GuaranteeContext ) =>
        {
            contexts.push( context );

            return filter;
        } } as FilterRule;

        optimizeFilterWithRulesForTesting( { $or: [ { a: 1 } ], b: { $not: { $eq: 1 } } }, [ rule ], undefined, { strictErrors: true });

        expect( contexts.length ).toBeGreaterThan( 1 );
        expect( contexts.every(( context ) => context.strictErrors && !context.strictFieldOrder )).toBe( true );
    });
});
