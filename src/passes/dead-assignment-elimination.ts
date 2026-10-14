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
    readonly stageTypes = [ '$addFields', '$set', '$project', '$unset' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        const result = [ ...pipeline ];

        for( let index = 0; index < result.length; index++ )
        {
            const proof = proveDeadAssignmentElimination(
                result[ index ],
                result.slice( index + 1 ),
                context
            ) ?? proveNoOpSelfAssignmentElimination(
                result.slice( 0, index ),
                result[ index ],
                context
            );

            if( !proof ){ continue }

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

        return result;
    }
}
