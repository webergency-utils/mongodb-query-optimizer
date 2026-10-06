import { PipelinePass } from './types';
import
{
    proveLimitAdvanceAcrossStage
}
from './movement-proofs';

export class LimitAdvancePass implements PipelinePass
{
    readonly name       = 'limit-advance';
    readonly stageTypes = [ '$limit', '$skip' ] as const;

    execute( pipeline: any[] ): any[]
    {
        let changed = false;
        const result = [ ...pipeline ];

        for( let index = 1; index < result.length; index++ )
        {
            let currentIndex = index;

            while( currentIndex > 0 )
            {
                if( !proveLimitAdvanceAcrossStage(
                    result[ currentIndex - 1 ],
                    result[ currentIndex ]
                ))
                {
                    break;
                }

                const previousStage = result[ currentIndex - 1 ];
                result[ currentIndex - 1 ] = result[ currentIndex ];
                result[ currentIndex ] = previousStage;
                currentIndex--;
                changed = true;
            }
        }

        return changed ? result : pipeline;
    }
}
