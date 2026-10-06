import { PipelinePass } from './types';
import
{
    proveLookupDelayAcrossStage
}
from './movement-proofs';

/**
 * Delays simple equality lookups past match, sort, limit, and skip when the
 * follower does not consume the alias. Lookup errors are assumed absent.
 */
export class LookupDelayPass implements PipelinePass
{
    readonly name       = 'lookup-delay';
    readonly stageTypes = [ '$lookup' ] as const;

    execute( pipeline: any[] ): any[]
    {
        let changed = false;
        const result = [ ...pipeline ];

        for( let index = result.length - 2; index >= 0; index-- )
        {
            let currentIndex = index;

            while( currentIndex < result.length - 1 )
            {
                if( !proveLookupDelayAcrossStage(
                    result[ currentIndex ],
                    result[ currentIndex + 1 ]
                ))
                {
                    break;
                }

                const nextStage = result[ currentIndex + 1 ];
                result[ currentIndex + 1 ] = result[ currentIndex ];
                result[ currentIndex ] = nextStage;
                currentIndex++;
                changed = true;
            }
        }

        return changed ? result : pipeline;
    }
}
