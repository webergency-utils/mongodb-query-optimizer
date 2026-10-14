import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { PipelinePass } from './types.js';
import
{
    proveSimpleProjectAdvanceAcrossSort
}
from './projection-proofs.js';

/**
 * Moves a simple flag project before an adjacent sort when every sort key
 * stays visible. Successful order is preserved; sort-key-dropping projects
 * stay in place.
 */
export class SortProjectCommutePass implements PipelinePass
{
    readonly name       = 'sort-project-commute';
    readonly stageTypes = [ '$project', '$unset', '$sort' ] as const;

    execute( pipeline: any[], _context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        let result: any[] | null = null;
        let current = pipeline;

        for( let index = 1; index < current.length; index++ )
        {
            let currentIndex = index;

            while( currentIndex > 0 )
            {
                if( !proveSimpleProjectAdvanceAcrossSort(
                    current[ currentIndex - 1 ],
                    current[ currentIndex ]
                ))
                {
                    break;
                }

                if( result === null )
                {
                    result = [ ...pipeline ];
                    current = result;
                }

                const previousStage = result[ currentIndex - 1 ];
                result[ currentIndex - 1 ] = result[ currentIndex ];
                result[ currentIndex ] = previousStage;
                currentIndex--;
            }
        }

        return result ?? pipeline;
    }
}
