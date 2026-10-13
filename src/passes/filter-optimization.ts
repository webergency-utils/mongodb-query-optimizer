import { PipelinePass } from './types.js';
import { optimizeFilterWithContext } from '../filter-optimizer.js';
import { GuaranteeContext } from '../guarantees.js';
import { isEmptyObject } from '../utils.js';
import { isMatchStage } from './helpers.js';

export class FilterOptimizationPass implements PipelinePass
{
    readonly name       = 'filter-optimization';
    readonly stageTypes = [ '$match' ] as const;

    execute( pipeline: any[], context: GuaranteeContext ): any[]
    {
        const result: any[] = [];

        for( const stage of pipeline )
        {
            if( isMatchStage( stage ))
            {
                const optimized = optimizeFilterWithContext( stage.$match, context );

                if( isEmptyObject( optimized ))
                {
                    continue;
                }

                result.push({ $match: optimized });
                continue;
            }

            result.push( stage );
        }

        return result;
    }
}


