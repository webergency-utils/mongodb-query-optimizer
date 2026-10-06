import { analyzeStage } from '../analyzer/semantics.js';
import { deepClone, isPlainObject, structuralFingerprint } from '../utils.js';
import { getSingleStageEntry, getStageSpec } from './helpers.js';

const ALLOWED_HOIST_OPERATORS = new Set([
    '$match',
    '$project',
    '$addFields',
    '$set',
    '$unset',
]);

export interface FacetPrefixHoistingProof {
    hoistedStages: any[];
    simplifiedFacet: any;
}

function isEligibleHoistStage(stage: unknown): boolean
{
    const entry = getSingleStageEntry( stage );
    if( !entry )
    {
        return false;
    }

    const operator = entry[0];
    if (!ALLOWED_HOIST_OPERATORS.has(operator))
    {
        return false;
    }

    const summary = analyzeStage(stage);
    if (
        summary.malformed
        || summary.unknown
        || summary.determinism !== 'deterministic'
        || summary.order !== 'preserves'
        || summary.dependencies.unknown
        || summary.dependencies.variables.size > 0
    )
    {
        return false;
    }

    return true;
}

export function proveFacetPrefixHoisting(
    stage: unknown,
): FacetPrefixHoistingProof | null
{
    const facetSpec = getStageSpec<Record<string, any>>( stage, '$facet' );
    if( !facetSpec )
    {
        return null;
    }

    const branchNames = Object.keys(facetSpec);
    if (branchNames.length < 2)
    {
        return null;
    }

    for (const name of branchNames)
    {
        if (!Array.isArray(facetSpec[name]))
        {
            return null;
        }
    }

    // Clone branch arrays so we can pop hoisted stages cleanly
    const branches: Record<string, any[]> = {};
    for (const name of branchNames)
    {
        branches[name] = deepClone(facetSpec[name]);
    }

    const hoistedStages: any[] = [];

    while (true)
    {
        // Check if every branch has at least one stage remaining
        for (const name of branchNames)
        {
            if (branches[name]!.length === 0)
            {
                return hoistedStages.length > 0
                    ? {
                        hoistedStages,
                        simplifiedFacet: { $facet: branches },
                    }
                    : null;
            }
        }

        const firstBranchLeadingStage = branches[branchNames[0]!]![0];
        if (!isEligibleHoistStage(firstBranchLeadingStage))
        {
            break;
        }

        const targetFingerprint = structuralFingerprint(firstBranchLeadingStage);
        let allAgree = true;

        for (let i = 1; i < branchNames.length; i++)
        {
            const currentBranchLeadingStage = branches[branchNames[i]!]![0];
            if (structuralFingerprint(currentBranchLeadingStage) !== targetFingerprint)
            {
                allAgree = false;
                break;
            }
        }

        if (!allAgree)
        {
            break;
        }

        // Shift the common stage from all branches
        hoistedStages.push(firstBranchLeadingStage);
        for (const name of branchNames)
        {
            branches[name]!.shift();
        }
    }

    if (hoistedStages.length === 0)
    {
        return null;
    }

    return {
        hoistedStages,
        simplifiedFacet: { $facet: branches },
    };
}
