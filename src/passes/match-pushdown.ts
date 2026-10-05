import { PipelinePass } from "./types";
import {
  proveMatchPushdownAcrossStage,
} from "./movement-proofs";

export class MatchPushdownPass implements PipelinePass
{
  name = "match-pushdown";

  execute(pipeline: any[]): any[]
  {
    const result = [...pipeline];

    for (let index = 1; index < result.length; index++)
    {
      const proof = proveMatchPushdownAcrossStage(
        result[index - 1],
        result[index],
      );
      if (!proof)
      {
        continue;
      }

      result[index] = result[index - 1];
      result[index - 1] = proof.matchStage;
      return result;
    }

    return result;
  }
}
