import { PipelinePass } from './types.js';
import { proveExprToNativeMatch } from './expr-normalization-proofs.js';
import { isMatchStage } from './helpers.js';

export class ExprMatchNormalizationPass implements PipelinePass
{
    readonly name       = 'expr-match-normalization';
    readonly stageTypes = [ '$match' ] as const;

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
                    for (const [k, v] of Object.entries(stage.$match))
                    {
                        if (k !== '$expr')
                        {
                            rest[k] = v;
                        }
                    }

                    result.push({
                        $match: {
                            ...rest,
                            ...normalized,
                        },
                    });
                    continue;
                }
            }

            result.push(stage);
        }

        return result;
    }
}
