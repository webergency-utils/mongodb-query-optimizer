import {
  FilterRule,
  getActiveFilterRules,
  withCandidateFilterRuleProfile,
} from "./filter-rule-registry";
import { isFilterRewriteSafe } from "./analyzer/filters";
import { structuralFingerprint } from "./utils";

const DEFAULT_FILTER_SWEEP_BUDGET = 32;

function isPlainObject(value: any): value is Record<string, any>
{
  if (!value || typeof value !== "object" || Array.isArray(value))
  {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isOperatorSubdocument(value: any): value is Record<string, any>
{
  if (!isPlainObject(value))
  {
    return false;
  }

  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith("$"));
}

function optimizeOperatorChildren(
  operatorDocument: Record<string, any>,
  rules: readonly FilterRule[],
): Record<string, any>
{
  let result = operatorDocument;

  for (const [operator, value] of Object.entries(operatorDocument))
  {
    if (operator !== "$not" && operator !== "$elemMatch")
    {
      continue;
    }

    const optimized = applyFilterSweep(value, rules);
    if (optimized !== value)
    {
      if (result === operatorDocument)
      {
        result = { ...operatorDocument };
      }

      result[operator] = optimized;
    }
  }

  return result;
}

function applyFilterDocumentSweep(
  filter: Record<string, any>,
  rules: readonly FilterRule[],
): any
{
  if (!isFilterRewriteSafe(filter))
  {
    return filter;
  }

  let current = filter;

  for (const [key, value] of Object.entries(filter))
  {
    let optimizedValue = value;

    if ((key === "$and" || key === "$or") && Array.isArray(value))
    {
      optimizedValue = value.map((condition) =>
        applyFilterSweep(condition, rules),
      );
    }
    else if (!key.startsWith("$") && isOperatorSubdocument(value))
    {
      optimizedValue = optimizeOperatorChildren(value, rules);
    }

    if (optimizedValue !== value)
    {
      if (current === filter)
      {
        current = { ...filter };
      }

      current[key] = optimizedValue;
    }
  }

  for (const rule of rules)
  {
    if (!isPlainObject(current))
    {
      return current;
    }

    current = rule.apply(current);
  }

  return current;
}

function applyFilterSweep(filter: any, rules: readonly FilterRule[]): any
{
  if (
    !filter
    || typeof filter !== "object"
    || Array.isArray(filter)
    || filter instanceof Date
    || filter instanceof RegExp
  )
  {
    return filter;
  }

  if (!isPlainObject(filter))
  {
    return filter;
  }

  return applyFilterDocumentSweep(filter, rules);
}

function optimizeFilterWithRules(
  filter: any,
  rules: readonly FilterRule[],
  sweepBudget = DEFAULT_FILTER_SWEEP_BUDGET,
): any
{
  if (
    !filter
    || typeof filter !== "object"
    || Array.isArray(filter)
    || filter instanceof Date
    || filter instanceof RegExp
  )
  {
    return filter;
  }

  if (!isPlainObject(filter))
  {
    return filter;
  }

  const rootCopy = { ...filter };
  if (
    rules.length === 0
    || !Number.isSafeInteger(sweepBudget)
    || sweepBudget <= 0
  )
  {
    return rootCopy;
  }

  let current = rootCopy;
  let currentFingerprint = structuralFingerprint(current);
  const history = new Set<string>([currentFingerprint]);

  for (let sweep = 0; sweep < sweepBudget; sweep++)
  {
    const next = applyFilterSweep(current, rules);
    const nextFingerprint = structuralFingerprint(next);

    if (nextFingerprint === currentFingerprint)
    {
      return next;
    }

    if (history.has(nextFingerprint))
    {
      return rootCopy;
    }

    history.add(nextFingerprint);
    current = next;
    currentFingerprint = nextFingerprint;
  }

  return rootCopy;
}

export function optimizeFilter<T = any>( filter: any ): T
{
    return optimizeFilterWithRules( filter, getActiveFilterRules());
}

/**
 * Package-private scheduler seam for direct filter cycle and budget tests.
 */
export function optimizeFilterWithRulesForTesting(
  filter: any,
  rules: readonly FilterRule[],
  sweepBudget = DEFAULT_FILTER_SWEEP_BUDGET,
): any
{
  return optimizeFilterWithRules(filter, rules, sweepBudget);
}

/**
 * Package-private candidate seam. The package root intentionally does not export it.
 */
export function optimizeFilterWithCandidateProfile(
  filter: any,
  selectedRuleIds?: readonly string[],
): any
{
  if (selectedRuleIds)
  {
    return withCandidateFilterRuleProfile(
      () => optimizeFilter(filter),
      selectedRuleIds,
    );
  }

  return withCandidateFilterRuleProfile(() => optimizeFilter(filter));
}
