import { PipelinePass } from './types.js';
import { proveAddFieldPushdown } from './add-field-pushdown-proofs.js';

export class AddFieldPushdownPass implements PipelinePass
{
    readonly name       = 'add-field-pushdown';
    readonly stageTypes = [ '$addFields', '$set' ] as const;

    execute( pipeline: any[] ): any[]
    {
        const result = [ ...pipeline ];

        for( let i = 1; i < result.length; i++ )
        {
            const proof = proveAddFieldPushdown( result, i );
            if( !proof )
            {
                continue;
            }

            if( proof.remainingFields === null )
            {
                const [ removedStage ] = result.splice( proof.sourceIndex, 1 );
                result.splice( proof.targetIndex, 0, removedStage );
            }
            else
            {
                result[ proof.sourceIndex ] = {
                    [ proof.operator ]: proof.remainingFields,
                };
                result.splice( proof.targetIndex, 0, {
                    [ proof.operator ]: proof.pushedFields,
                });
            }

            return result;
        }

        return result;
    }
}
