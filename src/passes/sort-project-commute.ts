import { PipelinePass } from './types';
import
{
    proveSimpleProjectAdvanceAcrossSort
}
from './projection-proofs';

/**
 * Moves a simple flag project before an adjacent sort when every sort key
 * stays visible. Successful order is preserved; sort-key-dropping projects
 * stay in place.
 */
export class SortProjectCommutePass implements PipelinePass
{
    name = 'sort-project-commute';

    execute( pipeline: any[] )
    {
        const result = [ ...pipeline ];

        for( let index = 0; index < result.length - 1; index++ )
        {
            if( !proveSimpleProjectAdvanceAcrossSort( result[ index ], result[ index + 1 ] ) ){ continue }

            [ result[ index ], result[ index + 1 ] ] =
            [
                result[ index + 1 ],
                result[ index ]
            ];

            return result;
        }

        return result;
    }
}
