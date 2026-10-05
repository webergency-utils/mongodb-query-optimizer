import { optimizeFilter } from './filter-optimizer';
import { optimizePipelineWithProductionRegistry } from './passes/registry';

export { optimizeFilter };
export { getStageInfo } from './analyzer';

export function optimizePipeline<T = any>( pipeline: any[] ): T[]
{
    return optimizePipelineWithProductionRegistry( pipeline );
}

