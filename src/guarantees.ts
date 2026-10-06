/**
 * Caller-facing guarantee options accepted by `optimizePipeline` and `optimizeFilter`.
 *
 * By default the optimizer only guarantees that a query which succeeds keeps returning
 * the same documents. Field order inside documents may change, and a query that fails
 * may fail differently or succeed. Each flag tightens one of those relaxations.
 */
export interface OptimizerOptions
{
    /** Keep the exact field order of every output document. Ignored by `optimizeFilter`. */
    readonly strictFieldOrder?  : boolean
    /** The optimized query fails exactly when the original query fails. */
    readonly strictErrors?      : boolean
}

/**
 * Resolved guarantees that every pass, guard and filter rule reads.
 */
export interface GuaranteeContext
{
    readonly strictFieldOrder   : boolean
    readonly strictErrors       : boolean
}

const WRITE_STAGES: ReadonlySet<string> = new Set([ '$out', '$merge' ]);

export const DEFAULT_GUARANTEE_CONTEXT: GuaranteeContext = Object.freeze(
{
    strictFieldOrder    : false,
    strictErrors        : false
});

function isPlainStage( stage: unknown ): stage is Record<string, unknown>
{
    return Boolean( stage ) && typeof stage === 'object' && !Array.isArray( stage );
}

/**
 * True when a top-level stage writes documents. Only the top level is inspected,
 * because MongoDB rejects `$out` and `$merge` inside sub-pipelines.
 */
export function hasWriteStage( pipeline: unknown ): boolean
{
    if( !Array.isArray( pipeline )){ return false }

    return pipeline.some(( stage ) => isPlainStage( stage ) && Object.keys( stage ).some(( key ) => WRITE_STAGES.has( key )));
}

function createContext( strictFieldOrder: boolean, strictErrors: boolean ): GuaranteeContext
{
    if( !strictFieldOrder && !strictErrors ){ return DEFAULT_GUARANTEE_CONTEXT }

    return Object.freeze({ strictFieldOrder, strictErrors });
}

/**
 * Resolves caller options for a pipeline. A pipeline that writes through `$out` or
 * `$merge` is always strict about errors, whatever the caller passes.
 */
export function resolvePipelineGuarantees( pipeline: unknown, options?: OptimizerOptions ): GuaranteeContext
{
    return createContext(
        options?.strictFieldOrder === true,
        options?.strictErrors === true || hasWriteStage( pipeline )
    );
}

/**
 * Resolves caller options for a standalone filter. A filter produces no output
 * documents, so `strictFieldOrder` is accepted and ignored.
 */
export function resolveFilterGuarantees( options?: OptimizerOptions ): GuaranteeContext
{
    return createContext( false, options?.strictErrors === true );
}
