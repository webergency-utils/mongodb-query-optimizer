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
        let result: any[] | null = null;
        let current = pipeline;

        for( let index = 1; index < current.length; index++ )
        {
            if( !current[ index ] || typeof current[ index ] !== 'object' || !( '$match' in current[ index ] ))
            {
                continue;
            }

            let currentIndex = index;

            while( currentIndex > 0 )
            {
                const prev = current[ currentIndex - 1 ];
                if( prev && typeof prev === 'object' && '$match' in prev )
                {
                    break;
                }

                const downstream = current.slice( currentIndex + 1 );
                const proof = proveMatchPushdownAcrossStage(
                    prev,
                    current[ currentIndex ],
                    context,
                    downstream
                );

                if( !proof ){ break; }

                if( result === null )
                {
                    result = [ ...pipeline ];
                    current = result;
                }

                result[ currentIndex - 1 ] = proof.matchStage;
                result[ currentIndex ] = prev;

                if( proof.residualStage )
                {
                    result.splice( currentIndex + 1, 0, proof.residualStage );
                    index++;
                }

                currentIndex--;
            }
        }

        return result ?? pipeline;
    }
}
