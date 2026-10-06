import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { PipelinePass } from './types.js';
import { proveSortByCountSimplification } from './sort-by-count-proofs.js';

export class SortByCountSimplificationPass implements PipelinePass
{
    readonly name       = 'sort-by-count-simplification';
    readonly stageTypes = [ '$sortByCount', '$group' ] as const;

    execute( pipeline: any[], _context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        const result: any[] = [];

        for( let i = 0; i < pipeline.length; i++ )
        {
            const currentStage = pipeline[i];

            if( i + 1 < pipeline.length )
            {
                const nextStage = pipeline[i + 1];
                const proof = proveSortByCountSimplification( currentStage, nextStage );

                if( proof )
                {
                    result.push( proof.sortByCountStage );
                    i++;
                    continue;
                }
            }

            result.push( currentStage );
        }

        return result;
    }
}
