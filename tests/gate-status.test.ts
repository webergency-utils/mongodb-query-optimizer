import { describe, expect, it } from 'vitest';
import {
    getFilterRuleRegistryStatus
} from '../src/filter-rule-registry.js';
import {
    optimizeFilter,
    optimizePipeline
} from '../src/index.js';
import {
    getPipelineTransformationRegistryStatus,
    optimizePipelineWithCandidateProfile
} from '../src/passes/registry.js';
import {
    filterProofManifest,
    pipelineProofManifest,
    validateGateRecord,
    type TransformationProofEvidence
} from './fixtures/proof-manifest.js';
import {
    PRE_GATE_FILTER_RULE_IDS,
    PRE_GATE_PIPELINE_TRANSFORMATION_IDS
} from './helpers/pre-gate-optimizer.js';

describe( 'Activation gate status and guard invariants', () =>
{
    it( 'returns a deep clone equal to input for optimizePipeline when candidate profile is empty', () =>
    {
        const pipeline =
        [
            { $match: { a: 1 } },
            { $match: { b: 2 } },
            { $lookup: { from: 'items', localField: 'x', foreignField: 'y', as: 'items' } },
            { $limit: 10 }
        ];

        const optimized = optimizePipelineWithCandidateProfile( pipeline, [] );

        expect( optimized ).toEqual( pipeline );
        expect( optimized ).not.toBe( pipeline );
        expect( optimized[0] ).not.toBe( pipeline[0] );

        // Production optimizePipeline does not apply inactive passes like adjacent-match-merging
        const inactivePipeline = [ { $match: { a: 1 } }, { $match: { b: 2 } } ];
        expect( optimizePipeline( inactivePipeline ) ).toEqual( inactivePipeline );
    } );

    it( 'returns a clone equal to input for optimizeFilter when inactive candidate rules are bypassed', () =>
    {
        const filter =
        {
            $and:
            [
                { a: { $eq: 10 } },
                { b: { $in: [ 'active' ] } }
            ]
        };

        const optimized = optimizeFilter( filter );

        expect( optimized ).toEqual( filter );
        expect( optimized ).not.toBe( filter );
    } );

    it( 'verifies contained passes are neither active nor present in the pre-gate frozen set', () =>
    {
        const status = getPipelineTransformationRegistryStatus();

        expect( status.contained.length ).toBeGreaterThan( 0 );

        for( const containedId of status.contained )
        {
            expect( status.active ).not.toContain( containedId );
            expect( PRE_GATE_PIPELINE_TRANSFORMATION_IDS ).not.toContain( containedId );
        }
    } );

    it( 'ensures frozen set minus production set equals passes recorded as inactive', () =>
    {
        const pipelineStatus = getPipelineTransformationRegistryStatus();
        const filterStatus = getFilterRuleRegistryStatus();

        // 1. Pipeline passes
        const inactivePipelinePasses = PRE_GATE_PIPELINE_TRANSFORMATION_IDS.filter(
            ( id ) => !pipelineStatus.active.includes( id )
        );
        const recordedInactivePasses = pipelineProofManifest
            .filter( ( entry ) => entry.gate?.status === 'inactive' )
            .map( ( entry ) => entry.transformationId );

        expect( inactivePipelinePasses ).toEqual( recordedInactivePasses );

        // 2. Filter rules
        const inactiveFilterRules = PRE_GATE_FILTER_RULE_IDS.filter(
            ( id ) => !filterStatus.active.includes( id )
        );
        const recordedInactiveRules = filterProofManifest
            .filter( ( entry ) => entry.gate?.status === 'inactive' )
            .map( ( entry ) => entry.transformationId );

        expect( inactiveFilterRules ).toEqual( recordedInactiveRules );
    } );

    it( 'fails when an active entry lacks a gate record or misses strict mode cases', () =>
    {
        const missingGate: TransformationProofEvidence<string> =
        {
            transformationId: 'dummy-pass',
            focused: [ 'c1' ],
            interaction: [ 'c2' ],
            nested: [ 'c3' ],
            mongodbFixtures: [ 'c4' ]
        } as any;

        expect( () => validateGateRecord( missingGate ) ).toThrow( 'lacks a gate record' );

        const missingStrictErrors: TransformationProofEvidence<string> =
        {
            transformationId: 'dummy-pass',
            focused: [ 'c1' ],
            interaction: [ 'c2' ],
            nested: [ 'c3' ],
            mongodbFixtures: [ 'c4' ],
            gate:
            {
                status: 'active',
                proofRecheckNote: 'Recheck note',
                mixedShapeCaseIds:
                {
                    default: 'case-def',
                    strictFieldOrder: 'case-sfo'
                } as any,
                strictModeBehavior: 'preserved'
            }
        };

        expect( () => validateGateRecord( missingStrictErrors ) ).toThrow(
            'lacks complete mixedShapeCaseIds'
        );

        const validActive: TransformationProofEvidence<string> =
        {
            transformationId: 'valid-pass',
            focused: [ 'c1' ],
            interaction: [ 'c2' ],
            nested: [ 'c3' ],
            mongodbFixtures: [ 'c4' ],
            gate:
            {
                status: 'active',
                proofRecheckNote: 'Valid proof note',
                mixedShapeCaseIds:
                {
                    default: 'case-def',
                    strictFieldOrder: 'case-sfo',
                    strictErrors: 'case-se'
                },
                strictModeBehavior: 'preserved'
            }
        };
        expect( () => validateGateRecord( validActive ) ).not.toThrow();

        const missingNote: TransformationProofEvidence<string> =
        {
            transformationId: 'dummy-1',
            focused: [],
            interaction: [],
            nested: [],
            mongodbFixtures: [],
            gate: { status: 'active' }
        };
        expect( () => validateGateRecord( missingNote ) ).toThrow( 'lacks a proofRecheckNote' );

        const missingShapes: TransformationProofEvidence<string> =
        {
            transformationId: 'dummy-2',
            focused: [],
            interaction: [],
            nested: [],
            mongodbFixtures: [],
            gate: { status: 'active', proofRecheckNote: 'note' }
        };
        expect( () => validateGateRecord( missingShapes ) ).toThrow( 'lacks complete mixedShapeCaseIds' );

        const missingBehavior: TransformationProofEvidence<string> =
        {
            transformationId: 'dummy-3',
            focused: [],
            interaction: [],
            nested: [],
            mongodbFixtures: [],
            gate:
            {
                status: 'active',
                proofRecheckNote: 'note',
                mixedShapeCaseIds:
                {
                    default: 'c1',
                    strictFieldOrder: 'c2',
                    strictErrors: 'c3'
                }
            }
        };
        expect( () => validateGateRecord( missingBehavior ) ).toThrow( 'lacks valid strictModeBehavior' );
    } );
} );
