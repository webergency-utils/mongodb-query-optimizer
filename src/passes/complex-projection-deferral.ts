import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { canMoveStageAcrossStage } from './guarantee-guards.js';
import { PipelinePass } from './types.js';
import
{
    proveAddFieldDeferralAcrossSort
}
from './projection-proofs.js';

/**
 * Delays a deterministic add/set past an adjacent sort when the sort keys
 * do not overlap the written fields.
 */
export class ComplexProjectionDeferralPass implements PipelinePass
{
    readonly name       = 'complex-projection-deferral';
    readonly stageTypes = [ '$addFields', '$set' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        const result = [ ...pipeline ];

        for( let index = 0; index < result.length - 1; index++ )
        {
            if( !proveAddFieldDeferralAcrossSort( result[index], result[index + 1] ))
            {
                continue;
            }

            if( !canMoveStageAcrossStage(
                result[index],
                result[index + 1],
                'later',
                context,
                result.slice( index + 2 )
            ))
            {
                continue;
            }

            [ result[index], result[index + 1] ] = [
                result[index + 1],
                result[index]
            ];
            return result;
        }

        return result;
    }
}
