import { PipelinePass } from './types.js';
import { optimizeFilterWithContext } from '../filter-optimizer.js';
import { GuaranteeContext } from '../guarantees.js';
import { isMatchStage } from './helpers.js';

export class FilterOptimizationPass implements PipelinePass
{
    readonly name       = 'filter-optimization';
    readonly stageTypes = [ '$match' ] as const;

    execute( pipeline: any[], context: GuaranteeContext ): any[]
    {
        return pipeline.map(( stage: any ) =>
        {
            if( isMatchStage( stage ))
            {
                return { $match: optimizeFilterWithContext( stage.$match, context ) };
            }

            return stage;
        } );
    }
}


