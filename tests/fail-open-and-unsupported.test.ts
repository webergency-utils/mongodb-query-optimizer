import { describe, expect, it } from 'vitest';
import { optimizeFilter, optimizePipeline } from '../src/index.js';
import { analyzeExpression } from '../src/analyzer/expressions.js';
import { analyzeFilter } from '../src/analyzer/filters.js';
import { analyzeStage } from '../src/analyzer/semantics.js';

describe( 'Fail-Open Safety and Unsupported Operators/Stages', () =>
{
    describe( 'Fail-Open Safety: Optimizer never throws', () =>
    {
        it( 'handles null, undefined, primitives, and non-array pipeline inputs safely', () =>
        {
            expect( optimizePipeline( null as any )).toBeNull();
            expect( optimizePipeline( undefined as any )).toBeUndefined();
            expect( optimizePipeline( 42 as any )).toBe( 42 );
            expect( optimizePipeline( 'invalid string' as any )).toBe( 'invalid string' );
            expect( optimizePipeline( { $match: { a: 1 } } as any )).toEqual( { $match: { a: 1 } } );
        });

        it( 'handles null, undefined, primitives, and non-plain-object filter inputs safely', () =>
        {
            expect( optimizeFilter( null as any )).toBeNull();
            expect( optimizeFilter( undefined as any )).toBeUndefined();
            expect( optimizeFilter( 42 as any )).toBe( 42 );
            expect( optimizeFilter( 'hello' as any )).toBe( 'hello' );
            expect( optimizeFilter( [ { a: 1 } ] as any )).toEqual( [ { a: 1 } ] );
        });

        it( 'never throws when pipeline stages contain throwing getters (fail-open)', () =>
        {
            const malformedStage = {
                get $match()
                {
                    throw new Error( 'Simulated critical AST traversal failure' );
                }
            };
            const pipeline = [ { $match: { a: 1 } }, malformedStage ];

            expect( () => optimizePipeline( pipeline )).not.toThrow();
            const result = optimizePipeline( pipeline );
            expect( result ).toBe( pipeline );
        });

        it( 'never throws when filter contains throwing properties (fail-open)', () =>
        {
            const malformedFilter = {
                get status()
                {
                    throw new Error( 'Simulated filter evaluation failure' );
                }
            };

            expect( () => optimizeFilter( malformedFilter )).not.toThrow();
            const result = optimizeFilter( malformedFilter );
            expect( result ).toBe( malformedFilter );
        });

        it( 'handles circular / self-referencing pipelines safely without infinite recursion', () =>
        {
            const circularPipeline: any[] = [ { $match: { status: 'active' } } ];
            circularPipeline.push( circularPipeline );

            expect( () => optimizePipeline( circularPipeline )).not.toThrow();
            const result = optimizePipeline( circularPipeline );
            expect( Array.isArray( result )).toBe( true );
            expect( result.length ).toBe( 2 );
        });

        it( 'handles circular / self-referencing filters safely without infinite recursion', () =>
        {
            const circularFilter: any = { a: 1 };
            circularFilter.self = circularFilter;

            expect( () => optimizeFilter( circularFilter )).not.toThrow();
            const result = optimizeFilter( circularFilter );
            expect( typeof result ).toBe( 'object' );
            expect( result.a ).toBe( 1 );
        });
    });

    describe( 'Unsupported Pipeline Stages: Hard opaque barrier', () =>
    {
        it( 'cannot sift match stages across an unsupported custom pipeline stage', () =>
        {
            const pipeline = [
                { $match: { first: 'yes' } },
                { $customUnsupportedStage: { prop: '$foreignValue' } },
                { $match: { second: 'yes' } }
            ];

            const optimized = optimizePipeline( pipeline );

            // Both match stages must remain separated by the unsupported stage
            expect( optimized ).toEqual( [
                { $match: { first: 'yes' } },
                { $customUnsupportedStage: { prop: '$foreignValue' } },
                { $match: { second: 'yes' } }
            ] );
        });

        it( 'cannot merge consecutive matches across an unsupported stage', () =>
        {
            const pipeline = [
                { $match: { a: 1 } },
                { $atlasSearch: { index: 'default' } },
                { $match: { b: 2 } }
            ];

            const optimized = optimizePipeline( pipeline );

            expect( optimized ).toEqual( [
                { $match: { a: 1 } },
                { $atlasSearch: { index: 'default' } },
                { $match: { b: 2 } }
            ] );
        });

        it( 'cannot push sort/limit across an unsupported stage', () =>
        {
            const pipeline = [
                { $addFields: { score: 100 } },
                { $customVectorSearch: { query: 'test' } },
                { $sort: { score: -1 } },
                { $limit: 10 }
            ];

            const optimized = optimizePipeline( pipeline );

            expect( optimized ).toEqual( pipeline );
        });
    });

    describe( 'Unsupported Operators: Treated as non-deterministic while computing dependencies', () =>
    {
        it( 'treats unsupported expression operator as volatile and preserves field and variable dependencies', () =>
        {
            const summary = analyzeExpression({
                $customDistance: [ '$user.location.coords', '$targetPoint' ]
            });

            expect( summary.determinism ).toBe( 'volatile' );
            expect( summary.errors ).toBe( 'may-error' );
            expect( summary.unknown ).toBe( true );
            expect( summary.dependencies.local ).toEqual( new Set([ 'user.location.coords', 'targetPoint' ]) );
            expect( summary.dependencies.unknown ).toBe( false );
            expect( summary.dependencies.local.has( '*' )).toBe( false );

            const summaryWithVar = analyzeExpression(
                { $customDistance: [ '$user.location.coords', '$$target' ] },
                {
                    documentScope: 'local',
                    variables: new Map([[ 'target', { scope: 'local', path: 'targetPoint' } ]])
                }
            );
            expect( summaryWithVar.determinism ).toBe( 'volatile' );
            expect( summaryWithVar.errors ).toBe( 'may-error' );
            expect( summaryWithVar.dependencies.variables.has( 'target' )).toBe( true );
            expect( summaryWithVar.dependencies.local ).toEqual( new Set([ 'user.location.coords', 'targetPoint' ]) );
        });

        it( 'treats unsupported field filter operator as volatile and preserves dependencies', () =>
        {
            const summary = analyzeFilter({
                coordinates: {
                    $customGeoWithin: '$searchArea'
                }
            });

            expect( summary.determinism ).toBe( 'volatile' );
            expect( summary.errors ).toBe( 'may-error' );
            expect( summary.unknown ).toBe( true );
            expect( summary.dependencies.local ).toEqual( new Set([ 'coordinates', 'searchArea' ]) );
            expect( summary.dependencies.local.has( '*' )).toBe( false );
        });

        it( 'treats unsupported top-level filter operator as volatile and preserves dependencies', () =>
        {
            const summary = analyzeFilter({
                $customTopLevelMatch: [ '$age', '$minAge' ]
            });

            expect( summary.determinism ).toBe( 'volatile' );
            expect( summary.errors ).toBe( 'may-error' );
            expect( summary.unknown ).toBe( true );
            expect( summary.dependencies.local ).toEqual( new Set([ 'age', 'minAge' ]) );
            expect( summary.dependencies.local.has( '*' )).toBe( false );
        });

        it( 'preserves dependencies in stage semantics for unsupported pipeline stages', () =>
        {
            const semantics = analyzeStage({
                $customTransform: {
                    source: '$profile.avatar',
                    auth: '$$CURRENT_USER'
                }
            });

            expect( semantics.unknown ).toBe( true );
            expect( semantics.cardinality ).toBe( 'unknown' );
            expect( semantics.order ).toBe( 'unknown' );
            expect( semantics.writes ).toEqual( new Set([ '?' ]) );
            expect( semantics.modifies ).toEqual( new Set([ '?' ]) );
        });
    });
});
