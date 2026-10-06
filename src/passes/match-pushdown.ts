import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees';
import { PipelinePass } from './types';
import
{
    proveMatchPushdownAcrossStage
}
from './movement-proofs';

export class MatchPushdownPass implements PipelinePass
{
    readonly name       = 'match-pushdown';
    readonly stageTypes = [ '$match' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        let changed = false;
        const result = [ ...pipeline ];

        for( let index = 1; index < result.length; index++ )
        {
            if( !result[ index ] || typeof result[ index ] !== 'object' || !( '$match' in result[ index ] ))
            {
                continue;
            }

            let currentIndex = index;

            while( currentIndex > 0 )
            {
                const downstream = result.slice( currentIndex + 1 );
                const proof = proveMatchPushdownAcrossStage(
                    result[ currentIndex - 1 ],
                    result[ currentIndex ],
                    context,
                    downstream
                );

                if( !proof ){ break }

                const previousStage = result[ currentIndex - 1 ];
                result[ currentIndex - 1 ] = proof.matchStage;
                result[ currentIndex ] = previousStage;

                if( proof.residualStage )
                {
                    result.splice( currentIndex + 1, 0, proof.residualStage );
                    index++;
                }

                currentIndex--;
                changed = true;
            }
        }

        return changed ? result : pipeline;
    }
}
