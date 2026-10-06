import { PipelinePass } from './types';
import {
    proveUnusedFieldPruningThroughSuffix,
} from './projection-proofs';

export class UnusedFieldPruningPass implements PipelinePass
{
    readonly name       = 'unused-field-pruning';
    readonly stageTypes = [ '$addFields', '$set', '$project', '$unset' ] as const;

    execute(pipeline: any[]): any[]
    {
        const result = [...pipeline];

        for (let index = 0; index + 1 < result.length; index++)
        {
            const proof = proveUnusedFieldPruningThroughSuffix(
                result[index],
                result.slice(index + 1),
            );
            if (!proof)
            {
                continue;
            }

            if (proof.replacementStage)
            {
                result[index] = proof.replacementStage;
            }
            else
            {
                result.splice(index, 1);
            }

            return result;
        }

        return result;
    }
}
