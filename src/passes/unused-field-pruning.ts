import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { canRemoveStage } from './guarantee-guards.js';
import { PipelinePass } from './types.js';
import {
    proveUnusedFieldPruningThroughSuffix
} from './projection-proofs.js';

export class UnusedFieldPruningPass implements PipelinePass
{
    readonly name       = 'unused-field-pruning';
    readonly stageTypes = [ '$addFields', '$set', '$project', '$unset', '$group' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        for( let index = 0; index + 1 < pipeline.length; index++ )
        {
            if( !canRemoveStage( pipeline[ index ], context ))
            {
                continue;
            }

            const proof = proveUnusedFieldPruningThroughSuffix(
                pipeline[ index ],
                pipeline.slice( index + 1 ),
                context.strictErrors
            );
            if( !proof )
            {
                continue;
            }

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
