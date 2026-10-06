import { PipelinePass } from './types.js';
import { proveUnwindPrefilter } from './unwind-proofs.js';
import { structuralFingerprint } from '../utils.js';

function hasPrefilter(
    matchSpec: any,
    arrayPath: string,
    expectedCondition: any,
): boolean
{
    if (!matchSpec || typeof matchSpec !== 'object')
    {
        return false;
    }

    if (matchSpec[arrayPath] !== undefined)
    {
        return (
            structuralFingerprint(matchSpec[arrayPath])
            === structuralFingerprint(expectedCondition)
        );
    }

    if (Array.isArray(matchSpec.$and))
    {
        return matchSpec.$and.some((clause: any) =>
            hasPrefilter(clause, arrayPath, expectedCondition),
        );
    }

    return false;
}

function isPipelineLookupForPath( stage: unknown, path: string ): boolean
{
    if( !stage || typeof stage !== 'object' || Array.isArray( stage ) ){ return false }

    const lookup = ( stage as Record<string, unknown> ).$lookup;

    if( !lookup || typeof lookup !== 'object' || Array.isArray( lookup ) ){ return false }

    const lookupObj = lookup as Record<string, unknown>;

    return lookupObj.as === path && Array.isArray( lookupObj.pipeline );
}

export class UnwindPrefilterPass implements PipelinePass
{
    readonly name       = 'unwind-prefilter';
    readonly stageTypes = [ '$unwind' ] as const;

    execute(pipeline: any[]): any[]
    {
        const result: any[] = [];

        for (let i = 0; i < pipeline.length; i++)
        {
            const currentStage = pipeline[i];
            if (i + 1 < pipeline.length)
            {
                const nextStage = pipeline[i + 1];
                const proof = proveUnwindPrefilter(currentStage, nextStage);
                if (proof)
                {
                    const prevStage = result.length > 0 ? result[ result.length - 1 ] : undefined;

                    if( !isPipelineLookupForPath( prevStage, proof.arrayPath ))
                    {
                        let alreadyPresent = false;

                        for( let j = result.length - 1; j >= 0; j-- )
                        {
                            const candidate = result[ j ];

                            if( candidate && typeof candidate === 'object' && '$match' in candidate )
                            {
                                if( hasPrefilter(
                                    candidate.$match,
                                    proof.arrayPath,
                                    proof.prefilterStage.$match[ proof.arrayPath ],
                                ))
                                {
                                    alreadyPresent = true;
                                    break;
                                }
                            }
                        }

                        if( !alreadyPresent )
                        {
                            result.push( proof.prefilterStage );
                        }
                    }
                }
            }

            result.push(currentStage);
        }

        return result;
    }
}
