import { PipelinePass } from './types.js';
import { proveSortByCountSimplification } from './sort-by-count-proofs.js';

export class SortByCountSimplificationPass implements PipelinePass
{
    name = 'sort-by-count-simplification';

    execute( pipeline: any[] ): any[]
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
