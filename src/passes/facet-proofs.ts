import { analyzePipeline, analyzeStage } from '../analyzer/semantics.js';
import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { isEqual, isPlainObject } from '../utils.js';
import { stageReadsFieldOrder } from './guarantee-guards.js';
import { getSingleStageEntry, getStageSpec, isMatchStage } from './helpers.js';
import { isSafeMatchSummary } from './movement-proofs.js';
import
{
    canContinuePastStage,
    dependenciesReadAnyPath,
    isExactPathDiscardedByFollower
}
from './projection-proofs.js';

const ALLOWED_HOIST_OPERATORS = new Set([
    '$match',
    '$project',
    '$addFields',
    '$set',
    '$unset',
    '$sort',
    '$limit',
    '$skip',
    '$unwind',
    '$lookup',
    '$count',
    '$sortByCount'
]);

export interface FacetPrefixHoistingProof {
    hoistedStages: any[];
    simplifiedFacet: any;
}

export interface UnionWithPushdownProof
{
    readonly hoistedMatch?     : Record<string, unknown>;
    readonly updatedUnionStage : Record<string, unknown>;
}

function isEligibleHoistStage( stage: unknown, context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): boolean
{
    const entry = getSingleStageEntry( stage );
    if( !entry )
    {
        return false;
    }

    const operator = entry[ 0 ];
    if( !ALLOWED_HOIST_OPERATORS.has( operator ))
    {
        return false;
    }

    const summary = analyzeStage( stage );
    if(
        summary.malformed
        || summary.unknown
        || summary.observable.unknown
        || summary.determinism !== 'deterministic'
        || summary.observable.determinism !== 'deterministic'
        || summary.dependencies.unknown
        || summary.dependencies.variables.size > 0
        || ( context.strictErrors && summary.observable.errors !== 'none-known' )
    )
    {
        return false;
    }

    if(
        operator === '$sort'
        && Object.values( entry[ 1 ] as Record<string, unknown> ).some(
            ( direction ) => direction !== 1 && direction !== -1
        )
    )
    {
        return false;
    }

    return true;
}

export function proveFacetPrefixHoisting(
    stage: unknown,
    context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT,
): FacetPrefixHoistingProof | null
{
    const facetSpec = getStageSpec<Record<string, any>>( stage, '$facet' );
    if( !facetSpec )
    {
        return null;
    }

    const branchNames = Object.keys( facetSpec );
    if( branchNames.length < 2 )
    {
        return null;
    }

    for( const name of branchNames )
    {
        if( !Array.isArray( facetSpec[ name ] ))
        {
            return null;
        }
    }

    // Copy branch array spines so we can pop hoisted stages cleanly
    const branches: Record<string, any[]> = {};
    for( const name of branchNames )
    {
        branches[ name ] = [ ...facetSpec[ name ] ];
    }

    const hoistedStages: any[] = [];

    while( true )
    {
        // Check if every branch has at least one stage remaining
        for( const name of branchNames )
        {
            if( branches[ name ]!.length === 0 )
            {
                return hoistedStages.length > 0
                    ? {
                        hoistedStages,
                        simplifiedFacet: { $facet: branches }
                    }
                    : null;
            }
        }

        const candidate = branches[ branchNames[ 0 ]! ]![ 0 ];
        if( !isEligibleHoistStage( candidate, context ))
        {
            break;
        }

        let allAgree = true;

        for( let i = 1; i < branchNames.length; i++ )
        {
            const stages = branches[ branchNames[ i ]! ]!;
            if( !isEqual( stages[ 0 ], candidate ))
            {
                allAgree = false;
                break;
            }
        }

        if( !allAgree )
        {
            break;
        }

        // Shift the common stage from all branches
        hoistedStages.push( candidate );
        for( const name of branchNames )
        {
            branches[ name ]!.shift();
        }
    }

    if( hoistedStages.length === 0 )
    {
        return null;
    }

    return {
        hoistedStages,
        simplifiedFacet: { $facet: branches }
    };
}

export function proveFacetDeadBranchPruning(
    stage   : unknown,
    suffix  : readonly unknown[],
    context : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): Record<string, any> | null
{
    const facetSpec = getStageSpec<Record<string, any>>( stage, '$facet' );
    if( !facetSpec || suffix.length === 0 )
    {
        return null;
    }

    const facetSem = analyzeStage( stage );
    const branchNames = Object.keys( facetSpec );
    if( facetSem.malformed || facetSem.unknown || branchNames.length < 2 )
    {
        return null;
    }

    const live = new Set<string>();

    for( const name of branchNames )
    {
        const subSummary = analyzePipeline( facetSpec[ name ] );
        if( !context.strictErrors || subSummary.observable.errors === 'none-known' )
        {
            live.add( name );
        }
    }

    if( live.size === 0 )
    {
        return null;
    }

    for( const nextStage of suffix )
    {
        const deadBranches = Array.from( live ).filter(
            ( name ) => isExactPathDiscardedByFollower( name, nextStage )
        );

        if( deadBranches.length >= branchNames.length )
        {
            deadBranches.pop();
        }

        if( deadBranches.length > 0 )
        {
            const deadSet = new Set( deadBranches );
            const prunedFacet: Record<string, any> = {};

            for( const name of branchNames )
            {
                if( !deadSet.has( name ))
                {
                    prunedFacet[ name ] = facetSpec[ name ];
                }
            }

            return { $facet: prunedFacet };
        }

        const semantics = analyzeStage( nextStage );
        for( const name of Array.from( live ))
        {
            if( dependenciesReadAnyPath( semantics, [ name ] ))
            {
                live.delete( name );
            }
        }

        if( live.size === 0 || !canContinuePastStage( semantics, live ))
        {
            return null;
        }
    }

    return null;
}

function extractFollowerCap( followingStages: readonly unknown[] ): number | null
{
    const first = getSingleStageEntry( followingStages[ 0 ] );
    if( !first )
    {
        return null;
    }

    if(
        first[ 0 ] === '$limit'
        && typeof first[ 1 ] === 'number'
        && Number.isSafeInteger( first[ 1 ] )
        && first[ 1 ] > 0
    )
    {
        return first[ 1 ];
    }

    if(
        first[ 0 ] === '$skip'
        && typeof first[ 1 ] === 'number'
        && Number.isSafeInteger( first[ 1 ] )
        && first[ 1 ] >= 0
        && followingStages.length >= 2
    )
    {
        const second = getSingleStageEntry( followingStages[ 1 ] );
        if(
            second
            && second[ 0 ] === '$limit'
            && typeof second[ 1 ] === 'number'
            && Number.isSafeInteger( second[ 1 ] )
            && second[ 1 ] > 0
            && Number.isSafeInteger( first[ 1 ] + second[ 1 ] )
        )
        {
            return first[ 1 ] + second[ 1 ];
        }
    }

    return null;
}

export function proveUnionWithPushdown(
    unionStage      : unknown,
    followingStages : readonly unknown[],
    context         : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): UnionWithPushdownProof | null
{
    const entry = getSingleStageEntry( unionStage );
    if( !entry || entry[ 0 ] !== '$unionWith' || followingStages.length === 0 )
    {
        return null;
    }

    const unionSem = analyzeStage( unionStage );
    if(
        unionSem.malformed
        || unionSem.unknown
        || unionSem.observable.unknown
        || unionSem.observable.determinism !== 'deterministic'
        || ( context.strictErrors && unionSem.observable.errors !== 'none-known' )
    )
    {
        return null;
    }

    const rawUnion = entry[ 1 ];
    const collName = typeof rawUnion === 'string'
        ? rawUnion
        : ( rawUnion as Record<string, any> ).coll as string;
    const subPipeline = isPlainObject( rawUnion ) && Array.isArray( rawUnion.pipeline )
        ? rawUnion.pipeline
        : [];
    const extraProps = isPlainObject( rawUnion ) ? rawUnion : {};

    const firstFollower = followingStages[ 0 ];
    if( isMatchStage( firstFollower ))
    {
        const matchSem = analyzeStage( firstFollower );
        if(
            isSafeMatchSummary( matchSem )
            && !stageReadsFieldOrder( firstFollower )
            && ( !context.strictErrors || matchSem.observable.errors === 'none-known' )
        )
        {
            return {
                hoistedMatch      : firstFollower,
                updatedUnionStage : {
                    $unionWith: {
                        ...extraProps,
                        coll     : collName,
                        pipeline : [ ...subPipeline, firstFollower ]
                    }
                }
            };
        }
    }

    const cap = extractFollowerCap( followingStages );
    if( cap !== null )
    {
        const lastSub = subPipeline.length > 0
            ? getSingleStageEntry( subPipeline[ subPipeline.length - 1 ] )
            : null;

        if(
            lastSub
            && lastSub[ 0 ] === '$limit'
            && typeof lastSub[ 1 ] === 'number'
            && lastSub[ 1 ] <= cap
        )
        {
            return null;
        }

        const nextSub = [ ...subPipeline ] as unknown[];
        if( lastSub && lastSub[ 0 ] === '$limit' )
        {
            nextSub[ nextSub.length - 1 ] = { $limit: cap };
        }
        else
        {
            nextSub.push({ $limit: cap });
        }

        return {
            updatedUnionStage: {
                $unionWith: {
                    ...extraProps,
                    coll     : collName,
                    pipeline : nextSub
                }
            }
        };
    }

    return null;
}
