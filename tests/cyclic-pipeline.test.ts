import { describe, expect, it } from 'vitest';
import { analyzePipeline } from '../src/analyzer/semantics.js';
import { pipelineReadsFieldOrder } from '../src/passes/guarantee-guards.js';
import { optimizePipeline } from './helpers/pre-gate-optimizer.js';

function cyclicLookupPipeline(): any[]
{
    const pipeline: any[] =
    [
        {
            $lookup:
            {
                from: 'foreign',
                as: 'joined',
                localField: 'id',
                foreignField: 'id',
                pipeline: []
            }
        }
    ];

    pipeline[ 0 ].$lookup.pipeline = pipeline;

    return pipeline;
}

describe( 'cyclic pipelines', () =>
{
    it( 'stops when a lookup pipeline points at itself', () =>
    {
        const pipeline = cyclicLookupPipeline();
        const optimized = optimizePipeline( pipeline );
        const summary = analyzePipeline( pipeline );

        expect( optimized ).toBe( pipeline );
        expect( summary.unknown ).toBe( true );
        expect( summary.malformed ).toBe( true );
        expect( summary.stages ).toHaveLength( 1 );
        expect( summary.stages[ 0 ]!.children[ 0 ]!.summary.stages ).toHaveLength( 0 );
        expect( pipelineReadsFieldOrder( pipeline )).toBe( false );
    });

    it( 'stops and leaves pipeline unoptimized when a cycle is present', () =>
    {
        const pipeline = cyclicLookupPipeline();

        pipeline.unshift(
            { $match: { a: { $eq: 1 } } },
            { $match: { b: 1 } }
        );
        pipeline[ 2 ].$lookup.pipeline = pipeline;

        const optimized = optimizePipeline( pipeline );

        expect( optimized ).toBe( pipeline );
        expect( pipelineReadsFieldOrder( pipeline )).toBe( false );
    });

    it( 'stops when a facet branch points at its parent pipeline', () =>
    {
        const pipeline: any[] =
        [
            {
                $facet:
                {
                    branch: []
                }
            }
        ];

        pipeline[ 0 ].$facet.branch = pipeline;

        const optimized = optimizePipeline( pipeline );
        const summary = analyzePipeline( pipeline );

        expect( optimized ).toBe( pipeline );
        expect( summary.unknown ).toBe( true );
        expect( summary.malformed ).toBe( true );
        expect( summary.stages ).toHaveLength( 1 );
        expect( summary.stages[ 0 ]!.children[ 0 ]!.summary.stages ).toHaveLength( 0 );
        expect( pipelineReadsFieldOrder( pipeline )).toBe( false );
    });

    it( 'stops when a unionWith pipeline points at its parent pipeline', () =>
    {
        const pipeline: any[] =
        [
            {
                $unionWith:
                {
                    coll: 'other',
                    pipeline: []
                }
            }
        ];

        pipeline[ 0 ].$unionWith.pipeline = pipeline;

        const optimized = optimizePipeline( pipeline );
        const summary = analyzePipeline( pipeline );

        expect( optimized ).toBe( pipeline );
        expect( summary.unknown ).toBe( true );
        expect( summary.malformed ).toBe( true );
        expect( summary.stages ).toHaveLength( 1 );
        expect( summary.stages[ 0 ]!.children[ 0 ]!.summary.stages ).toHaveLength( 0 );
        expect( pipelineReadsFieldOrder( pipeline )).toBe( false );
    });

    it( 'marks a cyclic lookup pipeline unknown and malformed instead of walking it again', () =>
    {
        const pipeline = cyclicLookupPipeline();
        const summary = analyzePipeline( pipeline );

        expect( summary.unknown ).toBe( true );
        expect( summary.malformed ).toBe( true );
        expect( summary.stages ).toHaveLength( 1 );
        expect( summary.stages[ 0 ]!.malformed ).toBe( true );
        expect( summary.stages[ 0 ]!.children[ 0 ]!.summary.unknown ).toBe( true );
        expect( summary.stages[ 0 ]!.children[ 0 ]!.summary.malformed ).toBe( true );
        expect( summary.stages[ 0 ]!.children[ 0 ]!.summary.stages ).toHaveLength( 0 );
        expect( pipelineReadsFieldOrder( pipeline )).toBe( false );
    });

    it( 'still optimizes an acyclic lookup subpipeline', () =>
    {
        const optimized = optimizePipeline(
        [
            {
                $lookup:
                {
                    from: 'foreign',
                    as: 'joined',
                    localField: 'id',
                    foreignField: 'id',
                    pipeline:
                    [
                        { $match: { a: { $eq: 1 } } }
                    ]
                }
            }
        ]);

        expect( optimized ).toEqual(
        [
            {
                $lookup:
                {
                    from: 'foreign',
                    as: 'joined',
                    localField: 'id',
                    foreignField: 'id',
                    pipeline:
                    [
                        { $match: { a: 1 } }
                    ]
                }
            }
        ]);
    });
});
