import { analyzeExpression } from '../analyzer/expressions.js';
import { relatePaths } from '../analyzer/paths.js';
import { projectionVisibility } from '../analyzer/projections.js';
import { analyzeStage } from '../analyzer/semantics.js';
import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { isPlainObject } from '../utils.js';
import { canMoveStageAcrossStage, isStageProvenErrorFree, pipelineReadsFieldOrder } from './guarantee-guards.js';
import { getSingleStageEntry } from './helpers.js';

export interface TopKPushdownProof
{
    readonly sortIndex   : number;
    readonly targetIndex : number;
    readonly sliceLength : number;
}

export interface HeuristicTopKPushdownProof
{
    readonly sortIndex        : number;
    readonly sliceLength      : number;
    readonly targetIndex      : number;
    readonly shadowAddFields  : Record<string, unknown>;
    readonly shadowSortSpec   : Record<string, unknown>;
    readonly shadowUnsetKeys  : readonly string[];
}

const TOP_K_PASSIVE_OPERATORS = new Set([
    '$lookup',
    '$addFields',
    '$set',
    '$unset'
]);

export function arePathsDisjoint(
    left  : Iterable<string>,
    right : Iterable<string>
): boolean
{
    for( const leftPath of left )
    {
        for( const rightPath of right )
        {
            if( relatePaths( leftPath, rightPath ) !== 'disjoint' )
            {
                return false;
            }
        }
    }

    return true;
}

export function parseSafeSortKeys( sortStage: unknown ): string[] | null
{
    const entry = getSingleStageEntry( sortStage );

    if(
        !entry
        || entry[ 0 ] !== '$sort'
        || !isPlainObject( entry[ 1 ] )
    )
    {
        return null;
    }

    const sortSpec = entry[ 1 ];
    const keys = Object.keys( sortSpec );

    if(
        keys.length === 0
        || Object.values( sortSpec ).some(
            ( direction ) => direction !== 1 && direction !== -1
        )
    )
    {
        return null;
    }

    return keys;
}

export function parseTopKFollower(
    pipeline  : readonly any[],
    sortIndex : number
): { sliceLength: number } | null
{
    if( sortIndex + 1 >= pipeline.length )
    {
        return null;
    }

    const firstFollower = pipeline[ sortIndex + 1 ];
    const firstEntry = getSingleStageEntry( firstFollower );

    if( !firstEntry )
    {
        return null;
    }

    if( firstEntry[ 0 ] === '$limit' )
    {
        const limitVal = firstEntry[ 1 ];

        if( typeof limitVal === 'number' && Number.isSafeInteger( limitVal ) && limitVal > 0 )
        {
            return { sliceLength: 2 };
        }

        return null;
    }

    if( firstEntry[ 0 ] === '$skip' && sortIndex + 2 < pipeline.length )
    {
        const skipVal = firstEntry[ 1 ];

        if( typeof skipVal === 'number' && Number.isSafeInteger( skipVal ) && skipVal >= 0 )
        {
            const secondFollower = pipeline[ sortIndex + 2 ];
            const secondEntry = getSingleStageEntry( secondFollower );

            if( secondEntry && secondEntry[ 0 ] === '$limit' )
            {
                const limitVal = secondEntry[ 1 ];

                if( typeof limitVal === 'number' && Number.isSafeInteger( limitVal ) && limitVal > 0 )
                {
                    return { sliceLength: 3 };
                }
            }
        }
    }

    return null;
}

export function canTopKPushAcrossStage(
    stage              : unknown,
    sortKeys           : readonly string[],
    context            : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT,
    downstreamPipeline : readonly unknown[] = []
): boolean
{
    const entry = getSingleStageEntry( stage );

    if( !entry || !TOP_K_PASSIVE_OPERATORS.has( entry[ 0 ] ))
    {
        return false;
    }

    const sortStage = { $sort: Object.fromEntries( sortKeys.map(( k ) => [ k, 1 ] )) };

    if( !canMoveStageAcrossStage( sortStage, stage, 'earlier', context, downstreamPipeline ))
    {
        return false;
    }

    const semantics = analyzeStage( stage );

    if(
        semantics.unknown
        || semantics.malformed
        || semantics.cardinality !== 'preserves'
        || semantics.order !== 'preserves'
    )
    {
        return false;
    }

    if(
        !arePathsDisjoint( semantics.writes, sortKeys )
        || !arePathsDisjoint( semantics.modifies, sortKeys )
        || !arePathsDisjoint( semantics.removes, sortKeys )
    )
    {
        return false;
    }

    return true;
}

export function proveTopKPushdown(
    pipeline  : readonly any[],
    sortIndex : number,
    context   : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): TopKPushdownProof | null
{
    if( sortIndex <= 0 || sortIndex >= pipeline.length )
    {
        return null;
    }

    const sortKeys = parseSafeSortKeys( pipeline[ sortIndex ] );

    if( !sortKeys )
    {
        return null;
    }

    const follower = parseTopKFollower( pipeline, sortIndex );

    if( !follower )
    {
        return null;
    }

    const downstreamPipeline = pipeline.slice( sortIndex + 1 );
    let targetIndex = sortIndex;

    for( let i = sortIndex - 1; i >= 0; i-- )
    {
        if( !canTopKPushAcrossStage( pipeline[ i ], sortKeys, context, downstreamPipeline ))
        {
            break;
        }

        targetIndex = i;
    }

    if( targetIndex === sortIndex )
    {
        return null;
    }

    return {
        sortIndex,
        targetIndex,
        sliceLength: follower.sliceLength
    };
}

export function isExpressionCompletelyDeterministic( expr: unknown, strictErrors: boolean = false ): boolean
{
    if( typeof expr === 'string' && /\$\$(NOW|CLUSTER_TIME)\b/.test( expr ))
    {
        return false;
    }

    if( expr && typeof expr === 'object' && /\$\$(NOW|CLUSTER_TIME)\b/.test( JSON.stringify( expr ) ))
    {
        return false;
    }

    if( expr && typeof expr === 'object' && !Array.isArray( expr ))
    {
        const obj = expr as Record<string, unknown>;

        if( '$function' in obj && isPlainObject( obj.$function ))
        {
            if( strictErrors )
            {
                return false;
            }

            const fnObj = obj.$function as Record<string, unknown>;

            if( typeof fnObj.body !== 'string' || !Array.isArray( fnObj.args ))
            {
                return false;
            }

            if( /\b(Date|Math\.random|crypto|performance\.now)\b/.test( fnObj.body ))
            {
                return false;
            }

            for( const arg of fnObj.args )
            {
                const argSummary = analyzeExpression( arg );

                if(
                    argSummary.unknown
                    || argSummary.dependencies.unknown
                    || argSummary.dependencies.local.has( '*' )
                    || argSummary.determinism !== 'deterministic'
                )
                {
                    return false;
                }
            }

            return true;
        }
    }

    const summary = analyzeExpression( expr );

    if(
        summary.unknown
        || summary.dependencies.unknown
        || summary.dependencies.local.has( '*' )
        || summary.determinism !== 'deterministic'
    )
    {
        return false;
    }

    if( strictErrors && summary.errors !== 'none-known' )
    {
        return false;
    }

    return true;
}

export function collectExpressionDependencies( expr: unknown ): Set<string>
{
    const deps = new Set<string>();

    if( expr && typeof expr === 'object' && !Array.isArray( expr ))
    {
        const obj = expr as Record<string, unknown>;

        if( '$function' in obj && isPlainObject( obj.$function ))
        {
            const fnObj = obj.$function as Record<string, unknown>;

            if( Array.isArray( fnObj.args ))
            {
                for( const arg of fnObj.args )
                {
                    const s = analyzeExpression( arg );

                    for( const p of s.dependencies.local )
                    {
                        deps.add( p );
                    }
                }
            }

            return deps;
        }
    }

    const summary = analyzeExpression( expr );

    for( const p of summary.dependencies.local )
    {
        deps.add( p );
    }

    return deps;
}

function pipelineReferencesKey( pipeline: readonly any[], key: string ): boolean
{
    const keyJson = JSON.stringify( key );

    for( const stage of pipeline )
    {
        if( JSON.stringify( stage ).includes( keyJson ))
        {
            return true;
        }
    }

    return false;
}

export function proveHeuristicTopKPushdown(
    pipeline   : readonly any[],
    sortIndex  : number,
    context    : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): HeuristicTopKPushdownProof | null
{
    if( sortIndex <= 0 || sortIndex >= pipeline.length )
    {
        return null;
    }

    if( context.strictFieldOrder )
    {
        return null;
    }

    const follower = parseTopKFollower( pipeline, sortIndex );

    if( !follower )
    {
        return null;
    }

    const downstreamPipeline = pipeline.slice( sortIndex + 1 );

    if( pipelineReadsFieldOrder( downstreamPipeline ))
    {
        return null;
    }

    const sortKeys = parseSafeSortKeys( pipeline[ sortIndex ] );

    if( !sortKeys )
    {
        return null;
    }

    const sortEntry = getSingleStageEntry( pipeline[ sortIndex ] );
    const sortSpec = sortEntry![ 1 ] as Record<string, unknown>;

    const computedSortKeys = new Map<string, { providerIndex: number; expr: unknown }>();
    const requiredPaths = new Set<string>();
    let minProviderIndex = sortIndex;

    for( const key of sortKeys )
    {
        let providerFound = false;

        for( let i = sortIndex - 1; i >= 0; i-- )
        {
            const semantics = analyzeStage( pipeline[ i ] );

            if( !arePathsDisjoint( semantics.writes, [ key ] ) || !arePathsDisjoint( semantics.modifies, [ key ] ))
            {
                const entry = getSingleStageEntry( pipeline[ i ] );

                if( !entry || ( entry[ 0 ] !== '$addFields' && entry[ 0 ] !== '$set' ) || !isPlainObject( entry[ 1 ] ))
                {
                    return null;
                }

                const expr = ( entry[ 1 ] as Record<string, unknown> )[ key ];

                if( expr === undefined )
                {
                    return null;
                }

                if( !isExpressionCompletelyDeterministic( expr, context.strictErrors ))
                {
                    return null;
                }

                computedSortKeys.set( key, { providerIndex: i, expr } );

                if( i < minProviderIndex )
                {
                    minProviderIndex = i;
                }

                const exprDeps = collectExpressionDependencies( expr );

                for( const dep of exprDeps )
                {
                    requiredPaths.add( dep );
                }

                providerFound = true;
                break;
            }
        }

        if( !providerFound )
        {
            requiredPaths.add( key );
        }
    }

    if( computedSortKeys.size === 0 )
    {
        return null;
    }

    let targetIndex = minProviderIndex;

    for( let i = minProviderIndex - 1; i >= 0; i-- )
    {
        const stage = pipeline[ i ];
        const semantics = analyzeStage( stage );

        if(
            semantics.unknown
            || semantics.malformed
            || semantics.dependencies.unknown
            || semantics.cardinality !== 'preserves'
            || semantics.order !== 'preserves'
        )
        {
            break;
        }

        if(
            !arePathsDisjoint( semantics.writes, requiredPaths )
            || !arePathsDisjoint( semantics.modifies, requiredPaths )
            || !arePathsDisjoint( semantics.removes, requiredPaths )
        )
        {
            break;
        }

        if( context.strictErrors && !isStageProvenErrorFree( stage ))
        {
            break;
        }

        targetIndex = i;
    }

    if( targetIndex >= minProviderIndex )
    {
        return null;
    }

    for( let i = targetIndex; i < sortIndex; i++ )
    {
        const semantics = analyzeStage( pipeline[ i ] );

        if( semantics.cardinality !== 'preserves' || semantics.order !== 'preserves' )
        {
            return null;
        }
    }

    const shadowAddFields: Record<string, unknown> = {};
    const shadowSortSpec: Record<string, unknown> = {};
    const shadowUnsetKeys: string[] = [];

    for( const key of sortKeys )
    {
        const computed = computedSortKeys.get( key );

        if( computed )
        {
            const sanitizedName = key.replace( /[^a-zA-Z0-9_]/g, '_' );
            let shadowKey = `__heuristic_${ sanitizedName }`;

            let counter = 0;
            while( pipelineReferencesKey( pipeline, shadowKey ) || shadowKey in shadowAddFields )
            {
                shadowKey = `__heuristic_${ sanitizedName }_${ counter++ }`;
            }

            shadowAddFields[ shadowKey ] = computed.expr;
            shadowSortSpec[ shadowKey ] = sortSpec[ key ];
            shadowUnsetKeys.push( shadowKey );
        }
        else
        {
            shadowSortSpec[ key ] = sortSpec[ key ];
        }
    }

    return {
        sortIndex,
        sliceLength: follower.sliceLength,
        targetIndex,
        shadowAddFields,
        shadowSortSpec,
        shadowUnsetKeys
    };
}

