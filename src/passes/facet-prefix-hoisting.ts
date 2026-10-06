import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { PipelinePass } from './types.js';
import { proveFacetPrefixHoisting } from './facet-proofs.js';

export class FacetPrefixHoistingPass implements PipelinePass
{
    readonly name       = 'facet-prefix-hoisting';
    readonly stageTypes = [ '$facet' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        const result: any[] = [];

        for( const stage of pipeline )
        {
            const proof = proveFacetPrefixHoisting( stage, context );
            if( proof )
            {
                result.push( ...proof.hoistedStages );
                result.push( proof.simplifiedFacet );
            }
            else
            {
                result.push( stage );
            }
        }

        return result;
    }
}
