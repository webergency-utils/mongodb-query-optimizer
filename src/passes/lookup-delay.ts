import { PipelinePass } from './types';
import { GuaranteeContext, DEFAULT_GUARANTEE_CONTEXT } from '../guarantees.js';
import
{
    proveLookupDelayAcrossStage,
    proveLookupLimitPushdown,
    proveLookupMatchSplit,
    proveLookupSubpipelineFieldPruning,
    proveLookupSubpipelinePushdown,
    proveLookupSubpipelinePushdownAcrossSuffix,
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
        let result: any[] | null = null;
        let current = pipeline;

        for( let index = current.length - 2; index >= 0; index-- )
        {
            let currentIndex = index;

            while( currentIndex < current.length - 1 )
            {
                const suffixAfterNext = current.slice( currentIndex + 2 );
                if( proveLookupDelayAcrossStage(
                    current[ currentIndex ],
                    current[ currentIndex + 1 ],
                    context,
                    suffixAfterNext
                ))
                {
                    if( result === null )
                    {
                        result = [ ...pipeline ];
                        current = result;
                    }

                    const nextStage = result[ currentIndex + 1 ];
                    result[ currentIndex + 1 ] = result[ currentIndex ];
                    result[ currentIndex ] = nextStage;
                    currentIndex++;
                    continue;
                }

                const splitProof = proveLookupMatchSplit(
                    current[ currentIndex ],
                    current[ currentIndex + 1 ],
                    context,
                    suffixAfterNext
                );

                if( splitProof )
                {
                    if( result === null )
                    {
                        result = [ ...pipeline ];
                        current = result;
                    }

                    result[ currentIndex + 1 ] = splitProof.residualStage;
                    result.splice( currentIndex, 0, splitProof.pushableStage );
                    currentIndex++;
                    continue;
                }

                const suffixFromNext = current.slice( currentIndex + 1 );

                if( currentIndex + 2 < current.length )
                {
                    const subProof = proveLookupSubpipelinePushdown(
                        current[ currentIndex ],
                        current[ currentIndex + 1 ],
                        current[ currentIndex + 2 ],
                        context
                    );

                    if( subProof )
                    {
                        if( result === null )
                        {
                            result = [ ...pipeline ];
                            current = result;
                        }

                        result[ currentIndex ] = subProof.lookupStage;

                        if( subProof.residualStage )
                        {
                            result[ currentIndex + 2 ] = subProof.residualStage;
                        }
                        else
                        {
                            result.splice( currentIndex + 2, 1 );
                        }

                        continue;
                    }

                    const subProofB = proveLookupSubpipelinePushdown(
                        current[ currentIndex ],
                        current[ currentIndex + 2 ],
                        current[ currentIndex + 1 ],
                        context
                    );

                    if( subProofB )
                    {
                        if( result === null )
                        {
                            result = [ ...pipeline ];
                            current = result;
                        }

                        result[ currentIndex ] = subProofB.lookupStage;

                        if( subProofB.residualStage )
                        {
                            result[ currentIndex + 1 ] = subProofB.residualStage;
                        }
                        else
                        {
                            result.splice( currentIndex + 1, 1 );
                        }

                        continue;
                    }

                    const suffixSubProof = proveLookupSubpipelinePushdownAcrossSuffix(
                        current[ currentIndex ],
                        suffixFromNext,
                        context
                    );

                    if( suffixSubProof )
                    {
                        if( result === null )
                        {
                            result = [ ...pipeline ];
                            current = result;
                        }

                        result[ currentIndex ] = suffixSubProof.lookupStage;
                        const matchIdx = currentIndex + suffixSubProof.matchOffset;

                        if( suffixSubProof.residualStage )
                        {
                            result[ matchIdx ] = suffixSubProof.residualStage;
                        }
                        else
                        {
                            result.splice( matchIdx, 1 );
                        }

                        continue;
                    }
                }

                const limitProof = proveLookupLimitPushdown(
                    current[ currentIndex ],
                    suffixFromNext,
                    context
                ) ?? proveLookupSubpipelineFieldPruning(
                    current[ currentIndex ],
                    suffixFromNext,
                    context
                );

                if( limitProof )
                {
                    if( result === null )
                    {
                        result = [ ...pipeline ];
                        current = result;
                    }

                    result[ currentIndex ] = limitProof.lookupStage;
                    continue;
                }

                break;
            }
        }

        return result ?? pipeline;
    }
}

