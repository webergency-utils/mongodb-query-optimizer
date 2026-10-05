import { PipelinePass } from "./types.js";
import { proveUnwindPrefilter } from "./unwind-proofs.js";
import { structuralFingerprint } from "../utils.js";

function hasPrefilter(
  matchSpec: any,
  arrayPath: string,
  expectedCondition: any,
): boolean
{
  if (!matchSpec || typeof matchSpec !== "object")
  {
    return false;
  }

  if (matchSpec[arrayPath] !== undefined)
  {
    return (
      structuralFingerprint(matchSpec[arrayPath])
      === structuralFingerprint(expectedCondition)
    );
  }

  if (Array.isArray(matchSpec.$and))
  {
    return matchSpec.$and.some((clause: any) =>
      hasPrefilter(clause, arrayPath, expectedCondition),
    );
  }

  return false;
}

export class UnwindPrefilterPass implements PipelinePass
{
  name = "unwind-prefilter";

  execute(pipeline: any[]): any[]
  {
    const result: any[] = [];

    for (let i = 0; i < pipeline.length; i++)
    {
      const currentStage = pipeline[i];
      if (i + 1 < pipeline.length)
      {
        const nextStage = pipeline[i + 1];
        const proof = proveUnwindPrefilter(currentStage, nextStage);
        if (proof)
        {
          const prevMatch = result.length > 0
            ? result[result.length - 1]?.$match
            : undefined;

          const alreadyPresent = prevMatch !== undefined && hasPrefilter(
            prevMatch,
            proof.arrayPath,
            proof.prefilterStage.$match[proof.arrayPath],
          );

          if (!alreadyPresent)
          {
            result.push(proof.prefilterStage);
          }
        }
      }

      result.push(currentStage);
    }

    return result;
  }
}
