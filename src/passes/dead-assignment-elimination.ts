import { DEFAULT_GUARANTEE_CONTEXT, type GuaranteeContext } from '../guarantees';
import { PipelinePass } from './types';
import
{
    proveDeadAssignmentElimination,
    proveNoOpSelfAssignmentElimination
}
from './dead-assignment-proofs';

export class DeadAssignmentEliminationPass implements PipelinePass
{
    readonly name       = 'dead-assignment-elimination';
    readonly stageTypes = [ '$addFields', '$set', '$project', '$unset', '$replaceRoot', '$replaceWith' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        for( let index = 0; index < pipeline.length; index++ )
        {
            const proof = proveDeadAssignmentElimination(
                pipeline[ index ],
                pipeline.slice( index + 1 ),
                context
            ) ?? proveNoOpSelfAssignmentElimination(
                pipeline.slice( 0, index ),
                pipeline[ index ],
                context
            );

            if( !proof ){ continue }

            const result = [ ...pipeline ];

            if( proof.replacementStage )
            {
                result[ index ] = proof.replacementStage;
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
