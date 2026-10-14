import { DEFAULT_GUARANTEE_CONTEXT, type GuaranteeContext } from '../guarantees';
import { isExactTopLevelPath, relatePaths } from '../analyzer/paths';
import { analyzeProjection, projectionVisibility } from '../analyzer/projections';
import { analyzeStage } from '../analyzer/semantics';
import { isPlainObject } from '../utils';
import { getSingleStageEntry } from './helpers';
import 
{ 
    canContinuePastStage, 
    dependenciesReadAnyPath, 
    exactUnsetFields, 
    hasOnlyKnownDependencyPaths, 
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

function isFieldDeadInSuffix(
    path    : string,
    suffix  : readonly unknown[],
    context : GuaranteeContext
): boolean
{
    for( const stage of suffix )
    {
        const semantics = analyzeStage( stage );

        // 1. Check if stage kills path via unset
        const unsetFields = exactUnsetFields( stage );

        if( unsetFields && unsetFields.has( path ))
        {
            return true;
        }

        // 2. Check if stage overwrites path via $addFields or $set
        const overwrite = parseAddFieldStage( stage, false );

        if( overwrite && isExactTopLevelPath( path ) && path in overwrite.specification )
        {
            if( dependenciesReadAnyPath( overwrite.semantics, [ path ]))
            {
                return false;
            }

            if( context.strictFieldOrder )
            {
                return false;
            }

            return true;
        }

        if(
            semantics.operator === '$group'
            || semantics.operator === '$count'
            || semantics.operator === '$sortByCount'
            || semantics.operator === '$bucket'
            || semantics.operator === '$bucketAuto'
        )
        {
            return (
                hasOnlyKnownDependencyPaths( semantics )
                && !dependenciesReadAnyPath( semantics, [ path ])
            );
        }

        // 3. Check if stage discards path via $project
        const project = parseSimpleProject( stage );

        if( project )
        {
            const visibility = projectionVisibility( project.projection, path );

            if( visibility === 'hidden' || visibility === 'removed' )
            {
                return true;
            }
        }

        // 4. If not killed, check if downstream reads this path
        if( dependenciesReadAnyPath( semantics, [ path ]))
        {
            return false;
        }

        // 5. If not killed and not read, check if we can safely continue past this stage
        if( !canContinuePastStage( semantics, new Set([ path ])))
        {
            return false;
        }
    }

    return false;
}

function parseProjectForComputedPruning( stage: unknown ): Record<string, unknown> | null
{
    const entry = getSingleStageEntry( stage );
    if( !entry || entry[ 0 ] !== '$project' || !isPlainObject( entry[ 1 ])){ return null }

    const projection = analyzeProjection( entry[ 1 ], 'project' );
    if(
        projection.unknown
        || projection.mode !== 'inclusion'
        || projection.computedPaths.size === 0
    )
    {
        return null;
    }

    const semantics = analyzeStage( stage );
    if( !hasOnlyKnownDependencyPaths( semantics ))
    {
        return null;
    }

    return entry[ 1 ];
}

function allExactUnsetFields( stage: unknown ): Set<string> | null
{
    const entry = getSingleStageEntry( stage );
    if( !entry || entry[ 0 ] !== '$unset' )
    {
        return null;
    }

    const values = Array.isArray( entry[ 1 ] ) ? entry[ 1 ] : [ entry[ 1 ] ];
    if(
        values.length === 0
        || values.some(
            ( value ) => typeof value !== 'string' || relatePaths( value, value ) !== 'exact'
        )
    )
    {
        return null;
    }

    return new Set( values as string[] );
}

/**
 * Proves that one or more computed assignments in an `$addFields`, `$set`, or
 * inclusion `$project` stage, or field removals in an `$unset` stage, are dead
 * because they are never read before being overwritten or discarded by downstream stages.
 */
export function proveDeadAssignmentElimination(
    sourceStage : unknown,
    suffix      : readonly unknown[],
    context     : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): DeadAssignmentProof | null
{
    if( !Array.isArray( suffix ) || suffix.length === 0 ){ return null }

    const unsetFields = allExactUnsetFields( sourceStage );
    if( unsetFields )
    {
        const deadFields: string[] = [];

        for( const path of unsetFields )
        {
            const checkPath = isExactTopLevelPath( path )
                ? path
                : path.slice( 0, path.indexOf( '.' ));

            if( isFieldDeadInSuffix( checkPath, suffix, context ))
            {
                deadFields.push( path );
            }
        }

        if( deadFields.length === 0 ){ return null }

        const deadSet = new Set( deadFields );
        const remaining = Array.from( unsetFields ).filter(( path ) => !deadSet.has( path ));
        const replacementStage = remaining.length === 0
            ? null
            : { $unset: remaining.length === 1 ? remaining[ 0 ] : remaining };

        return {
            replacementStage,
            eliminatedFields: deadFields
        };
    }

    const projectSpec = parseProjectForComputedPruning( sourceStage );
    if( projectSpec )
    {
        const deadFields = new Set<string>();

        for( const [ path, expression ] of Object.entries( projectSpec ))
        {
            if(
                path === '_id'
                || expression === 0
                || expression === 1
                || expression === false
                || expression === true
                || !isExactTopLevelPath( path )
                || !isSafePrunableAssignment( expression, context.strictErrors )
            )
            {
                continue;
            }

            if( isFieldDeadInSuffix( path, suffix, context ))
            {
                deadFields.add( path );
            }
        }

        if( deadFields.size === 0 ){ return null }

        const remaining = Object.entries( projectSpec ).filter(
            ([ path ]) => !deadFields.has( path )
        );

        const hasRemainingNonIdInclusionOrCompute = remaining.some(
            ([ path, value ]) => path !== '_id' && value !== 0 && value !== false
        );
        const hasRemainingIdInclusionOrCompute = remaining.some(
            ([ path, value ]) => path === '_id' && value !== 0 && value !== false
        );

        if( !hasRemainingNonIdInclusionOrCompute && !hasRemainingIdInclusionOrCompute )
        {
            return null;
        }

        return {
            replacementStage: { $project: Object.fromEntries( remaining ) },
            eliminatedFields: Array.from( deadFields )
        };
    }

    const source = parseAddFieldStage( sourceStage, false );

    if( !source ){ return null }

    const deadFields = new Set<string>();

    for( const [ path, expression ] of Object.entries( source.specification ))
    {
        const isTopLevel = isExactTopLevelPath( path );

        if(
            ( !isTopLevel && context.strictErrors )
            || !isSafePrunableAssignment( expression, context.strictErrors )
        )
        {
            continue;
        }

        const checkPath = isTopLevel ? path : path.slice( 0, path.indexOf( '.' ));

        if( isFieldDeadInSuffix( checkPath, suffix, context ))
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

function collectGuaranteedPresentTopLevelFields( prefix: readonly unknown[] ): Set<string>
{
    const guaranteed = new Set<string>();

    for( const stage of prefix )
    {
        const addField = parseAddFieldStage( stage, false );
        if( addField )
        {
            for( const key of Object.keys( addField.specification ))
            {
                if( isExactTopLevelPath( key ))
                {
                    guaranteed.add( key );
                }
            }
            continue;
        }

        const unset = allExactUnsetFields( stage );
        if( unset )
        {
            for( const path of unset )
            {
                guaranteed.delete( path.split( '.' )[ 0 ]! );
            }
            continue;
        }

        const semantics = analyzeStage( stage );
        if(
            semantics.malformed
            || semantics.unknown
            || (
                semantics.operator !== '$match'
                && semantics.operator !== '$sort'
                && semantics.operator !== '$limit'
                && semantics.operator !== '$skip'
            )
        )
        {
            guaranteed.clear();
        }
    }

    return guaranteed;
}

export function proveNoOpSelfAssignmentElimination(
    prefix      : readonly unknown[],
    sourceStage : unknown,
    context     : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): DeadAssignmentProof | null
{
    if( context.strictFieldOrder || prefix.length === 0 )
    {
        return null;
    }

    const source = parseAddFieldStage( sourceStage, false );
    if( !source )
    {
        return null;
    }

    const guaranteed = collectGuaranteedPresentTopLevelFields( prefix );
    if( guaranteed.size === 0 )
    {
        return null;
    }

    const deadFields: string[] = [];

    for( const [ path, expression ] of Object.entries( source.specification ))
    {
        if(
            guaranteed.has( path )
            && (
                expression === `$${ path }`
                || expression === `$$ROOT.${ path }`
                || expression === `$$CURRENT.${ path }`
            )
        )
        {
            deadFields.push( path );
        }
    }

    if( deadFields.length === 0 )
    {
        return null;
    }

    const deadSet = new Set( deadFields );
    const remaining = Object.entries( source.specification ).filter(
        ([ path ]) => !deadSet.has( path )
    );

    const replacementStage = remaining.length === 0
        ? null
        : { [ source.operator ]: Object.fromEntries( remaining ) };

    return {
        replacementStage,
        eliminatedFields: deadFields
    };
}
