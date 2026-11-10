import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { PipelinePass } from './types.js';
import
{
    proveAdjacentProjectMerge,
    proveRedundantDownstreamUnset
}
from './projection-proofs.js';

export class AdjacentProjectMergingPass implements PipelinePass
{
    readonly name       = 'adjacent-project-merging';
    readonly stageTypes = [ '$project', '$unset' ] as const;

    execute( pipeline: any[], _context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        for( let index = 1; index < pipeline.length; index++ )
        {
            const proof = proveAdjacentProjectMerge(
                pipeline[ index - 1 ],
                pipeline[ index ]
            );

            if( !proof ){ continue }

            const result = [ ...pipeline ];
            result.splice( index - 1, 2, proof.mergedStage );

            return result;
        }

        for( let index = 1; index < pipeline.length; index++ )
        {
            const unsetProof = proveRedundantDownstreamUnset( pipeline, index );

            if( !unsetProof ){ continue }

            const result = [ ...pipeline ];

            if( unsetProof.replacementStage )
            {
                result[ index ] = unsetProof.replacementStage;
            }
            else
            {
                result.splice( index, 1 );
            }

            return result;
        }

        return pipeline;
    }
}
