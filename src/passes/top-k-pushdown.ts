import { PipelinePass } from './types.js';
import { proveTopKPushdown } from './top-k-proofs.js';

export class TopKPushdownPass implements PipelinePass
{
    readonly name       = 'top-k-pushdown';
    readonly stageTypes = [ '$sort' ] as const;

    execute( pipeline: any[] ): any[]
    {
        const result = [ ...pipeline ];

        for( let i = 0; i < result.length; i++ )
        {
            const proof = proveTopKPushdown( result, i );
            if( proof )
            {
                const slice = result.splice( proof.sortIndex, proof.sliceLength );
                result.splice( proof.targetIndex, 0, ...slice );
                return result;
            }
        }

        return result;
    }
}
