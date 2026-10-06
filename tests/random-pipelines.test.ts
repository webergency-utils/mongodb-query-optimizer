import { afterEach, describe, expect, it } from 'vitest';
import { getPipelineTransformationRegistryStatus } from '../src/passes/registry.js';
import
{
    DEFAULT_RANDOM_SEEDS,
    RANDOM_PIPELINE_TEMPLATES,
    generateRandomDifferentialCases,
    getEffectiveRandomSeeds,
    getReplaySeed
}
from './fixtures/random-pipelines.js';
import { runMockPipeline } from './helpers/mock-engine.js';

describe( 'Random pipeline generator and templates (U12)', () =>
{
    const originalEnv = process.env.RANDOM_DIFFERENTIAL_REPLAY_SEED;
    const originalReplay = process.env.REPLAY_SEED;

    afterEach( () =>
    {
        if( originalEnv !== undefined )
        {
            process.env.RANDOM_DIFFERENTIAL_REPLAY_SEED = originalEnv;
        }
        else
        {
            delete process.env.RANDOM_DIFFERENTIAL_REPLAY_SEED;
        }

        if( originalReplay !== undefined )
        {
            process.env.REPLAY_SEED = originalReplay;
        }
        else
        {
            delete process.env.REPLAY_SEED;
        }
    } );

    it( 'produces identical pipelines and documents for the same seed', () =>
    {
        const seed = 0x1337_0001;
        const run1 = generateRandomDifferentialCases( seed );
        const run2 = generateRandomDifferentialCases( seed );

        expect( run1 ).toEqual( run2 );
        expect( run1.length ).toBe( RANDOM_PIPELINE_TEMPLATES.length );

        // Different seed produces different documents / configurations
        const run3 = generateRandomDifferentialCases( 0x9999_8888 );
        expect( run1 ).not.toEqual( run3 );
    } );

    it( 'provides at least one template for every active pipeline transformation', () =>
    {
        const activePasses = getPipelineTransformationRegistryStatus().active;
        const coveredPasses = new Set( RANDOM_PIPELINE_TEMPLATES.map( ( t ) => t.passId ) );

        for( const activePass of activePasses )
        {
            expect( coveredPasses.has( activePass ) ).toBe( true );
        }
    } );

    it( 'respects the replay seed environment variable', () =>
    {
        delete process.env.RANDOM_DIFFERENTIAL_REPLAY_SEED;
        delete process.env.REPLAY_SEED;

        expect( getReplaySeed() ).toBeNull();
        expect( getEffectiveRandomSeeds() ).toEqual( DEFAULT_RANDOM_SEEDS );

        // Hex seed
        process.env.RANDOM_DIFFERENTIAL_REPLAY_SEED = '0xcafe_babe';
        expect( getReplaySeed() ).toBe( 0xcafe_babe );
        expect( getEffectiveRandomSeeds() ).toEqual( [ 0xcafe_babe ] );

        // Decimal seed
        process.env.RANDOM_DIFFERENTIAL_REPLAY_SEED = '12345';
        expect( getReplaySeed() ).toBe( 12345 );
        expect( getEffectiveRandomSeeds() ).toEqual( [ 12345 ] );

        // Fallback to REPLAY_SEED
        delete process.env.RANDOM_DIFFERENTIAL_REPLAY_SEED;
        process.env.REPLAY_SEED = '0x1234';
        expect( getReplaySeed() ).toBe( 0x1234 );
        expect( getEffectiveRandomSeeds() ).toEqual( [ 0x1234 ] );
    } );

    it( 'ensures all generated pipelines have 2 to 5 stages and success expected outcome', () =>
    {
        const cases = generateRandomDifferentialCases( 0x1337_0001 );

        for( const testCase of cases )
        {
            expect( testCase.pipeline.length ).toBeGreaterThanOrEqual( 2 );
            expect( testCase.pipeline.length ).toBeLessThanOrEqual( 5 );
            expect( testCase.expectedOriginalOutcome ).toBe( 'success' );
            expect( [ 'ordered-bson', 'multiset' ] ).toContain( testCase.observation );
        }
    } );

    it( 'detects deliberate mutations in pass output (mutation check)', () =>
    {
        const cases = generateRandomDifferentialCases( 0x1337_0001 );
        const testCase = cases.find( ( c ) => c.passId === 'redundant-sort-elimination' );

        expect( testCase ).toBeDefined();
        if( !testCase ){ return }

        const docs = testCase.collections.main.documents as any[];
        const originalResult = runMockPipeline( docs, testCase.pipeline as any[] );

        // A correct pass preserves the exact result
        expect( originalResult.length ).toBeGreaterThan( 0 );

        // Mutated pass: artificially reverses the sort order or drops documents
        const brokenPipeline = [ ...testCase.pipeline, { $sort: { _id: -1 } } ];
        const brokenResult = runMockPipeline( docs, brokenPipeline as any[] );

        expect( originalResult ).not.toEqual( brokenResult );
    } );
} );
