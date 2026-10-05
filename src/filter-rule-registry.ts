import { isFilterRewriteSafe } from "./analyzer/filters";
import { structuralFingerprint } from "./utils";

type FilterDocument = Record<string, any>;

const registeredFilterRuleIds = Object.freeze([
  "simplify-equality",
  "simplify-singleton-in",
  "flatten-conjunctions",
  "flatten-disjunctions",
  "simplify-conjunction-identities",
  "simplify-disjunction-identities",
  "deduplicate-conjunctions",
  "merge-conjunctions",
] as const);

export type FilterRuleId = typeof registeredFilterRuleIds[number];

const activeFilterRuleIds: readonly FilterRuleId[] = Object.freeze([
  "simplify-equality",
  "simplify-singleton-in",
  "flatten-conjunctions",
  "flatten-disjunctions",
  "simplify-conjunction-identities",
  "simplify-disjunction-identities",
  "deduplicate-conjunctions",
  "merge-conjunctions",
]);

const containedFilterRuleIds: readonly FilterRuleId[] = Object.freeze([]);

export interface FilterRuleRegistryStatus
{
  readonly registered: readonly FilterRuleId[];
  readonly active: readonly FilterRuleId[];
  readonly contained: readonly FilterRuleId[];
}

const filterRuleRegistryStatus: FilterRuleRegistryStatus = Object.freeze({
  registered: registeredFilterRuleIds,
  active: activeFilterRuleIds,
  contained: containedFilterRuleIds,
});

export interface FilterRule
{
  readonly id: FilterRuleId;
  apply(filter: FilterDocument): any;
}

function isPlainObject(value: any): value is FilterDocument
{
  if (!value || typeof value !== "object" || Array.isArray(value))
  {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isOperatorSubdocument(value: any): value is FilterDocument
{
  if (!isPlainObject(value))
  {
    return false;
  }

  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith("$"));
}

function isEmptyFilter(value: any): boolean
{
  return isPlainObject(value) && Object.keys(value).length === 0;
}

function isSafeImplicitEqualityValue(value: any): boolean
{
  return (
    typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  );
}

function simplifySingleFieldOperator(
  filter: FilterDocument,
  operator: "$eq" | "$in",
): FilterDocument
{
  let result = filter;

  for (const [key, value] of Object.entries(filter))
  {
    if (
      key.startsWith("$")
      || !isOperatorSubdocument(value)
      || Object.keys(value).length !== 1
      || !(operator in value)
    )
    {
      continue;
    }

    const operand = operator === "$eq"
      ? value.$eq
      : Array.isArray(value.$in) && value.$in.length === 1
        ? value.$in[0]
        : undefined;

    if (!isSafeImplicitEqualityValue(operand))
    {
      continue;
    }

    if (result === filter)
    {
      result = { ...filter };
    }

    result[key] = operand;
  }

  return result;
}

const simplifyEqualityRule: FilterRule = {
  id: "simplify-equality",
  apply(filter)
  {
    return simplifySingleFieldOperator(filter, "$eq");
  },
};

const simplifySingletonInRule: FilterRule = {
  id: "simplify-singleton-in",
  apply(filter)
  {
    return simplifySingleFieldOperator(filter, "$in");
  },
};

function flattenLogicalArray(
  filter: FilterDocument,
  operator: "$and" | "$or",
): FilterDocument
{
  const conditions = filter[operator];
  if (
    !Array.isArray(conditions)
    || conditions.length === 0
    || !isFilterRewriteSafe(filter)
  )
  {
    return filter;
  }

  let changed = false;
  const flattened: any[] = [];

  for (const condition of conditions)
  {
    if (
      isPlainObject(condition)
      && Object.keys(condition).length === 1
      && Array.isArray(condition[operator])
      && condition[operator].length > 0
    )
    {
      flattened.push(...condition[operator]);
      changed = true;
    }
    else
    {
      flattened.push(condition);
    }
  }

  return changed
    ? { ...filter, [operator]: flattened }
    : filter;
}

const flattenConjunctionsRule: FilterRule = {
  id: "flatten-conjunctions",
  apply(filter)
  {
    return flattenLogicalArray(filter, "$and");
  },
};

const flattenDisjunctionsRule: FilterRule = {
  id: "flatten-disjunctions",
  apply(filter)
  {
    return flattenLogicalArray(filter, "$or");
  },
};

const simplifyConjunctionIdentitiesRule: FilterRule = {
  id: "simplify-conjunction-identities",
  apply(filter)
  {
    const conditions = filter.$and;
    if (
      !Array.isArray(conditions)
      || conditions.length === 0
      || !isFilterRewriteSafe(filter)
    )
    {
      return filter;
    }

    const remaining = conditions.filter((condition) => !isEmptyFilter(condition));
    const isOnlyCondition = Object.keys(filter).length === 1;

    if (isOnlyCondition && remaining.length === 0)
    {
      return {};
    }

    if (isOnlyCondition && remaining.length === 1)
    {
      return remaining[0];
    }

    if (remaining.length === 0)
    {
      const { $and: _removed, ...rest } = filter;
      return rest;
    }

    return remaining.length === conditions.length
      ? filter
      : { ...filter, $and: remaining };
  },
};

const simplifyDisjunctionIdentitiesRule: FilterRule = {
  id: "simplify-disjunction-identities",
  apply(filter)
  {
    const conditions = filter.$or;
    if (
      !Array.isArray(conditions)
      || conditions.length === 0
      || !conditions.some((condition) => isEmptyFilter(condition))
      || !isFilterRewriteSafe(filter)
    )
    {
      return filter;
    }

    const { $or: _removed, ...rest } = filter;
    return rest;
  },
};

const deduplicateConjunctionsRule: FilterRule = {
  id: "deduplicate-conjunctions",
  apply(filter)
  {
    const conditions = filter.$and;
    if (
      !Array.isArray(conditions)
      || conditions.length === 0
      || !isFilterRewriteSafe(filter)
    )
    {
      return filter;
    }

    const seen = new Set<string>();
    const unique: any[] = [];

    for (const condition of conditions)
    {
      const fingerprint = structuralFingerprint(condition);
      if (!seen.has(fingerprint))
      {
        seen.add(fingerprint);
        unique.push(condition);
      }
    }

    return unique.length === conditions.length
      ? filter
      : { ...filter, $and: unique };
  },
};

function isFieldOnlyFilter(value: any): value is FilterDocument
{
  if (!isPlainObject(value))
  {
    return false;
  }

  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => !key.startsWith("$"));
}

const mergeConjunctionsRule: FilterRule = {
  id: "merge-conjunctions",
  apply(filter)
  {
    const conditions = filter.$and;
    if (
      !Array.isArray(conditions)
      || conditions.length === 0
      || !isFilterRewriteSafe(filter)
    )
    {
      return filter;
    }

    const { $and: _removed, ...rest } = filter;
    let merged = { ...rest };
    const occupiedFields = new Set(
      Object.keys(rest).filter((key) => !key.startsWith("$")),
    );
    const remaining: any[] = [];
    let changed = false;

    for (const condition of conditions)
    {
      if (!isFieldOnlyFilter(condition))
      {
        remaining.push(condition);
        continue;
      }

      const fields = Object.keys(condition);
      if (fields.some((field) => occupiedFields.has(field)))
      {
        remaining.push(condition);
        continue;
      }

      merged = { ...merged, ...condition };
      for (const field of fields)
      {
        occupiedFields.add(field);
      }
      changed = true;
    }

    if (!changed)
    {
      return filter;
    }

    return remaining.length === 0
      ? merged
      : { ...merged, $and: remaining };
  },
};

const candidateFilterRuleRegistry: Readonly<Record<FilterRuleId, FilterRule>> = Object.freeze({
  "simplify-equality": simplifyEqualityRule,
  "simplify-singleton-in": simplifySingletonInRule,
  "flatten-conjunctions": flattenConjunctionsRule,
  "flatten-disjunctions": flattenDisjunctionsRule,
  "simplify-conjunction-identities": simplifyConjunctionIdentitiesRule,
  "simplify-disjunction-identities": simplifyDisjunctionIdentitiesRule,
  "deduplicate-conjunctions": deduplicateConjunctionsRule,
  "merge-conjunctions": mergeConjunctionsRule,
});

const candidateFilterProfile: readonly FilterRuleId[] =
  registeredFilterRuleIds;

const productionFilterRuleRegistry: readonly FilterRule[] = Object.freeze(
  activeFilterRuleIds.map((id) => candidateFilterRuleRegistry[id]),
);

let injectedFilterRuleRegistry: readonly FilterRule[] | undefined;

/**
 * Package-private immutable registry introspection for proof-manifest tests.
 */
export function getFilterRuleRegistryStatus(): FilterRuleRegistryStatus
{
  return filterRuleRegistryStatus;
}

export function getActiveFilterRules(): readonly FilterRule[]
{
  return injectedFilterRuleRegistry ?? productionFilterRuleRegistry;
}

function resolveCandidateRules(selectedRuleIds: readonly string[]): readonly FilterRule[]
{
  const resolved: FilterRule[] = [];

  for (const id of selectedRuleIds)
  {
    const rule = (candidateFilterRuleRegistry as Record<string, FilterRule | undefined>)[id];
    if (!rule)
    {
      throw new Error(`Filter rule is not registered: ${id}`);
    }

    resolved.push(rule);
  }

  return Object.freeze(resolved);
}

export function withCandidateFilterRuleProfile<T>(
  run: () => T,
  selectedRuleIds: readonly string[] = candidateFilterProfile,
): T
{
  const selectedRules = resolveCandidateRules(selectedRuleIds);
  const previousRegistry = injectedFilterRuleRegistry;
  injectedFilterRuleRegistry = selectedRules;

  try
  {
    return run();
  }
  finally
  {
    injectedFilterRuleRegistry = previousRegistry;
  }
}
