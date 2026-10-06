import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OptimizerOptions } from '../src/index.js';
import { optimizePipelineWithCandidateProfile } from '../src/passes/registry.js';
import
{
    RANDOM_PIPELINE_TEMPLATES,
    type RandomDifferentialCase,
    generateRandomDifferentialCases,
    getEffectiveRandomSeeds
}
from './fixtures/random-pipelines.js';
import
{
    MongoDifferentialOracle,
    type MongoDifferentialCase,
    oraclePolicyFromOptions,
    validateMongoOracleEnvironment
}
from './helpers/mongodb-oracle.js';

function materializeRandomCase(
    testCase: RandomDifferentialCase,
    options: OptimizerOptions = {}
): MongoDifferentialCase
{
    const optimized = optimizePipelineWithCandidateProfile(
        testCase.pipeline as any[],
        [ testCase.passId ],
        undefined,
        options
    );
    const policy = oraclePolicyFromOptions( options );
    const modeTag = options.strictFieldOrder && options.strictErrors
        ? 'both'
        : options.strictFieldOrder
            ? 'sfo'
            : options.strictErrors
                ? 'se'
                : 'def';

    return {
        id: `${testCase.id}-${modeTag}`,
        mainCollectionId: testCase.mainCollectionId,
        collections: testCase.collections,
        original: {
            kind: 'aggregate',
            pipeline: testCase.pipeline
        },
        optimized: {
            kind: 'aggregate',
            pipeline: optimized
        },
        observation: testCase.observation,
        policy,
        expectedOriginalOutcome: testCase.expectedOriginalOutcome,
        originalForm: testCase.pipeline,
        optimizedForm: optimized
    };
}

describe.sequential( 'MongoDB 8 seeded random differential run (U12)', () =>
{
    let oracle: MongoDifferentialOracle;
    const successfulPasses = new Set<string>();
    const effectiveSeeds = getEffectiveRandomSeeds();

    beforeAll( async () =>
    {
        try
        {
            if( typeof process.loadEnvFile === 'function' )
            {
                process.loadEnvFile();
            }
        }
        catch
        {
            // .env is optional when environment variables are supplied directly
        }

        const configuration = validateMongoOracleEnvironment( process.env );
        oracle = new MongoDifferentialOracle( configuration );
        await oracle.connect();
    } );

    afterAll( async () =>
    {
        if( oracle )
        {
            await oracle.cleanup();
            await oracle.close();
        }

        // Verify that every template produced at least one successful original
        for( const template of RANDOM_PIPELINE_TEMPLATES )
        {
            expect(
                successfulPasses.has( template.passId ),
                `Template for ${template.passId} never produced a successful original run`
            ).toBe( true );
        }
    } );

    const modes: Array<{ name: string; options: OptimizerOptions }> = [
        { name: 'default', options: {} },
        { name: 'strictFieldOrder', options: { strictFieldOrder: true } },
        { name: 'strictErrors', options: { strictErrors: true } },
        { name: 'bothStrict', options: { strictFieldOrder: true, strictErrors: true } }
    ];

    for( const seed of effectiveSeeds )
    {
        const cases = generateRandomDifferentialCases( seed );

        describe( `Seed 0x${seed.toString( 16 )}`, () =>
        {
            for( const testCase of cases )
            {
                for( const mode of modes )
                {
                    it( `verifies ${testCase.passId} [case ${testCase.caseIndex}] in ${mode.name} mode`, async () =>
                    {
                        const differentialCase = materializeRandomCase( testCase, mode.options );
                        const result = await oracle.compare( differentialCase );

                        if( !result.equal )
                        {
                            console.error(
                                `Mismatch on seed 0x${seed.toString( 16 )}, caseIndex ${testCase.caseIndex} (${testCase.passId}) in ${mode.name} mode:`,
                                JSON.stringify( { original: result.original, optimized: result.optimized }, null, 2 )
                            );
                        }

                        if( result.original.status === 'success' )
                        {
                            successfulPasses.add( testCase.passId );
                        }

                        expect( result.equal ).toBe( true );
                    } );
                }
            }
        } );
    }
} );
