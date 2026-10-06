import { PipelinePass } from './types';
import { proveDeadAssignmentElimination } from './dead-assignment-proofs';

export class DeadAssignmentEliminationPass implements PipelinePass
{
    readonly name       = 'dead-assignment-elimination';
    readonly stageTypes = [ '$addFields', '$set' ] as const;

    execute( pipeline: any[] ): any[]
    {
        const result = [ ...pipeline ];

        for( let index = 0; index < result.length; index++ )
        {
            const proof = proveDeadAssignmentElimination(
                result[ index ],
                result.slice( index + 1 )
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
