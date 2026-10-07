import { describe, expect, it } from 'vitest';
import { resolvePipelineGuarantees } from '../src/guarantees.js';
import
{
    allocateShadowFieldName,
    collectExpressionDependencies,
    findShadowTargetIndex,
    isExpressionCompletelyDeterministic,
    rangeHasCostlyStage,
    resolveShadowProviders,
    validateShadowRange
}
from '../src/passes/shadow-proofs.js';

describe( 'shadow-proofs shared gates', () =>
{
    const context = resolvePipelineGuarantees( [], {} );

    it( 'lets the target scan and range validation cross filters only when allowed', () =>
    {
        const pipeline = [
            { $lookup: { from: 'extra', localField: '_id', foreignField: 'ref', as: 'extra' } },
            { $match: { active: true } },
            { $addFields: { k: { $size: '$tags' } } },
            { $match: { k: { $gt: 0 } } },
        ];
        const providers = resolveShadowProviders( pipeline, 3, [ 'k' ], context )!;

        expect( providers.computed.get( 'k' )!.providerIndex ).toBe( 2 );
        expect( findShadowTargetIndex( pipeline, providers, context, false )).toBeNull();
        expect( findShadowTargetIndex( pipeline, providers, context, true )).toBe( 0 );
        expect( validateShadowRange( pipeline, 0, 3, providers, context, false )).toBe( false );
        expect( validateShadowRange( pipeline, 0, 3, providers, context, true )).toBe( true );
    });

    it( 'finds no costly stage in a range of cheap stages with non-object specs', () =>
    {
        const pipeline = [
            { $unset: 'old' },
            { $addFields: { k: { $size: '$tags' } } },
            { $sort: { k: 1 } },
        ];
        const providers = resolveShadowProviders( pipeline, 2, [ 'k' ], context )!;

        expect( rangeHasCostlyStage( pipeline, 0, 2, providers )).toBe( false );
    });

    it( 'allocates collision-free shadow names', () =>
    {
        const pipeline = [ { $addFields: { __heuristic_k: 1 } } ];

        expect( allocateShadowFieldName( pipeline, 'k', new Set())).toBe( '__heuristic_k_0' );
        expect( allocateShadowFieldName( [], 'a-b', new Set([ '__heuristic_a_b' ]))).toBe( '__heuristic_a_b_0' );
    });
});

describe( 'shadow-proofs determinism by $function substitution', () =>
{
    const fn = ( body: string, args: unknown[] = [ '$a' ], lang: unknown = 'js' ): Record<string, unknown> => ( {
        $function: { body: `function( x ) { ${ body } }`, args, lang }
    } );

    it( 'rejects every extended non-deterministic token in a function body', () =>
    {
        for( const body of [
            'return ObjectId();',
            'return UUID();',
            'return globalThis.x;',
            'return this.x;',
            "return Math['random']();",
            'return eval( "1" );',
            'return new Function( "return 1" )();',
            'setTimeout( () => 1, 0 ); return 1;',
            'return Date.now();',
            'return Math.random();',
            'return crypto.randomUUID();',
            'return performance.now();',
        ])
        {
            expect( isExpressionCompletelyDeterministic( fn( body ))).toBe( false );
        }

        expect( isExpressionCompletelyDeterministic( fn( 'return x * 2;' ))).toBe( true );
    });

    it( 'requires lang js and a well-formed function spec', () =>
    {
        expect( isExpressionCompletelyDeterministic( fn( 'return x;', [ '$a' ], 'python' ))).toBe( false );
        expect( isExpressionCompletelyDeterministic({ $function: { body: 'return 1;', args: [ '$a' ] } })).toBe( false );
        expect( isExpressionCompletelyDeterministic({ $function: { body: 123, args: [], lang: 'js' } })).toBe( false );
        expect( isExpressionCompletelyDeterministic({ $function: { body: 'return 1;', args: null, lang: 'js' } })).toBe( false );
        expect( isExpressionCompletelyDeterministic({ $function: null })).toBe( false );
        expect( collectExpressionDependencies({ $function: null })).toEqual( new Set());
    });

    it( 'accepts a deterministic $function nested inside another expression', () =>
    {
        const nested = { $cond: [ true, fn( 'return x;', [ '$score', '$meta.rank' ] ), 0 ] };

        expect( isExpressionCompletelyDeterministic( nested )).toBe( true );
        expect( collectExpressionDependencies( nested )).toEqual( new Set([ 'score', 'meta.rank' ]));
    });

    it( 'keeps $$this scoped inside $map when a $function argument reads it', () =>
    {
        const mapped = { $map: { input: '$items', in: fn( 'return x;', [ '$$this.x' ] ) } };
        const dependencies = collectExpressionDependencies( mapped );

        expect( isExpressionCompletelyDeterministic( mapped )).toBe( true );
        expect( dependencies.has( 'items' )).toBe( true );
        expect([ ...dependencies ].some(( path ) => path === 'this' || path.startsWith( 'this.' ) || path === '*' )).toBe( false );
    });

    it( 'rejects nested non-deterministic bodies and whole-document arguments', () =>
    {
        expect( isExpressionCompletelyDeterministic({ $add: [ fn( 'return Date.now();' ), 1 ] })).toBe( false );
        expect( isExpressionCompletelyDeterministic({ $add: [ fn( 'return 1;', [ { $ifNull: [ '$$ROOT', 1 ] } ] ), 1 ] })).toBe( false );
        expect( isExpressionCompletelyDeterministic({ $add: [ fn( 'return 1;', [ { $rand: {} } ] ), 1 ] })).toBe( false );
    });

    it( 'rejects any $function under strictErrors but treats a $literal as data', () =>
    {
        expect( isExpressionCompletelyDeterministic({ $add: [ fn( 'return x;' ), 1 ] }, true )).toBe( false );
        expect( isExpressionCompletelyDeterministic({ $literal: fn( 'return Date.now();' ) }, true )).toBe( true );
        expect( collectExpressionDependencies({ $literal: fn( 'return x;' ) })).toEqual( new Set());
    });
});
