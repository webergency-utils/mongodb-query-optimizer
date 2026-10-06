import { analyzeStage } from '../analyzer/semantics.js';
import { GuaranteeContext } from '../guarantees.js';
import { isPlainObject } from '../utils.js';
import { getSingleStageEntry } from './helpers.js';

/**
 * Returns true only when the stage and all of its child sub-pipelines
 * are proven not to error on any input document.
 */
export function isStageProvenErrorFree( stage: unknown ): boolean
{
    if( !stage || typeof stage !== 'object' || Array.isArray( stage ))
    {
        return false;
    }

    const semantics = analyzeStage( stage );

    if( semantics.malformed || semantics.unknown || semantics.observable.unknown )
    {
        return false;
    }

    return semantics.observable.errors === 'none-known';
}

/**
 * Returns true if the stage adds new fields to existing documents.
 * Covers $addFields, $set, $lookup, and $unwind with includeArrayIndex.
 */
export function stageAddsFields( stage: unknown ): boolean
{
    const entry = getSingleStageEntry( stage );

    if( !entry ){ return false }

    const [ operator, value ] = entry;

    if( operator === '$addFields' || operator === '$set' )
    {
        return isPlainObject( value ) && Object.keys( value ).length > 0;
    }

    if( operator === '$lookup' )
    {
        return true;
    }

    if( operator === '$unwind' )
    {
        return isPlainObject( value )
            && typeof value.includeArrayIndex === 'string'
            && value.includeArrayIndex.length > 0;
    }

    return false;
}

/**
 * Returns true if the stage can eliminate/filter rows.
 */
export function stageCanFilterRows( stage: unknown ): boolean
{
    if( !stage || typeof stage !== 'object' || Array.isArray( stage ))
    {
        return true;
    }

    const semantics = analyzeStage( stage );

    if( semantics.malformed || semantics.unknown )
    {
        return true;
    }

    return semantics.cardinality === 'filters'
        || semantics.cardinality === 'filters-and-expands'
        || semantics.cardinality === 'collapses';
}

/**
 * Returns true if the stage can expand the number of rows.
 */
export function stageCanExpandRows( stage: unknown ): boolean
{
    if( !stage || typeof stage !== 'object' || Array.isArray( stage ))
    {
        return true;
    }

    const semantics = analyzeStage( stage );

    if( semantics.malformed || semantics.unknown )
    {
        return true;
    }

    return semantics.cardinality === 'expands'
        || semantics.cardinality === 'filters-and-expands';
}

function expressionReadsFieldOrder( expr: unknown ): boolean
{
    if( !expr || typeof expr !== 'object' ){ return false }

    if( Array.isArray( expr ))
    {
        for( const item of expr )
        {
            if( expressionReadsFieldOrder( item )){ return true }
        }

        return false;
    }

    const obj = expr as Record<string, unknown>;

    for( const [ key, value ] of Object.entries( obj ))
    {
        if( key === '$objectToArray' ){ return true }

        if( expressionReadsFieldOrder( value )){ return true }
    }

    return false;
}

function filterReadsFieldOrder( filter: unknown ): boolean
{
    if( !filter || typeof filter !== 'object' ){ return false }

    if( Array.isArray( filter ))
    {
        for( const item of filter )
        {
            if( filterReadsFieldOrder( item )){ return true }
        }

        return false;
    }

    const obj = filter as Record<string, unknown>;

    for( const [ key, value ] of Object.entries( obj ))
    {
        if( key === '$expr' )
        {
            if( expressionReadsFieldOrder( value )){ return true }

            continue;
        }

        if( key === '$objectToArray' ){ return true }

        if( !key.startsWith( '$' ) && isPlainObject( value ))
        {
            const subKeys = Object.keys( value );
            const hasOp = subKeys.some(( k ) => k.startsWith( '$' ));

            if( !hasOp && subKeys.length >= 2 )
            {
                return true;
            }
        }

        if( filterReadsFieldOrder( value )){ return true }
    }

    return false;
}

/**
 * Returns true if this stage reads or depends on the key order of documents.
 */
export function stageReadsFieldOrder( stage: unknown ): boolean
{
    const entry = getSingleStageEntry( stage );

    if( !entry ){ return false }

    const [ operator, value ] = entry;

    if( operator === '$match' )
    {
        return filterReadsFieldOrder( value );
    }

    if( operator === '$group' && isPlainObject( value ))
    {
        if( value._id === '$$ROOT' || value._id === '$$CURRENT' )
        {
            return true;
        }
    }

    if( operator === '$sort' && isPlainObject( value ))
    {
        if( '$$ROOT' in value || '$$CURRENT' in value )
        {
            return true;
        }
    }

    if( operator === '$lookup' && isPlainObject( value ) && Array.isArray( value.pipeline ))
    {
        if( pipelineReadsFieldOrder( value.pipeline )){ return true }
    }

    if( operator === '$facet' && isPlainObject( value ))
    {
        for( const subpipeline of Object.values( value ))
        {
            if( Array.isArray( subpipeline ) && pipelineReadsFieldOrder( subpipeline ))
            {
                return true;
            }
        }
    }

    if( operator === '$unionWith' && isPlainObject( value ) && Array.isArray( value.pipeline ))
    {
        if( pipelineReadsFieldOrder( value.pipeline )){ return true }
    }

    return expressionReadsFieldOrder( value );
}

/**
 * Returns true if any stage in the pipeline (or its sub-pipelines) reads field order.
 */
export function pipelineReadsFieldOrder( pipeline: readonly unknown[] ): boolean
{
    if( !Array.isArray( pipeline )){ return false }

    for( const stage of pipeline )
    {
        if( stageReadsFieldOrder( stage )){ return true }
    }

    return false;
}

/**
 * Determines whether moving `movingStage` across `acrossStage` in the given direction
 * is permissible under the active guarantee context and downstream pipeline.
 */
export function canMoveStageAcrossStage(
    movingStage        : unknown,
    acrossStage        : unknown,
    direction          : 'earlier' | 'later',
    context            : GuaranteeContext,
    downstreamPipeline : readonly unknown[] = []
): boolean
{
    if( context.strictErrors )
    {
        if( !isStageProvenErrorFree( movingStage ) || !isStageProvenErrorFree( acrossStage ))
        {
            return false;
        }
    }

    if( direction === 'earlier' )
    {
        if( !isStageProvenErrorFree( movingStage ) && stageCanFilterRows( acrossStage ))
        {
            return false;
        }
    }
    else
    {
        if( !isStageProvenErrorFree( movingStage ) && stageCanExpandRows( acrossStage ))
        {
            return false;
        }
    }

    if( stageAddsFields( movingStage ) && stageAddsFields( acrossStage ))
    {
        if( context.strictFieldOrder ){ return false }

        if( pipelineReadsFieldOrder( downstreamPipeline )){ return false }
    }

    return true;
}

/**
 * Determines whether removing or deferring a stage is allowed under the context.
 */
export function canRemoveStage( stage: unknown, context: GuaranteeContext ): boolean
{
    if( context.strictErrors && !isStageProvenErrorFree( stage ))
    {
        return false;
    }

    return true;
}

/**
 * Determines whether splitting a field-adding stage across `acrossStage`
 * is permissible under the active guarantee context.
 */
export function canSplitFieldAddingStage(
    acrossStage        : unknown,
    context            : GuaranteeContext,
    downstreamPipeline : readonly unknown[] = []
): boolean
{
    if( !stageAddsFields( acrossStage )){ return true }

    if( context.strictFieldOrder ){ return false }

    if( pipelineReadsFieldOrder( downstreamPipeline )){ return false }

    return true;
}
