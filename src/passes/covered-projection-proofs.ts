import { isExactPath, relatePaths } from '../analyzer/paths';
import { isValidProjectionPath } from '../analyzer/projections';
import { analyzeStage } from '../analyzer/semantics';
import { isPlainObject } from '../utils.js';
import { getSingleStageEntry } from './helpers.js';

export interface CoveredProjectionProof
{
    readonly synthesizedStage : {
        readonly $project : Record<string, 0 | 1>
    }
    readonly insertIndex      : number
}

const COLLAPSING_OPERATORS = new Set([ '$group', '$count', '$sortByCount' ]);

const DISALLOWED_PREFIX_OPERATORS = new Set([
    '$project',
    '$unset',
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
        || collapseSemantics.dependencies.variables.size > 0
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
            || sem.dependencies.variables.size > 0
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
