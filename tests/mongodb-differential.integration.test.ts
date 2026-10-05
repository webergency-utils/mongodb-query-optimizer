import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    optimizeFilter,
    optimizePipeline,
} from '../src/index.js';
import { optimizeFilterWithCandidateProfile } from '../src/filter-optimizer.js';
import { optimizePipelineWithCandidateProfile } from '../src/passes/registry.js';
import {
    candidateSemanticCases,
    productionSemanticCases,
    unsafeCandidateCases,
    type SemanticCase,
} from './fixtures/semantic-cases.js';
import {
    GENERATED_INTERACTION_CASE_COUNT,
    GENERATED_INTERACTION_SEED,
    generatedInteractionSemanticCases,
} from './fixtures/generated-interactions.js';
import {
    MongoDifferentialOracle,
    type MongoDifferentialCase,
    validateMongoOracleEnvironment,
} from './helpers/mongodb-oracle.js';

function materializeCase(testCase: SemanticCase): MongoDifferentialCase
{
    if (testCase.kind === 'filter')
    {
        const optimized = testCase.optimizedFilterOverride
            ?? (
                testCase.candidateRuleIds
                    ? optimizeFilterWithCandidateProfile(
                        testCase.filter,
                        testCase.candidateRuleIds,
                    )
                    : optimizeFilter(testCase.filter)
            );

        return {
            id: testCase.id,
            mainCollectionId: testCase.mainCollectionId,
            collections: testCase.collections,
            original: {
                kind: 'find',
                filter: testCase.filter,
                options: testCase.options,
            },
            optimized: {
                kind: 'find',
                filter: optimized,
                options: testCase.options,
            },
            observation: testCase.observation,
            originalForm: testCase.filter,
            optimizedForm: optimized,
        };
    }

    const optimized = (
        testCase.candidateTransformationIds
        || testCase.candidateRuleIds
    )
        ? optimizePipelineWithCandidateProfile(
            testCase.pipeline,
            testCase.candidateTransformationIds ?? [],
            testCase.candidateRuleIds,
        )
        : optimizePipeline(testCase.pipeline as any[]);

    return {
        id: testCase.id,
        mainCollectionId: testCase.mainCollectionId,
        collections: testCase.collections,
        original: {
            kind: 'aggregate',
            pipeline: testCase.pipeline,
            options: testCase.options,
        },
        optimized: {
            kind: 'aggregate',
            pipeline: optimized,
            options: testCase.options,
        },
        observation: testCase.observation,
        originalForm: testCase.pipeline,
        optimizedForm: optimized,
    };
}

describe.sequential('MongoDB 8 differential oracle', () =>
{
    let oracle: MongoDifferentialOracle;

    beforeAll(async () =>
    {
        try
        {
            if (typeof process.loadEnvFile === 'function')
            {
                process.loadEnvFile();
            }
        }
        catch
        {
            // .env is optional when environment variables are supplied directly
        }

        const configuration = validateMongoOracleEnvironment(process.env);
        oracle = new MongoDifferentialOracle(configuration);
        await oracle.connect();
    });

    afterAll(async () =>
    {
        if (oracle)
        {
            await oracle.cleanup();
            await oracle.close();
        }
    });

    for (const testCase of productionSemanticCases)
    {
        it(`keeps the production form equivalent: ${testCase.id}`, async () =>
        {
            const result = await oracle.compare(materializeCase(testCase));

            expect(result.equal).toBe(testCase.expectedEquivalent);
        });
    }

    it("uses the declared deterministic generated corpus", () =>
    {
        expect(GENERATED_INTERACTION_SEED).toBe(0x5eed_2026);
        expect(generatedInteractionSemanticCases).toHaveLength(
            GENERATED_INTERACTION_CASE_COUNT,
        );
    });

    for (const testCase of generatedInteractionSemanticCases)
    {
        it(`checks the seeded active-rule interaction: ${testCase.id}`, async () =>
        {
            const result = await oracle.compare(materializeCase(testCase));

            expect(result.equal).toBe(testCase.expectedEquivalent);
        });
    }

    for (const testCase of candidateSemanticCases)
    {
        it(`checks the selected candidate profile: ${testCase.id}`, async () =>
        {
            const result = await oracle.compare(materializeCase(testCase));

            expect(result.equal).toBe(testCase.expectedEquivalent);
        });
    }

    for (const testCase of unsafeCandidateCases)
    {
        it(`detects the seeded unsafe candidate: ${testCase.id}`, async () =>
        {
            const result = await oracle.compare(materializeCase(testCase));

            expect(result.equal).toBe(testCase.expectedEquivalent);
        });
    }
});
