import { PipelinePass } from "./types";
import {
  proveLimitAdvanceAcrossStage,
} from "./movement-proofs";

export class LimitAdvancePass implements PipelinePass
{
  name = "limit-advance";

  execute(pipeline: any[]): any[]
  {
    const result = [...pipeline];

    for (let index = 1; index < result.length; index++)
    {
      if (!proveLimitAdvanceAcrossStage(
        result[index - 1],
        result[index],
      ))
      {
        continue;
      }

      [result[index - 1], result[index]] = [
        result[index],
        result[index - 1],
      ];
      return result;
    }

    return result;
  }
}
