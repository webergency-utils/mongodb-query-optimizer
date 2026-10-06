import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { optimizePipeline } from '../src/index.js';
import {
    getPipelineTransformationRegistryStatus,
    optimizePipelineWithCandidateProfile,
    type PipelineTransformationId
} from '../src/passes/registry.js';
import { structuralFingerprint } from '../src/utils.js';
import { MIXED_SHAPE_CATALOG } from './fixtures/mixed-shapes.js';
import {
    buildRealWorldDataset,
    REAL_WORLD_DATASET_SEED
} from './fixtures/real-world/data.js';

describe( 'Real-world corpus fixtures and dependencies', () =>
{
    it( 'parses both queries and matches the workspace root files', () =>
    {
        const rootTestQueryRaw = fs.readFileSync( 'test.query', 'utf8' );
        const rootTestFullQueryRaw = fs.readFileSync( 'test.full.query', 'utf8' );

        const fixtureTestQueryRaw = fs.readFileSync(
            path.resolve( __dirname, 'fixtures/real-world/test-query.json' ),
            'utf8'
        );
        const fixtureTestFullQueryRaw = fs.readFileSync(
            path.resolve( __dirname, 'fixtures/real-world/test-full-query.json' ),
            'utf8'
        );

        expect( fixtureTestQueryRaw ).toBe( rootTestQueryRaw );
        expect( fixtureTestFullQueryRaw ).toBe( rootTestFullQueryRaw );

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

        const status = getPipelineTransformationRegistryStatus();
        const affectingPasses: PipelineTransformationId[] = [];

        for( const passId of status.active )
        {
            const profileWithoutPass = status.active.filter( ( candidateId ) => candidateId !== passId );
            const variant = optimizePipelineWithCandidateProfile( fixtureTestQuery, profileWithoutPass );

            if( structuralFingerprint( variant ) !== baselineFingerprint )
            {
                affectingPasses.push( passId );
            }
        }

        expect( affectingPasses ).toEqual(
        [
            'add-field-pushdown',
            'top-k-pushdown'
        ] );
    } );

    it( 'verifies test.full.query is unaffected by passes due to $$ROOT dependency', () =>
    {
        const fixtureTestFullQuery = JSON.parse(
            fs.readFileSync( path.resolve( __dirname, 'fixtures/real-world/test-full-query.json' ), 'utf8' )
        );

        const baseline = optimizePipelineWithCandidateProfile( fixtureTestFullQuery );
        const baselineFingerprint = structuralFingerprint( baseline );

        const status = getPipelineTransformationRegistryStatus();
        const affectingPasses: PipelineTransformationId[] = [];

        for( const passId of status.active )
        {
            const profileWithoutPass = status.active.filter( ( candidateId ) => candidateId !== passId );
            const variant = optimizePipelineWithCandidateProfile( fixtureTestFullQuery, profileWithoutPass );

            if( structuralFingerprint( variant ) !== baselineFingerprint )
            {
                affectingPasses.push( passId );
            }
        }

        expect( affectingPasses ).toEqual( [] );
    } );
} );
