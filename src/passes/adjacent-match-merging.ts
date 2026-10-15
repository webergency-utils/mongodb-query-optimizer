import { isFilterRewriteSafe } from '../analyzer/filters';
import { projectionVisibility } from '../analyzer/projections';
import { analyzeStage } from '../analyzer/semantics';
import { optimizeFilterWithContext } from '../filter-optimizer';
import { GuaranteeContext } from '../guarantees';
import { isEqual, isPlainObject } from '../utils';
import { combineConjuncts, decomposeFilterIntoConjuncts, isMatchStage } from './helpers';
import { isSafeMatchSummary } from './movement-proofs';
import { arePathsDisjoint } from './path-disjoint';
import { PipelinePass } from './types';

const DOMINANCE_PRESERVING_OPERATORS = new Set([
    '$addFields',
    '$set',
    '$unset',
    '$project',
    '$unwind',
    '$sort',
    '$limit',
    '$skip',
    '$sample',
    '$lookup',
    '$graphLookup'
]);

function isMergeableMatchStage( stage: any ): boolean
{
    return isMatchStage( stage ) && isFilterRewriteSafe( stage.$match );
}

function eliminateDominatedMatchConjuncts( pipeline: any[] ): any[]
{
    let current = pipeline;

    for( let i = 0; i < current.length; i++ )
    {
        const upStage = current[ i ];

        if( !isMatchStage( upStage )){ continue }

        const upConjuncts = decomposeFilterIntoConjuncts( upStage.$match ).filter(( c ) =>
            isPlainObject( c ) && isSafeMatchSummary( analyzeStage({ $match: c }) )
        );

        if( upConjuncts.length === 0 ){ continue }

        for( const upConjunct of upConjuncts )
        {
            const upDeps = analyzeStage({ $match: upConjunct }).dependencies.local;

            for( let j = i + 1; j < current.length; j++ )
            {
                const downStage = current[ j ];

                if( isMatchStage( downStage ))
                {
                    const downSem = analyzeStage( downStage );

                    if( !downSem.malformed )
                    {
                        const downConjuncts = decomposeFilterIntoConjuncts( downStage.$match );
                        const remaining = downConjuncts.filter(
                            ( c ) => !( isPlainObject( c ) && isEqual( c, upConjunct ))
                        );

                        if( remaining.length < downConjuncts.length )
                        {
                            if( current === pipeline )
                            {
                                current = [ ...pipeline ];
                            }

                            if( remaining.length === 0 )
                            {
                                current.splice( j, 1 );
                                j--;
                            }
                            else
                            {
                                current[ j ] = { $match: combineConjuncts( remaining ) };
                            }
                        }
                    }

                    continue;
                }

                const sem = analyzeStage( downStage );

                if(
                    sem.malformed
                    || sem.unknown
                    || sem.observable.unknown
                    || !DOMINANCE_PRESERVING_OPERATORS.has( sem.operator )
                )
                {
                    break;
                }

                if( sem.operator === '$project' )
                {
                    const hiddenOrComputed = Array.from( upDeps ).some(
                        ( dep ) =>
                            projectionVisibility( sem.projection!, dep ) !== 'visible'
                            || !arePathsDisjoint([ dep ], sem.projection!.computedPaths )
                    );

                    if( hiddenOrComputed ){ break }
                }
                else if(
                    !arePathsDisjoint( sem.writes, upDeps )
                    || !arePathsDisjoint( sem.modifies, upDeps )
                    || !arePathsDisjoint( sem.removes, upDeps )
                )
                {
                    break;
                }
            }
        }
    }

    return current;
}

export class AdjacentMatchMergingPass implements PipelinePass
{
    readonly name       = 'adjacent-match-merging';
    readonly stageTypes = [ '$match' ] as const;

    execute( pipeline: any[], context: GuaranteeContext ): any[]
    {
        const deduplicated = eliminateDominatedMatchConjuncts( pipeline );
        const result: any[] = [];
        let index = 0;

        while( index < deduplicated.length )
        {
            const stage = deduplicated[ index ];

            if( !isMergeableMatchStage( stage ))
            {
                result.push( stage );
                index++;
                continue;
            }

            const matches: any[] = [];

            while(
                index < deduplicated.length
                && isMergeableMatchStage( deduplicated[ index ] )
            )
            {
                matches.push( deduplicated[ index ].$match );
                index++;
            }

            result.push(
                matches.length === 1
                    ? stage
                    : { $match: optimizeFilterWithContext( { $and: matches }, context ) }
            );
        }

        return result;
    }
}
