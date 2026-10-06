import { PipelinePass } from './types';
import { GuaranteeContext, DEFAULT_GUARANTEE_CONTEXT } from '../guarantees.js';
import
{
    proveLookupDelayAcrossStage,
    proveLookupMatchSplit,
    proveLookupSubpipelinePushdown,
}
from './movement-proofs.js';

/**
 * Delays simple equality lookups past match, sort, limit, and skip when the
 * follower does not consume the alias. Lookup errors are assumed absent.
 */
export class LookupDelayPass implements PipelinePass
{
    readonly name       = 'lookup-delay';
    readonly stageTypes = [ '$lookup' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        let changed = false;
        const result = [ ...pipeline ];

        for( let index = result.length - 2; index >= 0; index-- )
        {
            let currentIndex = index;

            while( currentIndex < result.length - 1 )
            {
                if( proveLookupDelayAcrossStage(
                    result[ currentIndex ],
                    result[ currentIndex + 1 ],
                    context,
                    result.slice( currentIndex + 2 )
                ))
                {
                    const nextStage = result[ currentIndex + 1 ];
                    result[ currentIndex + 1 ] = result[ currentIndex ];
                    result[ currentIndex ] = nextStage;
                    currentIndex++;
                    changed = true;
                    continue;
                }

                const splitProof = proveLookupMatchSplit(
                    result[ currentIndex ],
                    result[ currentIndex + 1 ],
                    context,
                    result.slice( currentIndex + 2 )
                );

                if( splitProof )
                {
                    result[ currentIndex + 1 ] = splitProof.residualStage;
                    result.splice( currentIndex, 0, splitProof.pushableStage );
                    currentIndex++;
                    changed = true;
                    continue;
                }

                if( currentIndex + 2 < result.length )
                {
                    const subProof = proveLookupSubpipelinePushdown(
                        result[ currentIndex ],
                        result[ currentIndex + 1 ],
                        result[ currentIndex + 2 ],
                        context
                    );

                    if( subProof )
                    {
                        result[ currentIndex ] = subProof.lookupStage;

                        if( subProof.residualStage )
                        {
                            result[ currentIndex + 2 ] = subProof.residualStage;
                        }
                        else
                        {
                            result.splice( currentIndex + 2, 1 );
                        }

                        changed = true;
                        continue;
                    }

                    const subProofB = proveLookupSubpipelinePushdown(
                        result[ currentIndex ],
                        result[ currentIndex + 2 ],
                        result[ currentIndex + 1 ],
                        context
                    );

                    if( subProofB )
                    {
                        result[ currentIndex ] = subProofB.lookupStage;

                        if( subProofB.residualStage )
                        {
                            result[ currentIndex + 1 ] = subProofB.residualStage;
                        }
                        else
                        {
                            result.splice( currentIndex + 1, 1 );
                        }

                        changed = true;
                        continue;
                    }
                }

                break;
            }
        }

        return changed ? result : pipeline;
    }
}

