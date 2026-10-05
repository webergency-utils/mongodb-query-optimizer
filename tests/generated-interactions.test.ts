import { describe, expect, it } from 'vitest';
import {
    getFilterRuleRegistryStatus,
} from '../src/filter-rule-registry.js';
import {
    optimizeFilter,
    optimizePipeline,
} from '../src/index.js';
import {
    getPipelineTransformationRegistryStatus,
} from '../src/passes/registry.js';
import { structuralFingerprint } from '../src/utils.js';
import {
    GENERATED_INTERACTION_CASE_COUNT,
    GENERATED_INTERACTION_SEED,
    generateInteractionSemanticCases,
    generatedInteractionSemanticCases,
} from './fixtures/generated-interactions.js';

function expectStrictStageShapes(pipeline: readonly any[]): void
{
    for (const stage of pipeline)
    {
        expect(
            stage
            && typeof stage === 'object'
            && !Array.isArray(stage)
            && Object.keys(stage).length === 1,
        ).toBe(true);

        const facet = stage.$facet;
        if (facet && typeof facet === 'object' && !Array.isArray(facet))
        {
            for (const child of Object.values(facet))
            {
                if (Array.isArray(child))
                {
                    expectStrictStageShapes(child);
                }
            }
        }

        for (const operator of ['$lookup', '$unionWith'])
        {
            const value = stage[operator];
            if (
                value
                && typeof value === 'object'
                && !Array.isArray(value)
                && Array.isArray(value.pipeline)
            )
            {
                expectStrictStageShapes(value.pipeline);
            }
        }
    }
}

describe('deterministic generated active-rule interactions', () =>
{
    it('replays a stable seed, count, IDs, and output structure', () =>
    {
        const first = generateInteractionSemanticCases(GENERATED_INTERACTION_SEED);
        const second = generateInteractionSemanticCases(GENERATED_INTERACTION_SEED);
        const alternate = generateInteractionSemanticCases(
            GENERATED_INTERACTION_SEED + 1,
        );

        expect(first).toEqual(second);
        expect(first).toHaveLength(GENERATED_INTERACTION_CASE_COUNT);
        expect(generatedInteractionSemanticCases).toEqual(first);
        expect(new Set(first.map((testCase) => testCase.id)).size).toBe(first.length);
        expect(structuralFingerprint(first)).toBe(structuralFingerprint(second));
        expect(structuralFingerprint(first)).not.toBe(
            structuralFingerprint(alternate),
        );
    });

    it('covers every active filter and pipeline ID at top level and nested', () =>
    {
        const cases = generatedInteractionSemanticCases;
        const filterStatus = getFilterRuleRegistryStatus();
        const pipelineStatus = getPipelineTransformationRegistryStatus();
        const topLevelCases = cases.filter((testCase) =>
            testCase.id.startsWith('u9-generated-top-level-'),
        );
        const nestedCases = cases.filter((testCase) =>
            testCase.id.startsWith('u9-generated-nested-'),
        );

        expect(topLevelCases).toHaveLength(pipelineStatus.active.length);
        expect(nestedCases).toHaveLength(pipelineStatus.active.length);

        for (const id of filterStatus.active)
        {
            expect(
                topLevelCases.some((testCase) =>
                    testCase.affectedTransformationIds.includes(id),
                ),
            ).toBe(true);
            expect(
                nestedCases.some((testCase) =>
                    testCase.affectedTransformationIds.includes(id),
                ),
            ).toBe(true);
        }

        for (const id of pipelineStatus.active)
        {
            expect(
                topLevelCases.some((testCase) =>
                    testCase.affectedTransformationIds.includes(id),
                ),
            ).toBe(true);
            expect(
                nestedCases.some((testCase) =>
                    testCase.affectedTransformationIds.includes(id),
                ),
            ).toBe(true);
        }
    });

    it('does not mutate inputs and reaches valid one-call fixed points', () =>
    {
        for (const testCase of generatedInteractionSemanticCases)
        {
            if (testCase.kind === 'filter')
            {
                const snapshot = structuredClone(testCase.filter);
                const once = optimizeFilter(testCase.filter);
                const twice = optimizeFilter(once);

                expect(testCase.filter).toEqual(snapshot);
                expect(structuralFingerprint(once)).not.toBe(
                    structuralFingerprint(testCase.filter),
                );
                expect(twice).toEqual(once);
                continue;
            }

            const snapshot = structuredClone(testCase.pipeline);
            const once = optimizePipeline(testCase.pipeline as any[]);
            const twice = optimizePipeline(once);

            expect(testCase.pipeline).toEqual(snapshot);
            expect(structuralFingerprint(once)).not.toBe(
                structuralFingerprint(testCase.pipeline),
            );
            expect(twice).toEqual(once);
            expectStrictStageShapes(testCase.pipeline);
            expectStrictStageShapes(once);
        }
    });

    it('includes server observations for all required semantic dimensions', () =>
    {
        const cases = generatedInteractionSemanticCases;
        const observations = new Set(cases.map((testCase) => testCase.observation));
        const documents = cases.flatMap((testCase) =>
            Object.values(testCase.collections).flatMap((fixture) =>
                fixture.documents,
            ),
        );

        expect(observations).toContain('ordered-bson');
        expect(observations).toContain('multiset');
        expect(documents.some((document) => document.nullable === null)).toBe(true);
        expect(documents.some((document) => !('nullable' in document))).toBe(true);
        expect(documents.some((document) =>
            document.ordered
            && Object.keys(document.ordered).join(',') === 'first,second',
        )).toBe(true);
    });
});
