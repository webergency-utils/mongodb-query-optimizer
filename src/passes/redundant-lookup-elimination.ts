import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { PipelinePass } from './types.js';
import {
    proveRedundantLookupElimination
} from './movement-proofs.js';

/**
 * Drops a simple equality lookup when the next stage discards the alias.
 * Lookup plus unwind stays in place because multiplicity is unproven.
 */
export class RedundantLookupEliminationPass implements PipelinePass
{
    readonly name       = 'redundant-lookup-elimination';
    readonly stageTypes = [ '$lookup' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        const result = [ ...pipeline ];

        for( let index = 0; index < result.length - 1; index++ )
        {
            if( !proveRedundantLookupElimination( result[index], result[index + 1], context ))
            {
                continue;
            }

            result.splice( index, 1 );
            return result;
        }

        return result;
    }
}
