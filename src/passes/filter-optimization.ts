import { PipelinePass } from './types';
import { optimizeFilter } from '../filter-optimizer';
import { isMatchStage } from './helpers';

function isStandaloneMatchStage(stage: any): boolean
{
    return isMatchStage(stage) && Object.keys(stage).length === 1;
}

export class FilterOptimizationPass implements PipelinePass {
    name = 'filter-optimization';
    execute(pipeline: any[]): any[] {
        return pipeline.map((stage: any) => {
            if (isStandaloneMatchStage(stage)) {
                return { $match: optimizeFilter(stage.$match) };
            }
            return stage;
        });
    }
}
