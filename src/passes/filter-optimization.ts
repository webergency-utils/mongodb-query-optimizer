import { PipelinePass } from './types';
import { optimizeFilterWithContext } from '../filter-optimizer';
import { GuaranteeContext } from '../guarantees';
import { isMatchStage } from './helpers';

export class FilterOptimizationPass implements PipelinePass
{
    readonly name       = 'filter-optimization';
    readonly stageTypes = [ '$match' ] as const;
    execute( pipeline: any[], context: GuaranteeContext ): any[]
    {
        return pipeline.map(( stage: any ) =>
        {
            if(isMatchStage( stage ))
            {
                return { $match: optimizeFilterWithContext( stage.$match, context ) };
            }
            return stage;
        });
    }
}

