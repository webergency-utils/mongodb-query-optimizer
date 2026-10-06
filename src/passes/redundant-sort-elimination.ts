import { PipelinePass } from './types.js';
import 
{ 
    proveRedundantSortElimination, 
    isEmptySort 
} 
from './sort-proofs.js';

export class RedundantSortEliminationPass implements PipelinePass
{
    readonly name       = 'redundant-sort-elimination';
    readonly stageTypes = [ '$sort' ] as const;

    execute( pipeline: any[] ): any[]
    {
        const result: any[] = [];

        for( let i = 0; i < pipeline.length; i++ )
        {
            const currentStage = pipeline[i];

            if( isEmptySort( currentStage ))
            {
                continue;
            }

            if( i + 1 < pipeline.length )
            {
                const nextStage = pipeline[i + 1];

                if( proveRedundantSortElimination( currentStage, nextStage ))
                {
                    continue;
                }
            }

            result.push( currentStage );
        }

        return result;
    }
}
