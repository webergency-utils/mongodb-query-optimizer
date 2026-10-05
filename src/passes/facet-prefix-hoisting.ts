import { PipelinePass } from "./types.js";
import { proveFacetPrefixHoisting } from "./facet-proofs.js";

export class FacetPrefixHoistingPass implements PipelinePass
{
  name = "facet-prefix-hoisting";

  execute(pipeline: any[]): any[]
  {
    const result: any[] = [];

    for (const stage of pipeline)
    {
      const proof = proveFacetPrefixHoisting(stage);
      if (proof)
      {
        result.push(...proof.hoistedStages);
        result.push(proof.simplifiedFacet);
      }
      else
      {
        result.push(stage);
      }
    }

    return result;
  }
}
