import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { canRemoveStage } from './guarantee-guards.js';
import { PipelinePass } from './types.js';
import {
    proveUnusedFieldPruningThroughSuffix
} from './projection-proofs.js';

export class UnusedFieldPruningPass implements PipelinePass
{
    readonly name       = 'unused-field-pruning';
    readonly stageTypes = [ '$addFields', '$set', '$project', '$unset' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        const result = [ ...pipeline ];

        for( let index = 0; index + 1 < result.length; index++ )
        {
            if( !canRemoveStage( result[index], context ))
            {
                continue;
            }

            const proof = proveUnusedFieldPruningThroughSuffix(
                result[index],
                result.slice( index + 1 )
            );
            if( !proof )
            {
                continue;
            }

            if( proof.replacementStage )
            {
                result[index] = proof.replacementStage;
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
