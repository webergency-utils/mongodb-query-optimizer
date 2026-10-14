import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { canMoveStageAcrossStage, canSplitFieldAddingStage } from './guarantee-guards.js';
import { getSingleStageEntry } from './helpers.js';
import { PipelinePass } from './types.js';
import
{
    proveAddFieldDeferralAcrossSort,
    proveAddFieldSplitAcrossSort,
    proveProjectSplitAcrossSort
}
from './projection-proofs.js';

function isPositiveLimitOrSkipStage( stage: unknown ): boolean
{
    const entry = getSingleStageEntry( stage );
    if( !entry )
    {
        return false;
    }

    return (
        ( entry[ 0 ] === '$limit' || entry[ 0 ] === '$skip' )
        && typeof entry[ 1 ] === 'number'
        && Number.isSafeInteger( entry[ 1 ] )
        && entry[ 1 ] > 0
    );
}

/**
 * Delays a deterministic add/set past an adjacent sort when the sort keys
 * do not overlap the written fields, or splits the non-sort fields past
 * `$sort` when immediately followed by `$limit` or `$skip`.
 */
export class ComplexProjectionDeferralPass implements PipelinePass
{
    readonly name       = 'complex-projection-deferral';
    readonly stageTypes = [ '$addFields', '$set', '$project' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        for( let index = 0; index < pipeline.length - 1; index++ )
        {
            if( proveAddFieldDeferralAcrossSort( pipeline[ index ], pipeline[ index + 1 ] ))
            {
                const downstream = pipeline.slice( index + 2 );
                if( !canMoveStageAcrossStage(
                    pipeline[ index ],
                    pipeline[ index + 1 ],
                    'later',
                    context,
                    downstream
                ))
                {
                    continue;
                }

                const result = [ ...pipeline ];
                [ result[ index ], result[ index + 1 ] ] = [
                    result[ index + 1 ],
                    result[ index ]
                ];
                return result;
            }

            if(
                index + 2 < pipeline.length
                && isPositiveLimitOrSkipStage( pipeline[ index + 2 ] )
                && !context.strictFieldOrder
            )
            {
                const downstream = pipeline.slice( index + 2 );
                if( canSplitFieldAddingStage( pipeline[ index + 1 ], context, downstream ))
                {
                    const splitProof = proveAddFieldSplitAcrossSort( pipeline[ index ], pipeline[ index + 1 ] )
                        ?? proveProjectSplitAcrossSort( pipeline[ index ], pipeline[ index + 1 ] );
                    if(
                        splitProof
                        && canMoveStageAcrossStage(
                            splitProof.deferredStage,
                            pipeline[ index + 1 ],
                            'later',
                            context,
                            downstream
                        )
                    )
                    {
                        const result = [ ...pipeline ];
                        result.splice(
                            index,
                            2,
                            splitProof.retainedStage,
                            result[ index + 1 ],
                            splitProof.deferredStage
                        );
                        return result;
                    }
                }
            }
        }

        return pipeline;
    }
}
