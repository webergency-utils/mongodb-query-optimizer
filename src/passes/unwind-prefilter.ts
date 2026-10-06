import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { PipelinePass } from './types.js';
import { proveUnwindPrefilter } from './unwind-proofs.js';
import { structuralFingerprint } from '../utils.js';

function hasPrefilter(
    matchSpec           : any,
    prefilterMatchSpec  : any
): boolean
{
    if( !matchSpec || typeof matchSpec !== 'object' )
    {
        return false;
    }

    if( structuralFingerprint( matchSpec ) === structuralFingerprint( prefilterMatchSpec ))
    {
        return true;
    }

    if( Array.isArray( matchSpec.$and ))
    {
        return matchSpec.$and.some(( clause: any ) =>
            hasPrefilter( clause, prefilterMatchSpec )
        );
    }

    return false;
}

function isPipelineLookupForPath( stage: unknown, path: string ): boolean
{
    if( !stage || typeof stage !== 'object' || Array.isArray( stage )){ return false }

    const lookup = ( stage as Record<string, unknown> ).$lookup;

    if( !lookup || typeof lookup !== 'object' || Array.isArray( lookup )){ return false }

    const lookupObj = lookup as Record<string, unknown>;

    return lookupObj.as === path && Array.isArray( lookupObj.pipeline );
}

export class UnwindPrefilterPass implements PipelinePass
{
    readonly name       = 'unwind-prefilter';
    readonly stageTypes = [ '$unwind' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        const result: any[] = [];

        for( let i = 0; i < pipeline.length; i++ )
        {
            const currentStage = pipeline[ i ];

            if( i + 1 < pipeline.length )
            {
                const nextStage = pipeline[ i + 1 ];
                const proof = proveUnwindPrefilter( currentStage, nextStage, context );

                if( proof )
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
                                    proof.prefilterStage.$match
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

            result.push( currentStage );
        }

        return result;
    }
}

