import { PipelinePass } from './types';
import {
    proveAddFieldDeferralAcrossSort,
} from './projection-proofs';

/**
 * Delays a deterministic add/set past an adjacent sort when the sort keys
 * do not overlap the written fields.
 */
export class ComplexProjectionDeferralPass implements PipelinePass
{
    readonly name       = 'complex-projection-deferral';
    readonly stageTypes = [ '$addFields', '$set' ] as const;

    execute(pipeline: any[]): any[]
    {
        const result = [...pipeline];

        for (let index = 0; index < result.length - 1; index++)
        {
            if (!proveAddFieldDeferralAcrossSort(result[index], result[index + 1]))
            {
                continue;
            }

            [result[index], result[index + 1]] = [
                result[index + 1],
                result[index],
            ];
            return result;
        }

        return result;
    }
}
