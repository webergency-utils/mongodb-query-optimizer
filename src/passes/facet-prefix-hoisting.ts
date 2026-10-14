import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { PipelinePass } from './types.js';
import
{
    proveFacetDeadBranchPruning,
    proveFacetPrefixHoisting,
    proveUnionWithPushdown
}
from './facet-proofs.js';

export class FacetPrefixHoistingPass implements PipelinePass
{
    readonly name       = 'facet-prefix-hoisting';
    readonly stageTypes = [ '$facet', '$unionWith' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        const result: any[] = [];

        for( let i = 0; i < pipeline.length; i++ )
        {
            let stage = pipeline[ i ];
            const suffix = pipeline.slice( i + 1 );

            const prunedFacet = proveFacetDeadBranchPruning( stage, suffix, context );
            if( prunedFacet )
            {
                stage = prunedFacet;
            }

            const hoistProof = proveFacetPrefixHoisting( stage, context );
            if( hoistProof )
            {
                result.push( ...hoistProof.hoistedStages );
                result.push( hoistProof.simplifiedFacet );
                continue;
            }

            const unionProof = proveUnionWithPushdown( stage, suffix, context );
            if( unionProof )
            {
                if( unionProof.hoistedMatch )
                {
                    result.push( unionProof.hoistedMatch );
                    result.push( unionProof.updatedUnionStage );
                    i++;
                    continue;
                }

                result.push( unionProof.updatedUnionStage );
                continue;
            }

            result.push( stage );
        }

        return result;
    }
}
