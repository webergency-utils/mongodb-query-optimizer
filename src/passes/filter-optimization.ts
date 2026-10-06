import { PipelinePass } from './types';
import { optimizeFilter } from '../filter-optimizer';
import { isMatchStage } from './helpers';

export class FilterOptimizationPass implements PipelinePass
{
    readonly name       = 'filter-optimization';
    readonly stageTypes = [ '$match' ] as const;
    execute( pipeline: any[] ): any[]
    {
        return pipeline.map(( stage: any ) =>
        {
            if(isMatchStage( stage ))
            {
                return { $match: optimizeFilter( stage.$match ) };
            }
            return stage;
        });
    }
}

