import { PipelinePass } from './types.js';
import
{
    proveCorrelatedLookupEqualityNormalization,
    proveExprToNativeMatch
}
from './expr-normalization-proofs.js';
import { isMatchStage } from './helpers.js';

export class ExprMatchNormalizationPass implements PipelinePass
{
    readonly name       = 'expr-match-normalization';
    readonly stageTypes = [ '$match', '$lookup' ] as const;

    execute(pipeline: any[]): any[]
    {
        const result: any[] = [];

        for (const stage of pipeline)
        {
            if (isMatchStage(stage) && '$expr' in stage.$match)
            {
                const normalized = proveExprToNativeMatch(stage.$match.$expr);
                if (normalized)
                {
                    const rest: Record<string, any> = {};
                    let hasCollision = false;

                    for (const [k, v] of Object.entries(stage.$match))
                    {
                        if (k !== '$expr')
                        {
                            if (k in normalized)
                            {
                                hasCollision = true;
                                break;
                            }

                            rest[k] = v;
                        }
                    }

                    if (!hasCollision)
                    {
                        result.push({
                            $match: {
                                ...rest,
                                ...normalized,
                            },
                        });
                        continue;
                    }
                }
            }

            const normalizedLookup = proveCorrelatedLookupEqualityNormalization(stage);
            if (normalizedLookup)
            {
                result.push(normalizedLookup);
                continue;
            }

            result.push(stage);
        }

        return result;
    }
}
