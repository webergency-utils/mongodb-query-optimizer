import { PipelinePass } from './types';
import { proveCoveredProjectionSynthesis } from './covered-projection-proofs';

export class CoveredProjectionSynthesisPass implements PipelinePass
{
    readonly name       = 'covered-projection-synthesis';
    readonly stageTypes = [ '$group', '$count', '$sortByCount' ] as const;

    execute( pipeline: any[] ): any[]
    {
        const proof = proveCoveredProjectionSynthesis( pipeline );
        if( !proof ){ return [ ...pipeline ] }

        const result = [ ...pipeline ];
        result.splice( proof.insertIndex, 0, proof.synthesizedStage );

        return result;
    }
}
