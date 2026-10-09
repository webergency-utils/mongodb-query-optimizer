import { analyzeStage } from '../analyzer/semantics.js';
import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { isStageProvenErrorFree } from './guarantee-guards.js';
import { combineConjuncts, decomposeFilterIntoConjuncts, isMatchStage } from './helpers.js';
import { containsGetField, isSafeMatchSummary, rewriteQueryDocument } from './movement-proofs.js';
import
{
    allocateShadowFieldName,
    findShadowTargetIndex,
    isExpressionCompletelyDeterministic,
    rangeHasCostlyStage,
    resolveShadowProviders,
    ShadowProviders,
    stageTouchesPaths,
    validateShadowRange
}
from './shadow-proofs.js';
import { PipelinePass } from './types.js';

/**
 * Heuristic shadow `$match` pushdown.
 *
 * A `$match` conjunct that filters on a deterministic computed field is evaluated early under a
 * temporary `__heuristic_<name>` field, before the expensive stages it would otherwise follow:
 *
 *     $addFields { __heuristic_k: E } · $match { __heuristic_k: … } · $unset __heuristic_k
 *
 * The original provider stays in place and recomputes `k` on the surviving documents.
 */

export interface HeuristicMatchPushdownProof
{
    readonly matchIndex      : number;
    readonly targetIndex     : number;
    readonly shadowAddFields : Record<string, unknown>;
    readonly shadowFilter    : Record<string, unknown>;
    readonly shadowUnsetKeys : readonly string[];
    readonly residualFilter  : Record<string, unknown> | null;
}

type ShadowMatchPlan = Omit<HeuristicMatchPushdownProof, 'matchIndex' | 'residualFilter'>;

/**
 * Maps each path a conjunct reads to the key the shadow providers resolve: the top-level field
 * when an earlier stage computes the path (so `k.sub` resolves the computed key `k`), or the path
 * itself when no earlier stage touches it (a root key).
 */
function mapPathsToShadowKeys( pipeline: readonly any[], matchIndex: number, paths: Iterable<string> ): string[]
{
    const keys = new Set<string>();

    for( const path of paths )
    {
        const computed = pipeline.slice( 0, matchIndex ).some(( stage ) => stageTouchesPaths( stage, [ path ] ));

        keys.add( computed ? path.split( '.' )[ 0 ]! : path );
    }

    return [ ...keys ];
}

/**
 * Returns the shadow keys of a conjunct that is safe to evaluate early and reads at least one
 * eligible computed key, or null. Unsafe conjuncts (whole-document readers such as `$where` and
 * `$jsonSchema`, variables, non-determinism) and `$getField` readers, whose field names the alias
 * rewrite cannot see, are never pushed.
 */
function resolveConjunctShadowKeys(
    pipeline   : readonly any[],
    matchIndex : number,
    conjunct   : Record<string, unknown>,
    context    : GuaranteeContext
): string[] | null
{
    const semantics = analyzeStage({ $match: conjunct });

    if( !isSafeMatchSummary( semantics ) || containsGetField( conjunct ))
    {
        return null;
    }

    const keys = mapPathsToShadowKeys( pipeline, matchIndex, semantics.dependencies.local );

    return resolveShadowProviders( pipeline, matchIndex, keys, context ) ? keys : null;
}

function planShadowMatch(
    pipeline   : readonly any[],
    matchIndex : number,
    conjuncts  : readonly Record<string, unknown>[],
    keys       : readonly string[],
    context    : GuaranteeContext
): ShadowMatchPlan | null
{
    // Each conjunct's keys resolved on their own, and keys resolve independently.
    const providers = resolveShadowProviders( pipeline, matchIndex, keys, context )!;
    const aliases = new Map<string, string>();
    const shadowAddFields: Record<string, unknown> = {};

    for( const computed of providers.computed.values() )
    {
        const shadowKey = allocateShadowFieldName( pipeline, computed.key, new Set( aliases.values() ));

        aliases.set( computed.key, shadowKey );
        shadowAddFields[ shadowKey ] = computed.expr;
    }

    // Shadow names are unreferenced in the pipeline, so renaming cannot collide with a filter key.
    const shadowFilter = rewriteQueryDocument( combineConjuncts( conjuncts ), aliases, false )!.value;

    const canCrossFilters = isStageProvenErrorFree( { $match: shadowFilter } )
        && [ ...providers.computed.values() ].every(( computed ) => isExpressionCompletelyDeterministic( computed.expr, true ));
    const targetIndex = findShadowTargetIndex( pipeline, providers, context, canCrossFilters );

    if(
        targetIndex === null
        || !validateShadowRange( pipeline, targetIndex, matchIndex, providers, context, canCrossFilters )
        || !rangeHasCostlyStage( pipeline, targetIndex, matchIndex, providers )
    )
    {
        return null;
    }

    return { targetIndex, shadowAddFields, shadowFilter, shadowUnsetKeys: [ ...aliases.values() ] };
}

export function proveHeuristicMatchPushdown(
    pipeline   : readonly any[],
    matchIndex : number,
    context    : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): HeuristicMatchPushdownProof | null
{
    const matchStage = pipeline[ matchIndex ];

    if(
        matchIndex <= 0
        || context.strictFieldOrder
        || !isMatchStage( matchStage )
        || ( context.strictErrors && !isStageProvenErrorFree( matchStage ))
    )
    {
        return null;
    }

    const accepted: Record<string, unknown>[] = [];
    const acceptedKeys: string[] = [];
    const residual: Record<string, unknown>[] = [];
    let plan: ShadowMatchPlan | null = null;

    for( const conjunct of decomposeFilterIntoConjuncts( matchStage.$match ))
    {
        const keys = resolveConjunctShadowKeys( pipeline, matchIndex, conjunct, context );
        const candidate = keys && planShadowMatch( pipeline, matchIndex, [ ...accepted, conjunct ], [ ...acceptedKeys, ...keys ], context );

        if( candidate )
        {
            accepted.push( conjunct );
            acceptedKeys.push( ...keys! );
            plan = candidate;
        }
        else
        {
            residual.push( conjunct );
        }
    }

    if( !plan )
    {
        return null;
    }

    return {
        matchIndex,
        ...plan,
        residualFilter: residual.length > 0 ? combineConjuncts( residual ) : null
    };
}

export class HeuristicMatchPushdownPass implements PipelinePass
{
    readonly name       = 'heuristic-match-pushdown';
    readonly stageTypes = [ '$match' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        for( let i = 1; i < pipeline.length; i++ )
        {
            const proof = proveHeuristicMatchPushdown( pipeline, i, context );

            if( proof )
            {
                const result = [ ...pipeline ];

                if( proof.residualFilter )
                {
                    result[ proof.matchIndex ] = { $match: proof.residualFilter };
                }
                else
                {
                    result.splice( proof.matchIndex, 1 );
                }

                result.splice(
                    proof.targetIndex,
                    0,
                    { $addFields: proof.shadowAddFields },
                    { $match: proof.shadowFilter },
                    { $unset: proof.shadowUnsetKeys.length === 1 ? proof.shadowUnsetKeys[ 0 ] : proof.shadowUnsetKeys }
                );

                return result;
            }
        }

        return pipeline;
    }
}
