import { optimizeFilter } from './filter-optimizer';
import { OptimizerOptions } from './guarantees';
import { optimizePipelineWithProductionRegistry } from './passes/registry';

export { optimizeFilter };
export type { OptimizerOptions };
export { getStageInfo } from './analyzer';

/**
 * Optimizes an aggregation pipeline. With no options, field order inside output
 * documents may change and a failing query may fail differently or succeed.
 * Pipelines ending in `$out` or `$merge` are always strict about errors.
 */
export function optimizePipeline<T = any>( pipeline: any[], options?: OptimizerOptions ): T[]
{
    return optimizePipelineWithProductionRegistry( pipeline, options );
}

