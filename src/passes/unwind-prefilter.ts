import { PipelinePass } from "./types.js";
import { proveUnwindPrefilter } from "./unwind-proofs.js";
import { structuralFingerprint } from "../utils.js";

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
          const alreadyPresent = (
            result.length > 0
            && result[result.length - 1]?.$match !== undefined
            && structuralFingerprint(result[result.length - 1].$match)
              === structuralFingerprint(proof.prefilterStage.$match)
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
