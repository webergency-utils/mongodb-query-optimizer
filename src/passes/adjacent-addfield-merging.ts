import { PipelinePass } from "./types";
import {
  proveAdjacentAddFieldMerge,
} from "./projection-proofs";

export class AdjacentAddFieldMergingPass implements PipelinePass
{
  name = "adjacent-add-field-merging";

  execute(pipeline: any[]): any[]
  {
    const result = [...pipeline];

    for (let index = 1; index < result.length; index++)
    {
      const proof = proveAdjacentAddFieldMerge(
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
