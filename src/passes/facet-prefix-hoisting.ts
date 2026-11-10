import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { isSingleKeyStage } from './helpers.js';
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

            if( isSingleKeyStage( stage, '$facet' ))
            {
                const prunedFacet = proveFacetDeadBranchPruning( stage, pipeline.slice( i + 1 ), context );

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
            }
            else if( isSingleKeyStage( stage, '$unionWith' ))
            {
                const unionProof = proveUnionWithPushdown( stage, pipeline.slice( i + 1 ), context );

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
            }

            result.push( stage );
        }

        return result;
    }
}
