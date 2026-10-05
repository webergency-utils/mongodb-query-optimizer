import { PipelinePass } from "./types";
import {
  proveAdjacentProjectMerge,
} from "./projection-proofs";

export class AdjacentProjectMergingPass implements PipelinePass
{
  name = "adjacent-project-merging";

  execute(pipeline: any[]): any[]
  {
    const result = [...pipeline];

    for (let index = 1; index < result.length; index++)
    {
      const proof = proveAdjacentProjectMerge(
        result[index - 1],
        result[index],
      );
      if (!proof)
      {
        continue;
      }

      result.splice(index - 1, 2, proof.mergedStage);
      return result;
    }

    return result;
  }
}
