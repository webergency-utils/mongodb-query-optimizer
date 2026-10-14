import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees';
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

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        let result: any[] | null = null;
        let current = pipeline;

        for( let index = 1; index < current.length; index++ )
        {
            let currentIndex = index;

            while( currentIndex > 0 )
            {
                if( !proveLimitAdvanceAcrossStage(
                    current[ currentIndex - 1 ],
                    current[ currentIndex ],
                    context
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
