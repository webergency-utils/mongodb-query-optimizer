import { PipelinePass } from './types';
import { isMatchStage } from './helpers';
import { optimizeFilterWithContext } from '../filter-optimizer';
import { isFilterRewriteSafe } from '../analyzer/filters';
import { GuaranteeContext } from '../guarantees';

function isMergeableMatchStage( stage: any ): boolean
{
    return isMatchStage( stage ) && isFilterRewriteSafe( stage.$match );
}

export class AdjacentMatchMergingPass implements PipelinePass
{
    readonly name       = 'adjacent-match-merging';
    readonly stageTypes = [ '$match' ] as const;

    execute( pipeline: any[], context: GuaranteeContext ): any[]
    {
        const result: any[] = [];
        let index = 0;

        while( index < pipeline.length )
        {
            const stage = pipeline[ index ];

            if( !isMergeableMatchStage( stage ))
            {
                result.push( stage );
                index++;
                continue;
            }

            const matches: any[] = [];

            while(
                index < pipeline.length
                && isMergeableMatchStage( pipeline[ index ] )
            )
            {
                matches.push( pipeline[ index ].$match );
                index++;
            }

            result.push(
                matches.length === 1
                    ? stage
                    : { $match: optimizeFilterWithContext( { $and: matches }, context ) }
            );
        }

        return result;
    }
}
