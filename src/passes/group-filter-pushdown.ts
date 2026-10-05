import { PipelinePass } from './types.js';
import { proveGroupFilterPushdown } from './group-pushdown-proofs.js';
import { structuralFingerprint } from '../utils.js';

export class GroupFilterPushdownPass implements PipelinePass
{
    name = 'group-filter-pushdown';

    execute(pipeline: any[]): any[]
    {
        const result: any[] = [];

        for (let i = 0; i < pipeline.length; i++)
        {
            const currentStage = pipeline[i];
            if (i + 1 < pipeline.length)
            {
                const nextStage = pipeline[i + 1];
                const proof = proveGroupFilterPushdown(currentStage, nextStage);
                if (proof)
                {
                    const alreadyPresent = (
                        result.length > 0
                        && result[result.length - 1]?.$match !== undefined
                        && structuralFingerprint(result[result.length - 1].$match)
                            === structuralFingerprint(proof.prefilterStage.$match)
                    );

                    if (!alreadyPresent)
                    {
                        result.push(proof.prefilterStage);
                    }

                    result.push(currentStage);

                    if (proof.postfilterStage !== null)
                    {
                        result.push(proof.postfilterStage);
                    }

                    i++; // skip nextStage as it has been replaced/eliminated
                    continue;
                }
            }

            result.push(currentStage);
        }

        return result;
    }
}
