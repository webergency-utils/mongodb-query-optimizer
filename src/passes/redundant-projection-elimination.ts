import { PipelinePass } from "./types";

export class RedundantProjectionEliminationPass implements PipelinePass
{
  name = "redundant-projection-elimination";

  execute(pipeline: any[]): any[]
  {
    return [...pipeline];
  }
}
