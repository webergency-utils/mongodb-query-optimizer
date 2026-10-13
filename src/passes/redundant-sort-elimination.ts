import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { PipelinePass } from './types.js';
import 
{ 
    proveRedundantSortEliminationInPipeline, 
    isEmptySort 
} 
from './sort-proofs.js';

export class RedundantSortEliminationPass implements PipelinePass
{
    readonly name       = 'redundant-sort-elimination';
    readonly stageTypes = [ '$sort' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        const result: any[] = [];

        for( let i = 0; i < pipeline.length; i++ )
        {
            const currentStage = pipeline[ i ];

            if( isEmptySort( currentStage ))
            {
                continue;
            }

            if( proveRedundantSortEliminationInPipeline( pipeline, i, context ))
            {
                continue;
            }

            result.push( currentStage );
        }

        return result;
    }
}
