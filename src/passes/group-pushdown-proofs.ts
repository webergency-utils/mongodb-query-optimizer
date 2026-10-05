import { deepClone } from '../utils.js';

export interface GroupFilterPushdownProof {
    prefilterStage: { $match: Record<string, any> };
    postfilterStage: { $match: Record<string, any> } | null;
}

function isPlainObject(value: unknown): value is Record<string, any>
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function conditionRejectsNull(condition: unknown): boolean
{
    if (typeof condition === 'string')
    {
        return condition.length > 0;
    }

    if (typeof condition === 'number' || typeof condition === 'boolean')
    {
        return true;
    }

    if (isPlainObject(condition) && '$ne' in condition)
    {
        return condition.$ne === null;
    }

    return false;
}

export function proveGroupFilterPushdown(
    groupStage: unknown,
    matchStage: unknown,
): GroupFilterPushdownProof | null
{
    if (!isPlainObject(groupStage) || !isPlainObject(matchStage))
    {
        return null;
    }

    const groupKeys = Object.keys(groupStage);
    if (groupKeys.length !== 1 || groupKeys[0] !== '$group')
    {
        return null;
    }

    const matchKeys = Object.keys(matchStage);
    if (matchKeys.length !== 1 || matchKeys[0] !== '$match')
    {
        return null;
    }

    const groupSpec = groupStage.$group;
    const matchSpec = matchStage.$match;

    if (!isPlainObject(groupSpec) || !isPlainObject(matchSpec) || !('_id' in groupSpec))
    {
        return null;
    }

    const idSpec = groupSpec._id;
    const accumulatorFields = new Set(
        Object.keys(groupSpec).filter((k) => k !== '_id'),
    );

    const prefilter: Record<string, any> = {};
    const postfilter: Record<string, any> = {};
    let hasIdCondition = false;
    let isOneToOne = false;

    // Inspect _id specification
    if (
        typeof idSpec === 'string'
        && idSpec.startsWith('$')
        && !idSpec.startsWith('$$')
        && idSpec.length > 1
    )
    {
        isOneToOne = true;
        const sourceField = idSpec.slice(1);

        for (const [key, val] of Object.entries(matchSpec))
        {
            if (key === '_id')
            {
                prefilter[sourceField] = deepClone(val);
                hasIdCondition = true;
            }
            else if (key.startsWith('_id.'))
            {
                const sub = key.slice(4);
                prefilter[`${sourceField}.${sub}`] = deepClone(val);
                hasIdCondition = true;
            }
            else
            {
                postfilter[key] = deepClone(val);
            }
        }
    }
    else if (isPlainObject(idSpec))
    {
        const idKeys = Object.keys(idSpec);
        const allStringPaths = (
            idKeys.length > 0
            && idKeys.every(
                (k) =>
                    !k.startsWith("$")
                    && typeof idSpec[k] === "string"
                    && idSpec[k].startsWith("$")
                    && !idSpec[k].startsWith("$$")
                    && idSpec[k].length > 1,
            )
        );

        if (allStringPaths)
        {
            isOneToOne = true;

            for (const [key, val] of Object.entries(matchSpec))
            {
                if (key.startsWith("_id."))
                {
                    const rest = key.slice(4);
                    const dotIdx = rest.indexOf(".");
                    const subKey = dotIdx === -1 ? rest : rest.slice(0, dotIdx);
                    const subPath = dotIdx === -1 ? "" : rest.slice(dotIdx);

                    if (subKey in idSpec)
                    {
                        const sourceField = idSpec[subKey].slice(1) + subPath;
                        prefilter[sourceField] = deepClone(val);
                        hasIdCondition = true;
                    }
                    else
                    {
                        return null;
                    }
                }
                else if (key === "_id")
                {
                    if (isPlainObject(val))
                    {
                        for (const [subKey, subVal] of Object.entries(val))
                        {
                            if (subKey in idSpec)
                            {
                                const sourceField = idSpec[subKey].slice(1);
                                prefilter[sourceField] = deepClone(subVal);
                                hasIdCondition = true;
                            }
                            else
                            {
                                return null;
                            }
                        }
                    }
                    else
                    {
                        return null;
                    }
                }
                else
                {
                    postfilter[key] = deepClone(val);
                }
            }
        }
        else
        {
            // Computed expression like { $toUpper: "$dept" }
            const opKeys = Object.keys(idSpec);
            if (opKeys.length === 1 && opKeys[0]!.startsWith("$"))
            {
                const opArg = idSpec[opKeys[0]!];
                if (
                    typeof opArg === "string"
                    && opArg.startsWith("$")
                    && !opArg.startsWith("$$")
                    && opArg.length > 1
                )
                {
                    const sourceField = opArg.slice(1);
                    if (
                        matchSpec._id === undefined
                        || !conditionRejectsNull(matchSpec._id)
                    )
                    {
                        return null;
                    }

                    prefilter[sourceField] = { $exists: true, $ne: null };
                    hasIdCondition = true;
                    isOneToOne = false;

                    for (const [key, val] of Object.entries(matchSpec))
                    {
                        postfilter[key] = deepClone(val);
                    }
                }
                else
                {
                    return null;
                }
            }
            else
            {
                return null;
            }
        }
    }
    else
    {
        return null;
    }

    if (!hasIdCondition)
    {
        return null;
    }

    const postKeys = Object.keys(postfilter);
    const postfilterStage = postKeys.length > 0 ? { $match: postfilter } : null;

    return {
        prefilterStage: { $match: prefilter },
        postfilterStage,
    };
}
