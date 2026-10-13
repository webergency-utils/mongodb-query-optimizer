import { DEFAULT_GUARANTEE_CONTEXT, type GuaranteeContext } from '../guarantees';
import { PipelinePass } from './types';
import { proveCoveredProjectionSynthesis, trimCountNeutralPrefix } from './covered-projection-proofs';

export class CoveredProjectionSynthesisPass implements PipelinePass
{
    readonly name       = 'covered-projection-synthesis';
    readonly stageTypes = [ '$group', '$count', '$sortByCount', '$bucket', '$bucketAuto' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        const trimmed = trimCountNeutralPrefix( pipeline, context );
        const proof = proveCoveredProjectionSynthesis( trimmed );

        if( !proof ){ return trimmed }

        const result = [ ...trimmed ];
        result.splice( proof.insertIndex, 0, proof.synthesizedStage );

        return result;
    }
}
