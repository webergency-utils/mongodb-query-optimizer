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

    execute( pipeline: any[] ): any[]
    {
        let changed = false;
        const result = [ ...pipeline ];

        for( let index = 1; index < result.length; index++ )
        {
            let currentIndex = index;

            while( currentIndex > 0 )
            {
                const proof = proveMatchPushdownAcrossStage(
                    result[ currentIndex - 1 ],
                    result[ currentIndex ]
                );

                if( !proof ){ break }

                const previousStage = result[ currentIndex - 1 ];
                result[ currentIndex - 1 ] = proof.matchStage;
                result[ currentIndex ] = previousStage;
                currentIndex--;
                changed = true;
            }
        }

        return changed ? result : pipeline;
    }
}
