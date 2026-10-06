import { analyzeStage } from '../analyzer/semantics.js';
import { deepClone, isPlainObject } from '../utils.js';
import { getSingleStageEntry, getStageSpec } from './helpers.js';

export interface UnwindPrefilterProof {
    prefilterStage: { $match: Record<string, any> };
    arrayPath: string;
}

function isUnsupportedPrefilterValue(val: unknown): boolean
{
    if (val instanceof RegExp)
    {
        return true;
    }
    if (isPlainObject(val))
    {
        if ('$ne' in val || '$not' in val || '$nin' in val)
        {
            return true;
        }
    }
    return false;
}

export function proveUnwindPrefilter(
    unwindStage: unknown,
    matchStage: unknown,
): UnwindPrefilterProof | null
{
    const unwindEntry = getSingleStageEntry( unwindStage );
    const matchSpec = getStageSpec<Record<string, any>>( matchStage, '$match' );

    if (!unwindEntry || unwindEntry[0] !== '$unwind' || !matchSpec)
    {
        return null;
    }

    const unwindSpec = unwindEntry[1];

    let arrayPath: string;
    let indexField: string | undefined;

    if (typeof unwindSpec === 'string')
    {
        if (!unwindSpec.startsWith('$') || unwindSpec.length <= 1)
        {
            return null;
        }
        arrayPath = unwindSpec.slice(1);
    }
    else if (isPlainObject(unwindSpec))
    {
        if (
            typeof unwindSpec.path !== 'string'
            || !unwindSpec.path.startsWith('$')
            || unwindSpec.path.length <= 1
            || unwindSpec.preserveNullAndEmptyArrays === true
        )
        {
            return null;
        }
        arrayPath = unwindSpec.path.slice(1);
        if (typeof unwindSpec.includeArrayIndex === 'string')
        {
            indexField = unwindSpec.includeArrayIndex;
        }
    }
    else
    {
        return null;
    }

    const summary = analyzeStage(matchStage);
    if (
        summary.malformed
        || summary.unknown
        || summary.determinism !== 'deterministic'
    )
    {
        return null;
    }

    if (indexField !== undefined)
    {
        const prefixIndex = indexField + '.';
        for (const key of Object.keys(matchSpec))
        {
            if (key === indexField || key.startsWith(prefixIndex))
            {
                return null;
            }
        }
    }

    const prefix = arrayPath + '.';
    const elemMatchFilter: Record<string, any> = {};
    let matchingFieldCount = 0;

    for (const [key, val] of Object.entries(matchSpec))
    {
        if (key.startsWith(prefix))
        {
            if (isUnsupportedPrefilterValue(val))
            {
                return null;
            }
            const subKey = key.slice(prefix.length);
            elemMatchFilter[subKey] = deepClone(val);
            matchingFieldCount++;
        }
    }

    if (matchingFieldCount === 0)
    {
        return null;
    }

    return {
        prefilterStage: {
            $match: {
                [arrayPath]: {
                    $elemMatch: elemMatchFilter,
                },
            },
        },
        arrayPath,
    };
}
