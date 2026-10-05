import { PipelinePass } from './types';
import { isMatchStage } from './helpers';
import { optimizeFilter } from '../filter-optimizer';
import { isFilterRewriteSafe } from '../analyzer/filters';

function isMergeableMatchStage(stage: any): boolean
{
    return (
        isMatchStage(stage)
        && Object.keys(stage).length === 1
        && isFilterRewriteSafe(stage.$match)
    );
}

export class AdjacentMatchMergingPass implements PipelinePass {
    name = 'adjacent-match-merging';
    execute(pipeline: any[]): any[] {
        const result: any[] = [];
        let index = 0;

        while (index < pipeline.length) {
            const stage = pipeline[index];
            if (!isMergeableMatchStage(stage)) {
                result.push(stage);
                index++;
                continue;
            }

            const matches: any[] = [];
            while (
                index < pipeline.length
                && isMergeableMatchStage(pipeline[index])
            ) {
                matches.push(pipeline[index].$match);
                index++;
            }

            result.push(
                matches.length === 1
                    ? stage
                    : { $match: optimizeFilter({ $and: matches }) },
            );
        }

        return result;
    }
}
