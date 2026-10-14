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
        let result: any[] | undefined;

        for( let i = 0; i < pipeline.length; i++ )
        {
            const stage = pipeline[ i ];

            if( isMatchStage( stage ))
            {
                const optimized = optimizeFilterWithContext( stage.$match, context );

                if( isEmptyObject( optimized ))
                {
                    result ??= pipeline.slice( 0, i );
                    continue;
                }

                if( optimized !== stage.$match )
                {
                    result ??= pipeline.slice( 0, i );
                    result.push({ $match: optimized });
                    continue;
                }
            }

            result?.push( stage );
        }

        return result ?? pipeline;
    }
}


