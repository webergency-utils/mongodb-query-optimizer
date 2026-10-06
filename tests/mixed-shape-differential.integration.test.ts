import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { optimizePipeline, type OptimizerOptions } from '../src/index.js';
import {
    mixedShapeDifferentialCases,
    type MixedShapeDifferentialCase,
} from './fixtures/mixed-shape-cases.js';
import {
    MongoDifferentialOracle,
    oraclePolicyFromOptions,
    type MongoDifferentialCase,
    validateMongoOracleEnvironment,
} from './helpers/mongodb-oracle.js';

function materializeMixedShapeCase(
    testCase: MixedShapeDifferentialCase,
    options: OptimizerOptions = {},
): MongoDifferentialCase
{
    const optimized = optimizePipeline( testCase.pipeline as any[], options );
    const policy = oraclePolicyFromOptions( options );

    return {
        id: `${testCase.id}-${options.strictFieldOrder ? 'sfo' : options.strictErrors ? 'se' : 'def'}`,
        mainCollectionId: testCase.mainCollectionId,
        collections: testCase.collections,
        original: {
            kind: 'aggregate',
            pipeline: testCase.pipeline,
        },
        optimized: {
            kind: 'aggregate',
            pipeline: optimized,
        },
        observation: testCase.observation,
        policy,
        expectedOriginalOutcome: testCase.expectedOriginalOutcome,
        originalForm: testCase.pipeline,
        optimizedForm: optimized,
    };
}

describe.sequential( 'MongoDB 8 mixed-shape differential matrix', () =>
{
    let oracle: MongoDifferentialOracle;

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
    } );

    for( const testCase of mixedShapeDifferentialCases )
    {
        // 1. Default mode
        const defaultFails = testCase.knownBugModes?.includes( 'default' );
        const defaultRunner = defaultFails ? it.fails : it;
        defaultRunner( `${defaultFails ? 'detects known bug' : 'verifies'} in default mode: ${testCase.id}`, async () =>
        {
            const result = await oracle.compare( materializeMixedShapeCase( testCase, {} ) );
            expect( result.equal ).toBe( true );
        } );

        // 2. Strict field order mode
        const sfoFails = testCase.knownBugModes?.includes( 'strictFieldOrder' );
        const sfoRunner = sfoFails ? it.fails : it;
        sfoRunner( `${sfoFails ? 'detects known bug' : 'verifies'} in strictFieldOrder mode: ${testCase.id}`, async () =>
        {
            const result = await oracle.compare(
                materializeMixedShapeCase( testCase, { strictFieldOrder: true } ),
            );
            expect( result.equal ).toBe( true );
        } );

        // 3. Strict errors mode
        const seFails = testCase.knownBugModes?.includes( 'strictErrors' );
        const seRunner = seFails ? it.fails : it;
        seRunner( `${seFails ? 'detects known bug' : 'verifies'} in strictErrors mode: ${testCase.id}`, async () =>
        {
            const result = await oracle.compare(
                materializeMixedShapeCase( testCase, { strictErrors: true } ),
            );
            expect( result.equal ).toBe( true );
        } );
    }
} );
