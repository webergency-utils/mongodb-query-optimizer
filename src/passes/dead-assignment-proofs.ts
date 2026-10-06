import { isExactTopLevelPath } from '../analyzer/paths';
import { projectionVisibility } from '../analyzer/projections';
import { analyzeStage } from '../analyzer/semantics';
import 
{ 
    canContinuePastStage, 
    dependenciesReadAnyPath, 
    exactUnsetFields, 
    isSafePrunableAssignment, 
    parseAddFieldStage, 
    parseSimpleProject 
} 
from './projection-proofs';

export interface DeadAssignmentProof
{
    readonly replacementStage : Record<string, unknown> | null
    readonly eliminatedFields : readonly string[]
}

/**
 * Proves that one or more computed assignments in an $addFields or $set stage
 * are dead because they are never read before being overwritten or discarded
 * by downstream stages.
 */
export function proveDeadAssignmentElimination(
    sourceStage : unknown,
    suffix      : readonly unknown[]
): DeadAssignmentProof | null
{
    if( !Array.isArray( suffix ) || suffix.length === 0 ){ return null }

    const source = parseAddFieldStage( sourceStage, false );

    if( !source ){ return null }

    const deadFields = new Set<string>();

    for( const [ path, expression ] of Object.entries( source.specification ))
    {
        if( !isExactTopLevelPath( path ) || !isSafePrunableAssignment( expression ))
        {
            continue;
        }

        let isDead = false;

        for( const stage of suffix )
        {
            const semantics = analyzeStage( stage );

            // 1. Check if stage kills path via unset
            const unsetFields = exactUnsetFields( stage );

            if( unsetFields && unsetFields.has( path ))
            {
                isDead = true;
                break;
            }

            // 2. Check if stage overwrites path via $addFields or $set
            const overwrite = parseAddFieldStage( stage, false );

            if( overwrite && isExactTopLevelPath( path ) && path in overwrite.specification )
            {
                if( dependenciesReadAnyPath( overwrite.semantics, [ path ]))
                {
                    break;
                }

                isDead = true;
                break;
            }

            // 3. Check if stage discards path via $project
            const project = parseSimpleProject( stage );

            if( project )
            {
                const visibility = projectionVisibility( project.projection, path );

                if( visibility === 'hidden' || visibility === 'removed' )
                {
                    isDead = true;
                    break;
                }
            }

            // 4. If not killed, check if downstream reads this path
            if( dependenciesReadAnyPath( semantics, [ path ]))
            {
                break;
            }

            // 5. If not killed and not read, check if we can safely continue past this stage
            if( !canContinuePastStage( semantics, new Set([ path ])))
            {
                break;
            }
        }

        if( isDead )
        {
            deadFields.add( path );
        }
    }

    if( deadFields.size === 0 ){ return null }

    const remaining = Object.entries( source.specification ).filter(
        ([ path ]) => !deadFields.has( path )
    );

    const replacementStage = remaining.length === 0
        ? null
        : { [ source.operator ]: Object.fromEntries( remaining ) };

    return {
        replacementStage,
        eliminatedFields: Array.from( deadFields )
    };
}
