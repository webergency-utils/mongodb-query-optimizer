import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { getStageSpec } from './helpers.js';
import { PipelinePass } from './types.js';
import 
{ 
    proveRedundantDownstreamSortInPipeline,
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
        const forwardFiltered: any[] = [];
        let sortCount = 0;

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

            if( getStageSpec( currentStage, '$sort' ) !== null )
            {
                sortCount++;
            }

            forwardFiltered.push( currentStage );
        }

        if( sortCount < 2 )
        {
            return forwardFiltered;
        }

        const result: any[] = [];

        for( let i = 0; i < forwardFiltered.length; i++ )
        {
            const currentStage = forwardFiltered[ i ];
            const candidatePipeline = [ ...result, currentStage ];

            if( proveRedundantDownstreamSortInPipeline( candidatePipeline, candidatePipeline.length - 1, context ))
            {
                continue;
            }

            result.push( currentStage );
        }

        return result;
    }
}
