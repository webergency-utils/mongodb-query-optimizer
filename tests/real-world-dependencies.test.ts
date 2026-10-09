import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    optimizePipeline,
    PRE_GATE_PIPELINE_TRANSFORMATION_IDS,
} from './helpers/pre-gate-optimizer.js';
import {
    getPipelineTransformationRegistryStatus,
    optimizePipelineWithCandidateProfile,
    type PipelineTransformationId
} from '../src/passes/registry.js';
import { optimizePipeline as optimizePipelineProduction } from '../src/index.js';
import { structuralFingerprint } from '../src/utils.js';
import { MIXED_SHAPE_CATALOG } from './fixtures/mixed-shapes.js';
import {
    buildRealWorldDataset,
    REAL_WORLD_DATASET_SEED
} from './fixtures/real-world/data.js';
import { runMockPipeline } from './helpers/mock-engine.js';

describe( 'Real-world corpus fixtures and dependencies', () =>
{
    it( 'parses both queries and matches the workspace root files when present', () =>
    {
        const fixtureTestQueryRaw = fs.readFileSync(
            path.resolve( __dirname, 'fixtures/real-world/test-query.json' ),
            'utf8'
        );
        const fixtureTestFullQueryRaw = fs.readFileSync(
            path.resolve( __dirname, 'fixtures/real-world/test-full-query.json' ),
            'utf8'
        );

        const parsedQuery = JSON.parse( fixtureTestQueryRaw );
        const parsedFullQuery = JSON.parse( fixtureTestFullQueryRaw );

        expect( Array.isArray( parsedQuery ) ).toBe( true );
        expect( Array.isArray( parsedFullQuery ) ).toBe( true );
        expect( parsedQuery.length ).toBe( 6 );
        expect( parsedFullQuery.length ).toBe( 7 );
    } );

    it( 'produces deterministic datasets for a fixed seed and covers all salary shapes', () =>
    {
        const defaultData = buildRealWorldDataset();
        expect( defaultData.jobs.length ).toBe( 20 );

        const data1 = buildRealWorldDataset( { count: 20, seed: REAL_WORLD_DATASET_SEED } );
        const data2 = buildRealWorldDataset( { count: 20, seed: REAL_WORLD_DATASET_SEED } );

        expect( structuralFingerprint( data1 ) ).toBe( structuralFingerprint( data2 ) );

        expect( data1.jobs.length ).toBe( 20 );
        expect( data1.briefings.length ).toBe( 20 );
        expect( data1.placements.length ).toBe( 20 );

        // First 8 documents cover all 8 catalog types
        for( let i = 0; i < MIXED_SHAPE_CATALOG.length; i++ )
        {
            const shape = MIXED_SHAPE_CATALOG[i];
            const job = data1.jobs[i];

            if( shape.type === 'missing' )
            {
                expect( job.employment ).toBeUndefined();
            }
            else
            {
                expect( job.employment ).toBeDefined();
            }
        }

        // Remaining documents have valid structured range salary
        let validSalaryCount = 0;
        for( let i = MIXED_SHAPE_CATALOG.length; i < data1.jobs.length; i++ )
        {
            const job = data1.jobs[i];
            expect( job.employment?.salary?.range?.min ).toBeTypeOf( 'number' );
            expect( job.employment?.salary?.range?.max ).toBeTypeOf( 'number' );
            validSalaryCount++;
        }

        expect( validSalaryCount ).toBeGreaterThan( data1.jobs.length / 2 );
    } );

    it( 'optimizes test.query into success-criterion shape under pre-gate profile', () =>
    {
        const fixtureTestQuery = JSON.parse(
            fs.readFileSync( path.resolve( __dirname, 'fixtures/real-world/test-query.json' ), 'utf8' )
        );

        const optimized = optimizePipeline( fixtureTestQuery );
        const stageNames = optimized.map( ( stage: Record<string, unknown> ) => Object.keys( stage )[0] );

        expect( stageNames ).toEqual(
        [
            '$match',
            '$addFields',
            '$sort',
            '$limit',
            '$lookup',
            '$lookup',
            '$addFields'
        ] );
    } );

    it( 'identifies exactly the passes whose removal alters the optimized test.query', () =>
    {
        const fixtureTestQuery = JSON.parse(
            fs.readFileSync( path.resolve( __dirname, 'fixtures/real-world/test-query.json' ), 'utf8' )
        );

        const baseline = optimizePipelineWithCandidateProfile( fixtureTestQuery );
        const baselineFingerprint = structuralFingerprint( baseline );

        const affectingPasses: PipelineTransformationId[] = [];

        for( const passId of PRE_GATE_PIPELINE_TRANSFORMATION_IDS )
        {
            const profileWithoutPass = PRE_GATE_PIPELINE_TRANSFORMATION_IDS.filter( ( candidateId ) => candidateId !== passId );
            const variant = optimizePipelineWithCandidateProfile( fixtureTestQuery, profileWithoutPass );

            if( structuralFingerprint( variant ) !== baselineFingerprint )
            {
                affectingPasses.push( passId );
            }
        }

        expect( affectingPasses ).toEqual(
        [
            'expression-simplification',
            'add-field-pushdown',
            'top-k-pushdown'
        ] );
    } );

    it( 'verifies test.full.query is optimized by top-k-pushdown heuristic shadow pushdown', () =>
    {
        const fixtureTestFullQuery = JSON.parse(
            fs.readFileSync( path.resolve( __dirname, 'fixtures/real-world/test-full-query.json' ), 'utf8' )
        );

        const baseline = optimizePipelineWithCandidateProfile( fixtureTestFullQuery );
        const baselineFingerprint = structuralFingerprint( baseline );

        const affectingPasses: PipelineTransformationId[] = [];

        for( const passId of PRE_GATE_PIPELINE_TRANSFORMATION_IDS )
        {
            const profileWithoutPass = PRE_GATE_PIPELINE_TRANSFORMATION_IDS.filter( ( candidateId ) => candidateId !== passId );
            const variant = optimizePipelineWithCandidateProfile( fixtureTestFullQuery, profileWithoutPass );

            if( structuralFingerprint( variant ) !== baselineFingerprint )
            {
                affectingPasses.push( passId );
            }
        }

        expect( affectingPasses ).toEqual( [ 'expression-simplification', 'top-k-pushdown' ] );
    } );

    it( 'produces the success-criterion shape under the production profile in default mode', () =>
    {
        const fixtureTestQuery = JSON.parse(
            fs.readFileSync( path.resolve( __dirname, 'fixtures/real-world/test-query.json' ), 'utf8' )
        );

        const optimized = optimizePipelineProduction( fixtureTestQuery );
        const stageNames = optimized.map( ( stage: Record<string, unknown> ) => Object.keys( stage )[0] );

        expect( stageNames ).toEqual(
        [
            '$match',
            '$addFields',
            '$sort',
            '$limit',
            '$lookup',
            '$lookup',
            '$addFields'
        ] );
    } );

    it( 'keeps $lookup before $addFields under strictFieldOrder in production profile', () =>
    {
        const fixtureTestQuery = JSON.parse(
            fs.readFileSync( path.resolve( __dirname, 'fixtures/real-world/test-query.json' ), 'utf8' )
        );

        const optimized = optimizePipelineProduction( fixtureTestQuery, { strictFieldOrder: true } );
        const stageNames = optimized.map( ( stage: Record<string, unknown> ) => Object.keys( stage )[0] );

        expect( stageNames ).toEqual(
        [
            '$match',
            '$lookup',
            '$lookup',
            '$addFields',
            '$sort',
            '$limit'
        ] );
    } );

    it( 'does not hoist sort/limit across $function under strictErrors in production profile', () =>
    {
        const fixtureTestQuery = JSON.parse(
            fs.readFileSync( path.resolve( __dirname, 'fixtures/real-world/test-query.json' ), 'utf8' )
        );

        const optimized = optimizePipelineProduction( fixtureTestQuery, { strictErrors: true } );
        const stageNames = optimized.map( ( stage: Record<string, unknown> ) => Object.keys( stage )[0] );

        expect( stageNames ).toEqual(
        [
            '$match',
            '$lookup',
            '$lookup',
            '$addFields',
            '$sort',
            '$limit'
        ] );
    } );

    it( 'hoists heuristic shadow sort in test.full.query under default mode, preserving strict modes', () =>
    {
        const fixtureTestFullQuery = JSON.parse(
            fs.readFileSync( path.resolve( __dirname, 'fixtures/real-world/test-full-query.json' ), 'utf8' )
        );

        const defaultOptimized = optimizePipelineProduction( fixtureTestFullQuery );
        const strictOrderOptimized = optimizePipelineProduction( fixtureTestFullQuery, { strictFieldOrder: true } );
        const strictErrorsOptimized = optimizePipelineProduction( fixtureTestFullQuery, { strictErrors: true } );

        const expectedStrictOrder = JSON.parse( JSON.stringify( fixtureTestFullQuery ) );
        expectedStrictOrder[ 4 ].$addFields.totalApplicationsCount = {
            $sum: {
                $map: {
                    input: '$engagements',
                    as: 'engagement',
                    in: {
                        $size: '$$engagement.applications'
                    }
                }
            }
        };

        expect( defaultOptimized.length ).toBe( 9 );
        expect( Object.keys( defaultOptimized[ 1 ].$addFields )[ 0 ] ).toBe( '__heuristic_furthestStage' );
        expect( defaultOptimized[ 4 ].$unset ).toBe( '__heuristic_furthestStage' );
        expect( strictOrderOptimized ).toEqual( expectedStrictOrder );
        expect( strictErrorsOptimized ).toEqual( fixtureTestFullQuery );
    } );

    it( 'verifies test.query semantic equality using mock-engine without real MongoDB', () =>
    {
        const fixtureTestQuery = JSON.parse(
            fs.readFileSync( path.resolve( __dirname, 'fixtures/real-world/test-query.json' ), 'utf8' )
        );
        const dataset = buildRealWorldDataset();
        const db = {
            briefings: dataset.briefings,
            placements: dataset.placements,
        };

        const originalOutput = runMockPipeline( dataset.jobs, fixtureTestQuery, db );
        const strictOrderOptimized = optimizePipelineProduction( fixtureTestQuery, { strictFieldOrder: true } );
        const strictOutput = runMockPipeline( dataset.jobs, strictOrderOptimized, db );

        expect( strictOutput ).toEqual( originalOutput );

        const defaultOptimized = optimizePipelineProduction( fixtureTestQuery );
        const defaultOutput = runMockPipeline( dataset.jobs, defaultOptimized, db );

        const sortKeys = ( val: any ): any =>
        {
            if( Array.isArray( val ) )
            {
                return val.map( sortKeys );
            }
            if( val !== null && typeof val === 'object' )
            {
                const sorted: Record<string, any> = {};
                for( const k of Object.keys( val ).sort() )
                {
                    sorted[ k ] = sortKeys( val[ k ] );
                }
                return sorted;
            }
            return val;
        };

        expect( sortKeys( defaultOutput ) ).toEqual( sortKeys( originalOutput ) );
    } );

    it( 'verifies test.full.query semantic equality using mock-engine without real MongoDB', () =>
    {
        const fixtureTestFullQuery = JSON.parse(
            fs.readFileSync( path.resolve( __dirname, 'fixtures/real-world/test-full-query.json' ), 'utf8' )
        );
        const dataset = buildRealWorldDataset();
        const db = {
            briefings: dataset.briefings,
            placements: dataset.placements,
        };

        const originalOutput = runMockPipeline( dataset.jobs, fixtureTestFullQuery, db );
        const defaultOptimized = optimizePipelineProduction( fixtureTestFullQuery );
        const optimizedOutput = runMockPipeline( dataset.jobs, defaultOptimized, db );

        expect( optimizedOutput ).toEqual( originalOutput );
    } );
} );
