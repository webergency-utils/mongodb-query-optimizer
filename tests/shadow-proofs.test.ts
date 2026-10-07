import { describe, expect, it } from 'vitest';
import { resolvePipelineGuarantees } from '../src/guarantees.js';
import
{
    allocateShadowFieldName,
    findShadowTargetIndex,
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
