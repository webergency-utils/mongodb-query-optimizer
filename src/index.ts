import { optimizeFilter } from "./filter-optimizer";
import { optimizePipelineWithProductionRegistry } from "./passes/registry";

export { optimizeFilter };
export { getStageInfo } from "./analyzer";

export function optimizePipeline(pipeline: any[]): any[]
{
  return optimizePipelineWithProductionRegistry(pipeline);
}
