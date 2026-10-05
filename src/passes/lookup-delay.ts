import { PipelinePass } from "./types";
import {
  proveLookupDelayAcrossStage,
} from "./movement-proofs";

/**
 * Delays simple equality lookups past match, sort, limit, and skip when the
 * follower does not consume the alias. Lookup errors are assumed absent.
 */
export class LookupDelayPass implements PipelinePass
{
  name = "lookup-delay";

  execute(pipeline: any[]): any[]
  {
    const result = [...pipeline];

    for (let index = 0; index < result.length - 1; index++)
    {
      if (!proveLookupDelayAcrossStage(result[index], result[index + 1]))
      {
        continue;
      }

      [result[index], result[index + 1]] = [
        result[index + 1],
        result[index],
      ];
      return result;
    }

    return result;
  }
}
