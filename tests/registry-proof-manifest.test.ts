import { describe, expect, it } from 'vitest';
import {
    getFilterRuleRegistryStatus,
} from '../src/filter-rule-registry.js';
import {
    getPipelineTransformationRegistryStatus,
} from '../src/passes/registry.js';
import {
    candidateSemanticCases,
    productionSemanticCases,
    unsafeCandidateCases,
} from './fixtures/semantic-cases.js';
import {
    generatedInteractionSemanticCases,
} from './fixtures/generated-interactions.js';
import {
    filterProofManifest,
    pipelineProofManifest,
    validateGateRecord,
    type TransformationProofEvidence,
} from './fixtures/proof-manifest.js';

const REGISTERED_FILTER_IDS = [
    'simplify-equality',
    'simplify-singleton-in',
    'flatten-conjunctions',
    'flatten-disjunctions',
    'simplify-conjunction-identities',
    'simplify-disjunction-identities',
    'deduplicate-conjunctions',
    'merge-conjunctions',
] as const;

const EXPECTED_CONTAINED_PIPELINE_IDS = [
    'stage-priority-reorder',
    'redundant-projection-elimination',
    'covered-projection-synthesis',
    'dead-assignment-elimination',
] as const;

const REGISTERED_PIPELINE_IDS = [
    'expr-match-normalization',
    'filter-optimization',
    'adjacent-match-merging',
    'group-filter-pushdown',
    'bucket-filter-pushdown',
    'unwind-prefilter',
    'redundant-sort-elimination',
    'sort-by-count-simplification',
    'limit-skip-coalescing',
    'match-pushdown',
    'limit-advance',
    'add-field-pushdown',
    'top-k-pushdown',
    'unused-field-pruning',
    'adjacent-project-merging',
    'adjacent-add-field-merging',
    'lookup-delay',
    'redundant-lookup-elimination',
    'sort-project-commute',
    'complex-projection-deferral',
    'facet-prefix-hoisting',
    ...EXPECTED_CONTAINED_PIPELINE_IDS,
] as const;

function expectUnique(values: readonly string[]): void
{
    expect(new Set(values).size).toBe(values.length);
}

function expectImmutableStatus(status: {
    readonly registered: readonly string[];
    readonly active: readonly string[];
    readonly contained: readonly string[];
}): void
{
    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(status.registered)).toBe(true);
    expect(Object.isFrozen(status.active)).toBe(true);
    expect(Object.isFrozen(status.contained)).toBe(true);
    expect(() => (status.active as string[]).push('mutation')).toThrow(TypeError);
}

function manifestIds(
    manifest: readonly TransformationProofEvidence<string>[],
): string[]
{
    return manifest.map((entry) => entry.transformationId);
}

describe('explicit immutable transformation registries', () =>
{
    it('lists active and contained filter rules independently', () =>
    {
        const status = getFilterRuleRegistryStatus();

        expect(status.active).toEqual([]);
        expect(status.contained).toEqual([]);
        expect(status.registered).toEqual(REGISTERED_FILTER_IDS);
        expectUnique(status.registered);
        expectImmutableStatus(status);
    });

    it('admits only proven and gated pipeline transformations', () =>
    {
        const status = getPipelineTransformationRegistryStatus();

        expect(status.active).toEqual([
            'group-filter-pushdown',
            'bucket-filter-pushdown',
            'unwind-prefilter',
            'redundant-sort-elimination',
            'sort-by-count-simplification',
            'limit-skip-coalescing',
            'match-pushdown',
            'limit-advance',
            'add-field-pushdown',
            'top-k-pushdown',
            'unused-field-pruning',
            'adjacent-project-merging',
            'lookup-delay'
        ]);
        expect(status.contained).toEqual(EXPECTED_CONTAINED_PIPELINE_IDS);
        expect(status.registered).toEqual(REGISTERED_PIPELINE_IDS);
        expectUnique(status.registered);
        expect(
            status.active.filter((id) => status.contained.includes(id)),
        ).toEqual([]);
        expectImmutableStatus(status);
    });
});

describe('active transformation proof manifest', () =>
{
    const semanticCases = [
        ...productionSemanticCases,
        ...generatedInteractionSemanticCases,
        ...candidateSemanticCases,
        ...unsafeCandidateCases,
    ];
    const semanticCaseIds = semanticCases.map((testCase) => testCase.id);
    const semanticCasesById = new Map(
        semanticCases.map((testCase) => [testCase.id, testCase]),
    );

    it('matches both active registries without missing or duplicate IDs', () =>
    {
        const filterStatus = getFilterRuleRegistryStatus();
        const pipelineStatus = getPipelineTransformationRegistryStatus();
        const filterManifestIds = manifestIds(filterProofManifest);
        const pipelineManifestIds = manifestIds(pipelineProofManifest);

        expectUnique(filterManifestIds);
        expectUnique(pipelineManifestIds);

        // Every active transformation must have an active gate record in manifest
        const activeFilterManifestIds = filterProofManifest
            .filter((entry) => entry.gate?.status === 'active')
            .map((entry) => entry.transformationId);
        const activePipelineManifestIds = pipelineProofManifest
            .filter((entry) => entry.gate?.status === 'active')
            .map((entry) => entry.transformationId);

        expect(activeFilterManifestIds).toEqual(filterStatus.active);
        expect(activePipelineManifestIds).toEqual(pipelineStatus.active);

        // Every active pass must have a complete gate record
        for( const entry of [...filterProofManifest, ...pipelineProofManifest] )
        {
            if( entry.gate.status === 'active' )
            {
                expect(() => validateGateRecord( entry )).not.toThrow();
            }
        }

        expect(
            pipelineStatus.contained.filter((id) =>
                pipelineManifestIds.includes(id),
            ),
        ).toEqual([]);
    });

    it('validates gate record requirements and rejects incomplete records', () =>
    {
        // 1. Missing gate record
        expect(() => validateGateRecord({ transformationId: 'dummy' } as any)).toThrow(
            'lacks a gate record'
        );

        // 2. Active without proofRecheckNote
        expect(() =>
            validateGateRecord({
                transformationId: 'dummy',
                gate: { status: 'active', proofRecheckNote: '' },
            } as any)
        ).toThrow('lacks a proofRecheckNote');

        // 3. Active without complete mixedShapeCaseIds
        expect(() =>
            validateGateRecord({
                transformationId: 'dummy',
                gate: {
                    status: 'active',
                    proofRecheckNote: 'Note',
                    mixedShapeCaseIds: { default: 'case-def' } as any,
                },
            } as any)
        ).toThrow('lacks complete mixedShapeCaseIds');

        // 4. Active without valid strictModeBehavior
        expect(() =>
            validateGateRecord({
                transformationId: 'dummy',
                gate: {
                    status: 'active',
                    proofRecheckNote: 'Note',
                    mixedShapeCaseIds: {
                        default: 'c1',
                        strictFieldOrder: 'c2',
                        strictErrors: 'c3',
                    },
                    strictModeBehavior: 'invalid' as any,
                },
            } as any)
        ).toThrow('lacks valid strictModeBehavior');
    });

    it('maps every active ID to focused, interaction, nested, and server evidence', () =>
    {
        expectUnique(semanticCaseIds);

        for (const entry of [...filterProofManifest, ...pipelineProofManifest])
        {
            expect(Object.isFrozen(entry)).toBe(true);

            for (const evidenceIds of [
                entry.focused,
                entry.interaction,
                entry.nested,
                entry.mongodbFixtures,
            ])
            {
                expect(evidenceIds.length).toBeGreaterThan(0);
                expectUnique(evidenceIds);
                expect(Object.isFrozen(evidenceIds)).toBe(true);

                for (const evidenceId of evidenceIds)
                {
                    expect(
                        semanticCasesById.has(evidenceId),
                        `${entry.transformationId} references missing ${evidenceId}`,
                    ).toBe(true);
                    expect(
                        semanticCasesById.get(evidenceId)?.affectedTransformationIds,
                        `${evidenceId} does not prove ${entry.transformationId}`,
                    ).toContain(entry.transformationId);
                }
            }
        }
    });
});
