import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { PipelinePass } from './types.js';
import {
    proveRedundantLookupEliminationAcrossSuffix
} from './movement-proofs.js';

/**
 * Drops a simple equality or pipeline lookup when downstream stages discard the alias.
 * Lookup plus unwind stays in place because multiplicity is unproven.
 */
export class RedundantLookupEliminationPass implements PipelinePass
{
    readonly name       = 'redundant-lookup-elimination';
    readonly stageTypes = [ '$lookup' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        for( let index = 0; index < pipeline.length - 1; index++ )
        {
            if( !proveRedundantLookupEliminationAcrossSuffix( pipeline[ index ], pipeline.slice( index + 1 ), context ))
            {
                continue;
            }

            const result = [ ...pipeline ];
            result.splice( index, 1 );
            return result;
        }

        return pipeline;
    }
}
