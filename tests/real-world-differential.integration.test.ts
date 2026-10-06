import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { optimizePipeline, type OptimizerOptions } from '../src/index.js';
import { buildRealWorldDataset } from './fixtures/real-world/data.js';
import {
    MongoDifferentialOracle,
    oraclePolicyFromOptions,
    type MongoDifferentialCase,
    validateMongoOracleEnvironment
} from './helpers/mongodb-oracle.js';

describe.sequential( 'MongoDB 8 real-world differential matrix', () =>
{
    let oracle: MongoDifferentialOracle;

    const testQuery = JSON.parse(
        fs.readFileSync( path.resolve( __dirname, 'fixtures/real-world/test-query.json' ), 'utf8' )
    );
    const testFullQuery = JSON.parse(
        fs.readFileSync( path.resolve( __dirname, 'fixtures/real-world/test-full-query.json' ), 'utf8' )
    );

    const dataset = buildRealWorldDataset( { count: 20 } );
    const collections =
    {
        jobs:
        {
            documents: dataset.jobs
        },
        briefings:
        {
            documents: dataset.briefings
        },
        placements:
        {
            documents: dataset.placements
        }
    };

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

    function createDifferentialCase(
        id: string,
        pipeline: any[],
        options: OptimizerOptions
    ): MongoDifferentialCase
    {
        const optimized = optimizePipeline( pipeline, options );
        const policy = oraclePolicyFromOptions( options );

        return {
            id,
            mainCollectionId: 'jobs',
            collections,
            original:
            {
                kind: 'aggregate',
                pipeline
            },
            optimized:
            {
                kind: 'aggregate',
                pipeline: optimized
            },
            observation: 'ordered-bson',
            policy,
            expectedOriginalOutcome: 'success',
            originalForm: pipeline,
            optimizedForm: optimized
        };
    }

    describe( 'test.query pipeline differential matrix', () =>
    {
        it( 'verifies test.query in default mode', async () =>
        {
            const testCase = createDifferentialCase( 'rw-test-query-def', testQuery, {} );
            const result = await oracle.compare( testCase );

            expect( result.equal ).toBe( true );
        } );

        // Known bug B: add-field-pushdown reorders fields across $lookup without checking context.strictFieldOrder (resolved in U7)
        it.fails( 'detects known bug B in strictFieldOrder mode for test.query', async () =>
        {
            const testCase = createDifferentialCase(
                'rw-test-query-sfo',
                testQuery,
                { strictFieldOrder: true }
            );
            const result = await oracle.compare( testCase );

            expect( result.equal ).toBe( true );
        } );

        it( 'verifies test.query in strictErrors mode', async () =>
        {
            const testCase = createDifferentialCase(
                'rw-test-query-se',
                testQuery,
                { strictErrors: true }
            );
            const result = await oracle.compare( testCase );

            expect( result.equal ).toBe( true );
        } );
    } );

    describe( 'test.full.query pipeline differential matrix', () =>
    {
        it( 'verifies test.full.query in default mode', async () =>
        {
            const testCase = createDifferentialCase( 'rw-test-full-query-def', testFullQuery, {} );
            const result = await oracle.compare( testCase );

            expect( result.equal ).toBe( true );
        } );

        it( 'verifies test.full.query in strictFieldOrder mode', async () =>
        {
            const testCase = createDifferentialCase(
                'rw-test-full-query-sfo',
                testFullQuery,
                { strictFieldOrder: true }
            );
            const result = await oracle.compare( testCase );

            expect( result.equal ).toBe( true );
        } );

        it( 'verifies test.full.query in strictErrors mode', async () =>
        {
            const testCase = createDifferentialCase(
                'rw-test-full-query-se',
                testFullQuery,
                { strictErrors: true }
            );
            const result = await oracle.compare( testCase );

            expect( result.equal ).toBe( true );
        } );
    } );
} );
