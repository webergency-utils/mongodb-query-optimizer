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
    type TransformationProofEvidence,
} from './fixtures/proof-manifest.js';

const EXPECTED_ACTIVE_FILTER_IDS = [
    'simplify-equality',
    'simplify-singleton-in',
    'flatten-conjunctions',
    'flatten-disjunctions',
    'simplify-conjunction-identities',
    'simplify-disjunction-identities',
    'deduplicate-conjunctions',
    'merge-conjunctions',
] as const;

const EXPECTED_ACTIVE_PIPELINE_IDS = [
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
    'unused-field-pruning',
    'adjacent-project-merging',
    'adjacent-add-field-merging',
    'lookup-delay',
    'redundant-lookup-elimination',
    'sort-project-commute',
    'complex-projection-deferral',
    'facet-prefix-hoisting',
] as const;

const EXPECTED_CONTAINED_PIPELINE_IDS = [
    'stage-priority-reorder',
    'redundant-projection-elimination',
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

        expect(status.active).toEqual(EXPECTED_ACTIVE_FILTER_IDS);
        expect(status.contained).toEqual([]);
        expect(status.registered).toEqual(EXPECTED_ACTIVE_FILTER_IDS);
        expectUnique(status.registered);
        expectImmutableStatus(status);
    });

    it('admits only proven U4-U6 and limit-skip pipeline transformations', () =>
    {
        const status = getPipelineTransformationRegistryStatus();

        expect(status.active).toEqual(EXPECTED_ACTIVE_PIPELINE_IDS);
        expect(status.contained).toEqual(EXPECTED_CONTAINED_PIPELINE_IDS);
        expect(status.registered).toEqual([
            ...EXPECTED_ACTIVE_PIPELINE_IDS,
            ...EXPECTED_CONTAINED_PIPELINE_IDS,
        ]);
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
        expect(filterManifestIds).toEqual(filterStatus.active);
        expect(pipelineManifestIds).toEqual(pipelineStatus.active);
        expect(
            pipelineStatus.contained.filter((id) =>
                pipelineManifestIds.includes(id),
            ),
        ).toEqual([]);
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
