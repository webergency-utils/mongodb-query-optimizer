import { isExactPath, relatePaths } from '../analyzer/paths';
import { isValidProjectionPath } from '../analyzer/projections';
import { analyzeStage } from '../analyzer/semantics';
import { DEFAULT_GUARANTEE_CONTEXT, type GuaranteeContext } from '../guarantees';
import { getSingleStageEntry, getStageSpec } from './helpers.js';

export interface CoveredProjectionProof
{
    readonly synthesizedStage : {
        readonly $project : Record<string, 0 | 1>
    }
    readonly insertIndex      : number
}

const COLLAPSING_OPERATORS = new Set([ '$group', '$count', '$sortByCount', '$bucket', '$bucketAuto' ]);

const DISALLOWED_PREFIX_OPERATORS = new Set([
    '$project',
    '$unset',
    '$fill',
    '$replaceRoot',
    '$replaceWith',
    '$facet',
    '$lookup',
    '$unionWith',
    '$unwind',
    '$sample'
]);

function isCollapsingStage( stage: unknown ): boolean
{
    const entry = getSingleStageEntry( stage );
    if( !entry ){ return false }

    return COLLAPSING_OPERATORS.has( entry[ 0 ]);
}

function isPrecededOnlyByMatches( pipeline: readonly any[], index: number ): boolean
{
    for( let i = 0; i < index; i++ )
    {
        const entry = getSingleStageEntry( pipeline[ i ]);
        if( entry![ 0 ] !== '$match' ){ return false }
    }

    return true;
}

export function proveCoveredProjectionSynthesis( pipeline: readonly any[] ): CoveredProjectionProof | null
{
    if( !Array.isArray( pipeline ) || pipeline.length === 0 ){ return null }

    let collapseIndex = -1;

    for( let i = 0; i < pipeline.length; i++ )
    {
        if( isCollapsingStage( pipeline[ i ]))
        {
            collapseIndex = i;
            break;
        }
    }

    if( collapseIndex === -1 ){ return null }

    const collapseStage = pipeline[ collapseIndex ];
    const collapseSemantics = analyzeStage( collapseStage );

    if(
        collapseSemantics.unknown
        || collapseSemantics.malformed
        || collapseSemantics.observable.unknown
        || collapseSemantics.children.length > 0
        || collapseSemantics.dependencies.unknown
        || collapseSemantics.dependencies.foreign.size > 0
        || collapseSemantics.dependencies.element.size > 0
        || collapseSemantics.dependencies.local.has( '*' )
        || collapseSemantics.determinism !== 'deterministic'
        || collapseSemantics.observable.determinism !== 'deterministic'
    )
    {
        return null;
    }

    for( let i = 0; i < collapseIndex; i++ )
    {
        const stage = pipeline[ i ];
        const entry = getSingleStageEntry( stage );
        if( !entry || DISALLOWED_PREFIX_OPERATORS.has( entry[ 0 ])){ return null }

        const sem = analyzeStage( stage );
        if(
            sem.unknown
            || sem.malformed
            || sem.observable.unknown
            || sem.children.length > 0
            || sem.dependencies.unknown
            || sem.dependencies.foreign.size > 0
            || sem.dependencies.element.size > 0
            || sem.dependencies.local.has( '*' )
            || sem.determinism !== 'deterministic'
            || sem.observable.determinism !== 'deterministic'
        )
        {
            return null;
        }
    }

    for( let i = 0; i < collapseIndex; i++ )
    {
        const entry = getSingleStageEntry( pipeline[ i ]);
        if( entry![ 0 ] !== '$sort' ){ continue }
        if( isPrecededOnlyByMatches( pipeline, i )){ return null }
    }

    let insertIndex = 0;

    while( insertIndex < collapseIndex )
    {
        const entry = getSingleStageEntry( pipeline[ insertIndex ]);
        if( !entry || entry[ 0 ] !== '$match' )
        {
            break;
        }

        insertIndex++;
    }

    const live = new Set<string>();

    for( const dep of collapseSemantics.dependencies.local )
    {
        if( !isValidProjectionPath( dep )){ return null }

        live.add( dep );
    }

    for( let i = collapseIndex - 1; i >= insertIndex; i-- )
    {
        const sem = analyzeStage( pipeline[ i ]);

        for( const w of sem.writes )
        {
            live.delete( w );
        }

        for( const r of sem.dependencies.local )
        {
            if( !isValidProjectionPath( r )){ return null }

            live.add( r );
        }
    }

    if( live.size === 0 ){ return null }

    let needsId = false;

    for( const path of live )
    {
        if( path === '_id' || relatePaths( path, '_id' ) !== 'disjoint' )
        {
            needsId = true;
            break;
        }
    }

    const minimalPaths = new Set<string>();

    for( const path of live )
    {
        if( path === '_id' || relatePaths( path, '_id' ) !== 'disjoint' )
        {
            continue;
        }

        const hasAncestor = Array.from( live ).some(( other ) =>
            other !== path && relatePaths( other, path ) === 'ancestor'
        );

        if( !hasAncestor )
        {
            minimalPaths.add( path );
        }
    }

    const sorted = Array.from( minimalPaths ).sort();
    const projectSpec: Record<string, 0 | 1> = {};

    for( const path of sorted )
    {
        projectSpec[ path ] = 1;
    }

    projectSpec._id = needsId ? 1 : 0;

    return {
        synthesizedStage: { $project: projectSpec },
        insertIndex
    };
}

/**
 * Removes a row-count-neutral prefix immediately before `$count` or a
 * zero-dependency `$group` (such as `{ $group: { _id: null, count: { $sum: 1 } } }`).
 * A `$sort` is always treated as non-failing. A `$lookup` or other row-count-preserving
 * stage is removed when strict errors are off and no later kept stage reads the document shape.
 * A plain inclusion or exclusion `$project` is removed when no later kept
 * stage still reads the document shape.
 */
export function trimCountNeutralPrefix(
    pipeline : readonly any[],
    context  : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): any[]
{
    const result = [ ...pipeline ];

    for( let index = result.length - 1; index >= 0; index-- )
    {
        if( !isDependencyFreeCollapsingStage( result[ index ])){ continue }

        index = dropCountNeutralPrefix( result, index, context.strictErrors );
    }

    return result;
}

function isDependencyFreeCollapsingStage( stage : unknown ): boolean
{
    const entry = getSingleStageEntry( stage );

    if( !entry ){ return false }

    if( entry[ 0 ] === '$count' ){ return true }

    if( entry[ 0 ] !== '$group' ){ return false }

    const semantics = analyzeStage( stage );

    return (
        !semantics.malformed
        && !semantics.dependencies.unknown
        && semantics.dependencies.local.size === 0
        && semantics.dependencies.variables.size === 0
        && semantics.determinism === 'deterministic'
    );
}

function isErrorFreeCountNeutralStage( stage : unknown ): boolean
{
    const entry = getSingleStageEntry( stage );
    if( !entry || entry[ 0 ] === '$lookup' )
    {
        return false;
    }

    const semantics = analyzeStage( stage );

    return (
        !semantics.malformed
        && !semantics.unknown
        && !semantics.observable.unknown
        && semantics.determinism === 'deterministic'
        && semantics.observable.determinism === 'deterministic'
        && semantics.observable.errors === 'none-known'
    );
}

function dropCountNeutralPrefix(
    pipeline     : any[],
    countIndex   : number,
    strictErrors : boolean
): number
{
    let cursor = countIndex - 1;
    let shapeReaderKept = false;

    while( cursor >= 0 )
    {
        const stage = pipeline[ cursor ];

        if( isRemovableSort( stage ))
        {
            pipeline.splice( cursor, 1 );
            countIndex--;
            cursor--;
            continue;
        }

        if( preservesRowCount( stage ))
        {
            if( !shapeReaderKept && ( !strictErrors || isErrorFreeCountNeutralStage( stage )))
            {
                pipeline.splice( cursor, 1 );
                countIndex--;
                cursor--;
                continue;
            }

            shapeReaderKept = true;
            cursor--;
            continue;
        }

        break;
    }

    return countIndex;
}

function isRemovableSort( stage : unknown ): boolean
{
    return getStageSpec( stage, '$sort' ) !== null;
}

function preservesRowCount( stage : unknown ): boolean
{
    const semantics = analyzeStage( stage );

    if( semantics.malformed || semantics.unknown ){ return false }

    return semantics.cardinality === 'preserves';
}
