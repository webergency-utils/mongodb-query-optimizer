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
        const result = [ ...pipeline ];

        for( let index = 0; index < result.length - 1; index++ )
        {
            const downstream = result.slice( index + 2 );

            if( proveAddFieldDeferralAcrossSort( result[ index ], result[ index + 1 ] ))
            {
                if( !canMoveStageAcrossStage(
                    result[ index ],
                    result[ index + 1 ],
                    'later',
                    context,
                    downstream
                ))
                {
                    continue;
                }

                [ result[ index ], result[ index + 1 ] ] = [
                    result[ index + 1 ],
                    result[ index ]
                ];
                return result;
            }

            if(
                index + 2 < result.length
                && isPositiveLimitOrSkipStage( result[ index + 2 ] )
                && !context.strictFieldOrder
                && canSplitFieldAddingStage( result[ index + 1 ], context, downstream )
            )
            {
                const splitProof = proveAddFieldSplitAcrossSort( result[ index ], result[ index + 1 ] )
                    ?? proveProjectSplitAcrossSort( result[ index ], result[ index + 1 ] );
                if(
                    splitProof
                    && canMoveStageAcrossStage(
                        splitProof.deferredStage,
                        result[ index + 1 ],
                        'later',
                        context,
                        downstream
                    )
                )
                {
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

        return result;
    }
}
