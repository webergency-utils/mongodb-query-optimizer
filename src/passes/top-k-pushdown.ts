import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { PipelinePass } from './types.js';
import { proveHeuristicTopKPushdown, proveTopKPushdown } from './top-k-proofs.js';

export class TopKPushdownPass implements PipelinePass
{
    readonly name       = 'top-k-pushdown';
    readonly stageTypes = [ '$sort' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        for( let i = 0; i < pipeline.length; i++ )
        {
            const proof = proveTopKPushdown( pipeline, i, context );

            if( proof )
            {
                const result = [ ...pipeline ];
                const slice = result.splice( proof.sortIndex, proof.sliceLength );

                result.splice( proof.targetIndex, 0, ...slice );

                return result;
            }

            const heuristicProof = proveHeuristicTopKPushdown( pipeline, i, context );

            if( heuristicProof )
            {
                const result = [ ...pipeline ];
                const followerSlice = result.slice(
                    heuristicProof.sortIndex + 1,
                    heuristicProof.sortIndex + heuristicProof.sliceLength
                );

                result.splice( heuristicProof.sortIndex, heuristicProof.sliceLength );

                const unsetStage = {
                    $unset: heuristicProof.shadowUnsetKeys.length === 1
                        ? heuristicProof.shadowUnsetKeys[ 0 ]
                        : heuristicProof.shadowUnsetKeys
                };

                result.splice(
                    heuristicProof.targetIndex,
                    0,
                    { $addFields: heuristicProof.shadowAddFields },
                    { $sort: heuristicProof.shadowSortSpec },
                    ...followerSlice,
                    unsetStage
                );

                return result;
            }
        }

        return pipeline;
    }
}
