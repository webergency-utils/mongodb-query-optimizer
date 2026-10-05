import { deepClone } from "../utils.js";

function isPlainObject(value: unknown): value is Record<string, any>
{
  if (!value || typeof value !== "object" || Array.isArray(value))
  {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFieldPath(value: unknown): value is string
{
  return (
    typeof value === "string"
    && value.startsWith("$")
    && !value.startsWith("$$")
    && value.length > 1
  );
}

function isLiteral(value: unknown): boolean
{
  if (value === undefined || typeof value === "function" || typeof value === "symbol")
  {
    return false;
  }

  if (typeof value === "string")
  {
    return !value.startsWith("$");
  }

  if (Array.isArray(value))
  {
    return value.every(isLiteral);
  }

  if (isPlainObject(value))
  {
    for (const [k, v] of Object.entries(value))
    {
      if (k.startsWith("$") || !isLiteral(v))
      {
        return false;
      }
    }
    return true;
  }

  return true;
}

function normalizeBinaryComparison(
  operator: string,
  args: unknown[],
): Record<string, any> | null
{
  if (!Array.isArray(args) || args.length !== 2)
  {
    return null;
  }

  const [arg0, arg1] = args;
  const arg0IsPath = isFieldPath(arg0);
  const arg1IsPath = isFieldPath(arg1);

  if (arg0IsPath === arg1IsPath)
  {
    // Either both are paths or neither is a path
    return null;
  }

  if (arg0IsPath && isLiteral(arg1))
  {
    const field = arg0.slice(1);
    switch (operator)
    {
      case "$eq":
        return { [field]: deepClone(arg1) };
      case "$ne":
        return { [field]: { $ne: deepClone(arg1) } };
      case "$gt":
        return { [field]: { $gt: deepClone(arg1) } };
      case "$gte":
        return { [field]: { $gte: deepClone(arg1) } };
      case "$lt":
        return { [field]: { $lt: deepClone(arg1) } };
      case "$lte":
        return { [field]: { $lte: deepClone(arg1) } };
      case "$in":
        return Array.isArray(arg1) ? { [field]: { $in: deepClone(arg1) } } : null;
      default:
        return null;
    }
  }

  if (arg1IsPath && isLiteral(arg0))
  {
    const field = arg1.slice(1);
    switch (operator)
    {
      case "$eq":
        return { [field]: deepClone(arg0) };
      case "$ne":
        return { [field]: { $ne: deepClone(arg0) } };
      case "$gt":
        // arg0 > field <=> field < arg0
        return { [field]: { $lt: deepClone(arg0) } };
      case "$gte":
        // arg0 >= field <=> field <= arg0
        return { [field]: { $lte: deepClone(arg0) } };
      case "$lt":
        // arg0 < field <=> field > arg0
        return { [field]: { $gt: deepClone(arg0) } };
      case "$lte":
        // arg0 <= field <=> field >= arg0
        return { [field]: { $gte: deepClone(arg0) } };
      default:
        return null;
    }
  }

  return null;
}

export function proveExprToNativeMatch(
  exprObject: unknown,
): Record<string, any> | null
{
  if (!isPlainObject(exprObject))
  {
    return null;
  }

  const keys = Object.keys(exprObject);
  if (keys.length !== 1)
  {
    return null;
  }

  const operator = keys[0]!;
  const value = exprObject[operator];

  if (operator === "$and")
  {
    if (!Array.isArray(value) || value.length === 0)
    {
      return null;
    }

    const merged: Record<string, any> = {};

    for (const item of value)
    {
      const normalizedItem = proveExprToNativeMatch(item);
      if (!normalizedItem)
      {
        return null;
      }

      for (const [field, condition] of Object.entries(normalizedItem))
      {
        if (!(field in merged))
        {
          merged[field] = condition;
        }
        else
        {
          const existing = merged[field];
          if (
            isPlainObject(existing)
            && isPlainObject(condition)
            && Object.keys(existing).every((k) => k.startsWith("$"))
            && Object.keys(condition).every((k) => k.startsWith("$"))
          )
          {
            merged[field] = { ...existing, ...condition };
          }
          else
          {
            return null;
          }
        }
      }
    }

    return merged;
  }

  return normalizeBinaryComparison(operator, value);
}
