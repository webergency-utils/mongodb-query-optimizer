import { analyzeExpression } from '../analyzer/expressions.js';
import { relatePaths } from '../analyzer/paths.js';
import { analyzeStage } from '../analyzer/semantics.js';
import { GuaranteeContext } from '../guarantees.js';
import { isPlainObject } from '../utils.js';
import { isStageProvenErrorFree } from './guarantee-guards.js';
import { getSingleStageEntry } from './helpers.js';

/**
 * Shared proof machinery for heuristic shadow-field rewrites.
 *
 * A shadow rewrite computes a deterministic `$addFields` expression early under a temporary
 * `__heuristic_<name>` field, uses it (to slice or filter), and unsets it before the original
 * provider recomputes the real field on the surviving documents.
 */

export const SHADOW_FIELD_PREFIX = '__heuristic_';

export interface ShadowComputedKey
{
    readonly key           : string;
    readonly providerIndex : number;
    readonly expr          : unknown;
    readonly dependencies  : ReadonlySet<string>;
}

export interface ShadowProviders
{
    readonly computed : ReadonlyMap<string, ShadowComputedKey>;
    readonly rootKeys : readonly string[];
}

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

function stageTouchesPaths( stage: unknown, paths: Iterable<string> ): boolean
{
    const semantics = analyzeStage( stage );
    const required = [ ...paths ];

    return !arePathsDisjoint( semantics.writes, required )
        || !arePathsDisjoint( semantics.modifies, required )
        || !arePathsDisjoint( semantics.removes, required );
}

/**
 * Best-effort denylist for JavaScript in `$function` bodies whose result can differ between two
 * evaluations of the same arguments: clocks, randomness, identifiers, global or receiver state,
 * dynamic code and timers. This is not a sandbox; see CONSTRAINTS.md.
 */
const NON_DETERMINISTIC_FUNCTION_BODY =
    /\b(Date|crypto|performance|ObjectId|UUID|globalThis|this|eval|Function|setTimeout|setInterval|setImmediate)\b|\bMath\s*(\.\s*random\b|\[)/;

function isAcceptableFunctionSpec( spec: unknown ): boolean
{
    return isPlainObject( spec )
        && spec.lang === 'js'
        && typeof spec.body === 'string'
        && Array.isArray( spec.args )
        && !NON_DETERMINISTIC_FUNCTION_BODY.test( spec.body );
}

/**
 * Visits every `$function` node outside `$literal` subtrees. Returns false as soon as the
 * visitor rejects one.
 */
function everyFunctionCall( value: unknown, visit: ( spec: unknown ) => boolean ): boolean
{
    if( Array.isArray( value ))
    {
        return value.every(( entry ) => everyFunctionCall( entry, visit ));
    }

    if( !isPlainObject( value ) || '$literal' in value )
    {
        return true;
    }

    return Object.entries( value ).every(( [ key, nested ] ) =>
    {
        return key === '$function'
            ? visit( nested ) && everyFunctionCall(( nested as Record<string, unknown> ).args, visit )
            : everyFunctionCall( nested, visit );
    });
}

/**
 * Replaces each `$function` node with the array of its arguments, so the normal expression
 * analyzer sees exactly what the call reads while argument variable scope (`$$this` inside
 * `$map`, `$let` variables) is preserved. `$literal` subtrees are left untouched.
 */
function substituteFunctionCalls( value: unknown ): unknown
{
    if( Array.isArray( value ))
    {
        return value.map( substituteFunctionCalls );
    }

    if( !isPlainObject( value ) || '$literal' in value )
    {
        return value;
    }

    if( '$function' in value )
    {
        const args = isPlainObject( value.$function ) ? value.$function.args : undefined;

        return Array.isArray( args ) ? args.map( substituteFunctionCalls ) : [];
    }

    return Object.fromEntries( Object.entries( value ).map(( [ key, nested ] ) => [ key, substituteFunctionCalls( nested ) ] ));
}

export function isExpressionCompletelyDeterministic( expr: unknown, strictErrors: boolean = false ): boolean
{
    if( /\$\$(NOW|CLUSTER_TIME)\b/.test( String( JSON.stringify( expr ))))
    {
        return false;
    }

    // User code can throw, and substitution would hide that from the error analysis.
    const functionsAcceptable = everyFunctionCall( expr, ( spec ) => !strictErrors && isAcceptableFunctionSpec( spec ));

    if( !functionsAcceptable )
    {
        return false;
    }

    const summary = analyzeExpression( substituteFunctionCalls( expr ));

    if(
        summary.unknown
        || summary.dependencies.unknown
        || summary.dependencies.local.has( '*' )
        || summary.determinism !== 'deterministic'
    )
    {
        return false;
    }

    return !strictErrors || summary.errors === 'none-known';
}

export function collectExpressionDependencies( expr: unknown ): Set<string>
{
    return new Set( analyzeExpression( substituteFunctionCalls( expr )).dependencies.local );
}

/**
 * Resolves, for each key read at `consumerIndex`, either the single `$addFields` / `$set`
 * provider that computes it (a computed key) or confirms that no earlier stage writes,
 * modifies or removes it (a root key). Returns null when any key is not eligible.
 */
export function resolveShadowProviders(
    pipeline      : readonly any[],
    consumerIndex : number,
    keys          : readonly string[],
    context       : GuaranteeContext
): ShadowProviders | null
{
    const computed = new Map<string, ShadowComputedKey>();
    const rootKeys: string[] = [];

    for( const key of keys )
    {
        if( key.startsWith( SHADOW_FIELD_PREFIX ))
        {
            return null;
        }

        let providerIndex = -1;

        for( let i = consumerIndex - 1; i >= 0; i-- )
        {
            if( stageTouchesPaths( pipeline[ i ], [ key ] ))
            {
                providerIndex = i;
                break;
            }
        }

        if( providerIndex < 0 )
        {
            rootKeys.push( key );
            continue;
        }

        const entry = getSingleStageEntry( pipeline[ providerIndex ] );

        if(
            !entry
            || ( entry[ 0 ] !== '$addFields' && entry[ 0 ] !== '$set' )
            || !isPlainObject( entry[ 1 ] )
            || key.includes( '.' )
        )
        {
            return null;
        }

        const spec = entry[ 1 ] as Record<string, unknown>;

        if( !Object.prototype.hasOwnProperty.call( spec, key ))
        {
            return null;
        }

        const expr = spec[ key ];

        if( !isExpressionCompletelyDeterministic( expr, context.strictErrors ))
        {
            return null;
        }

        computed.set( key, {
            key,
            providerIndex,
            expr,
            dependencies : collectExpressionDependencies( expr )
        });
    }

    if( computed.size === 0 )
    {
        return null;
    }

    return { computed, rootKeys };
}

function earliestProviderIndex( providers: ShadowProviders ): number
{
    return Math.min( ...[ ...providers.computed.values() ].map(( computed ) => computed.providerIndex ));
}

/**
 * Scans backward from the earliest provider over stages that preserve order and either
 * preserve cardinality or (when `allowFilters`) only filter, and whose writes miss every
 * path the shadow expressions or root keys read. Returns the earliest such index, or null
 * when the shadow cannot move above the earliest provider.
 */
export function findShadowTargetIndex(
    pipeline     : readonly any[],
    providers    : ShadowProviders,
    context      : GuaranteeContext,
    allowFilters : boolean
): number | null
{
    const requiredPaths = new Set<string>( providers.rootKeys );

    for( const computed of providers.computed.values() )
    {
        for( const dependency of computed.dependencies )
        {
            requiredPaths.add( dependency );
        }
    }

    const minProviderIndex = earliestProviderIndex( providers );
    let targetIndex = minProviderIndex;

    for( let i = minProviderIndex - 1; i >= 0; i-- )
    {
        const stage = pipeline[ i ];
        const semantics = analyzeStage( stage );

        if(
            semantics.unknown
            || semantics.dependencies.unknown
            || semantics.order !== 'preserves'
            || !isRangeCardinality( semantics.cardinality, allowFilters )
            || stageTouchesPaths( stage, requiredPaths )
            || ( context.strictErrors && !isStageProvenErrorFree( stage ))
        )
        {
            break;
        }

        targetIndex = i;
    }

    return targetIndex < minProviderIndex ? targetIndex : null;
}

function isRangeCardinality( cardinality: string, allowFilters: boolean ): boolean
{
    return cardinality === 'preserves' || ( allowFilters && cardinality === 'filters' );
}

/**
 * Validates the whole range `[targetIndex, consumerIndex)` that the shadow rewrite spans:
 *
 * - every stage preserves order, and preserves cardinality (or only filters, when allowed);
 * - under `strictErrors`, every stage is proven error-free, because the rewrite changes which
 *   documents reach those stages;
 * - per-key range rule: for each computed key, no stage in `[targetIndex, providerIndex)`
 *   writes, modifies or removes a path its expression reads. This also rejects a key that
 *   reads another computed key, because that key's provider lies inside the range.
 */
export function validateShadowRange(
    pipeline      : readonly any[],
    targetIndex   : number,
    consumerIndex : number,
    providers     : ShadowProviders,
    context       : GuaranteeContext,
    allowFilters  : boolean
): boolean
{
    for( let i = targetIndex; i < consumerIndex; i++ )
    {
        const semantics = analyzeStage( pipeline[ i ] );

        if( semantics.order !== 'preserves' || !isRangeCardinality( semantics.cardinality, allowFilters ))
        {
            return false;
        }

        if( context.strictErrors && !isStageProvenErrorFree( pipeline[ i ] ))
        {
            return false;
        }
    }

    for( const computed of providers.computed.values() )
    {
        for( let i = targetIndex; i < computed.providerIndex; i++ )
        {
            if( stageTouchesPaths( pipeline[ i ], computed.dependencies ))
            {
                return false;
            }
        }
    }

    return true;
}

const COSTLY_STAGE_OPERATORS = new Set([ '$lookup', '$graphLookup' ]);

function containsFunctionCall( value: unknown ): boolean
{
    if( Array.isArray( value ))
    {
        return value.some( containsFunctionCall );
    }

    if( !isPlainObject( value ))
    {
        return false;
    }

    return Object.entries( value ).some(( [ key, nested ] ) => key === '$function' || containsFunctionCall( nested ));
}

/**
 * Profitability gate: the range `[targetIndex, consumerIndex)` must contain a `$lookup`,
 * a `$graphLookup`, or a stage that calls `$function` outside the shadowed key expressions
 * (a shadowed key is evaluated again by its provider, so slicing early saves nothing on it).
 * Callers run `validateShadowRange` first, so every stage in the range is a known stage.
 */
export function rangeHasCostlyStage(
    pipeline      : readonly any[],
    targetIndex   : number,
    consumerIndex : number,
    providers     : ShadowProviders
): boolean
{
    for( let i = targetIndex; i < consumerIndex; i++ )
    {
        const entry = getSingleStageEntry( pipeline[ i ] )!;

        if( COSTLY_STAGE_OPERATORS.has( entry[ 0 ] ))
        {
            return true;
        }

        const remaining = isPlainObject( entry[ 1 ] )
            ? Object.fromEntries( Object.entries( entry[ 1 ] ).filter(( [ field ] ) => providers.computed.get( field )?.providerIndex !== i ))
            : entry[ 1 ];

        if( containsFunctionCall( remaining ))
        {
            return true;
        }
    }

    return false;
}

function pipelineReferencesKey( pipeline: readonly any[], key: string ): boolean
{
    const keyJson = JSON.stringify( key );

    return pipeline.some(( stage ) => JSON.stringify( stage ).includes( keyJson ));
}

/**
 * Allocates a `__heuristic_<sanitized key>` name that no stage in the pipeline references and
 * that is not already taken, appending a numeric suffix on collision.
 */
export function allocateShadowFieldName(
    pipeline : readonly any[],
    key      : string,
    taken    : ReadonlySet<string>
): string
{
    const base = `${ SHADOW_FIELD_PREFIX }${ key.replace( /[^a-zA-Z0-9_]/g, '_' ) }`;
    let name = base;
    let counter = 0;

    while( pipelineReferencesKey( pipeline, name ) || taken.has( name ))
    {
        name = `${ base }_${ counter++ }`;
    }

    return name;
}
