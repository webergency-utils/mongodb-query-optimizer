import { PipelinePass } from "./types";
import { analyzeStage } from "../analyzer/semantics";
import { provePrioritySwap } from "./movement-proofs";

const STAGE_ORDER = [
  "$match",
  "$limit",
  "$skip",
  "$sortByCount",
  "$unwind",
  "$unset",
  "$project",
  "$sort",
  "$addFields",
  "$set",
  "$lookup",
  "$graphLookup",
  "$group",
  "$bucket",
  "$bucketAuto",
  "$facet",
  "$count",
  "$sample",
];

function getStagePriority(op: string): number
{
  const idx = STAGE_ORDER.indexOf(op);
  return idx === -1 ? 999 : idx;
}

export class StagePriorityReorderPass implements PipelinePass
{
  name = "stage-priority-reorder";

  execute(pipeline: any[]): any[]
  {
    const result = [...pipeline];
    for (let index = 0; index < result.length - 1; index++)
    {
      const left = result[index];
      const right = result[index + 1];
      if (
        getStagePriority(analyzeStage(left, index).operator)
        <= getStagePriority(analyzeStage(right, index + 1).operator)
      )
      {
        continue;
      }

      const swap = provePrioritySwap(left, right);
      if (!swap)
      {
        continue;
      }

      result[index] = swap[0];
      result[index + 1] = swap[1];
      return result;
    }

    return result;
  }
}
