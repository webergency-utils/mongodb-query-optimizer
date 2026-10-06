import { PipelinePass } from './types';
import {
    proveRedundantLookupElimination,
} from './movement-proofs';

/**
 * Drops a simple equality lookup when the next stage discards the alias.
 * Lookup plus unwind stays in place because multiplicity is unproven.
 */
export class RedundantLookupEliminationPass implements PipelinePass
{
    readonly name       = 'redundant-lookup-elimination';
    readonly stageTypes = [ '$lookup' ] as const;

    execute(pipeline: any[]): any[]
    {
        const result = [...pipeline];

        for (let index = 0; index < result.length - 1; index++)
        {
            if (!proveRedundantLookupElimination(result[index], result[index + 1]))
            {
                continue;
            }

            result.splice(index, 1);
            return result;
        }

        return result;
    }
}
