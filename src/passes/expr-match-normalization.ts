import { PipelinePass } from "./types.js";
import { proveExprToNativeMatch } from "./expr-normalization-proofs.js";

function isPlainObject(value: unknown): value is Record<string, any>
{
  if (!value || typeof value !== "object" || Array.isArray(value))
  {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export class ExprMatchNormalizationPass implements PipelinePass
{
  name = "expr-match-normalization";

  execute(pipeline: any[]): any[]
  {
    const result: any[] = [];

    for (const stage of pipeline)
    {
      if (
        isPlainObject(stage)
        && Object.keys(stage).length === 1
        && "$match" in stage
        && isPlainObject(stage.$match)
        && "$expr" in stage.$match
      )
      {
        const normalized = proveExprToNativeMatch(stage.$match.$expr);
        if (normalized)
        {
          const rest: Record<string, any> = {};
          for (const [k, v] of Object.entries(stage.$match))
          {
            if (k !== "$expr")
            {
              rest[k] = v;
            }
          }

          result.push({
            $match: {
              ...rest,
              ...normalized,
            },
          });
          continue;
        }
      }

      result.push(stage);
    }

    return result;
  }
}
