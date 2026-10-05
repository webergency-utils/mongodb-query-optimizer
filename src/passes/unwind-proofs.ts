import { analyzeStage } from "../analyzer/semantics.js";
import { deepClone } from "../utils.js";

export interface UnwindPrefilterProof {
  prefilterStage: { $match: Record<string, any> };
  arrayPath: string;
}

function isPlainObject(value: unknown): value is Record<string, any>
{
  if (!value || typeof value !== "object" || Array.isArray(value))
  {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isUnsupportedPrefilterValue(val: unknown): boolean
{
  if (val instanceof RegExp)
  {
    return true;
  }
  if (isPlainObject(val))
  {
    if ("$ne" in val || "$not" in val || "$nin" in val)
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
  if (!isPlainObject(unwindStage) || !isPlainObject(matchStage))
  {
    return null;
  }

  const unwindKeys = Object.keys(unwindStage);
  if (unwindKeys.length !== 1 || unwindKeys[0] !== "$unwind")
  {
    return null;
  }

  const matchKeys = Object.keys(matchStage);
  if (matchKeys.length !== 1 || matchKeys[0] !== "$match")
  {
    return null;
  }

  const unwindSpec = unwindStage.$unwind;
  const matchSpec = matchStage.$match;

  if (!isPlainObject(matchSpec))
  {
    return null;
  }

  let arrayPath: string;
  let indexField: string | undefined;

  if (typeof unwindSpec === "string")
  {
    if (!unwindSpec.startsWith("$") || unwindSpec.length <= 1)
    {
      return null;
    }
    arrayPath = unwindSpec.slice(1);
  }
  else if (isPlainObject(unwindSpec))
  {
    if (
      typeof unwindSpec.path !== "string"
      || !unwindSpec.path.startsWith("$")
      || unwindSpec.path.length <= 1
      || unwindSpec.preserveNullAndEmptyArrays === true
    )
    {
      return null;
    }
    arrayPath = unwindSpec.path.slice(1);
    if (typeof unwindSpec.includeArrayIndex === "string")
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
    || summary.determinism !== "deterministic"
  )
  {
    return null;
  }

  if (indexField !== undefined)
  {
    const prefixIndex = indexField + ".";
    for (const key of Object.keys(matchSpec))
    {
      if (key === indexField || key.startsWith(prefixIndex))
      {
        return null;
      }
    }
  }

  const prefix = arrayPath + ".";
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
