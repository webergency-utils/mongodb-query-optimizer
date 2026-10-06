import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { PipelinePass } from './types.js';
import {
    proveAdjacentAddFieldMerge
} from './projection-proofs.js';

export class AdjacentAddFieldMergingPass implements PipelinePass
{
    readonly name       = 'adjacent-add-field-merging';
    readonly stageTypes = [ '$addFields', '$set' ] as const;

    execute( pipeline: any[], _context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        const result = [ ...pipeline ];

        for( let index = 1; index < result.length; index++ )
        {
            const proof = proveAdjacentAddFieldMerge(
                result[index - 1],
                result[index]
            );
            if( !proof )
            {
                continue;
            }

            result.splice( index - 1, 2, proof.mergedStage );
            return result;
        }

        return result;
    }
}
