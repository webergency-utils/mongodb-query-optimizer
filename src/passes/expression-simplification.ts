import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { isPlainObject } from '../utils.js';
import { getSingleStageEntry } from './helpers.js';
import { PipelinePass } from './types.js';

/**
 * Expression simplification pass (KTD9).
 *
 * Folds always-true logical conditions ($and, $or) and simplifies `$size` over `$filter`
 * when `cond` is truthy and no `limit` is present:
 *
 *     { $size: { $filter: { input: E, cond: true, ... } } } -> { $size: E }
 *
 * Skipped under `strictErrors` because `$size` and `$size{$filter}` produce different
 * error codes on scalar inputs (17124 vs 28651).
 */

export function isTruthyConstant( expr: unknown ): boolean
{
    if( expr === true )
    {
        return true;
    }

    if( typeof expr === 'number' )
    {
        return !Number.isNaN( expr ) && expr !== 0;
    }

    if( typeof expr === 'string' )
    {
        return !expr.startsWith( '$' );
    }

    if( isPlainObject( expr ))
    {
        const keys = Object.keys( expr );

        if( keys.length === 0 )
        {
            return true;
        }

        if( keys.length === 1 && keys[ 0 ] === '$literal' )
        {
            const lit = ( expr as Record<string, unknown> ).$literal;

            if( lit === true )
            {
                return true;
            }

            if( typeof lit === 'number' )
            {
                return !Number.isNaN( lit ) && lit !== 0;
            }

            if( typeof lit === 'string' )
            {
                return true;
            }

            if( isPlainObject( lit ) && Object.keys( lit ).length === 0 )
            {
                return true;
            }
        }
    }

    return false;
}

export function simplifyExpression( expr: unknown ): unknown
{
    if( Array.isArray( expr ))
    {
        return expr.map( simplifyExpression );
    }

    if( !isPlainObject( expr ))
    {
        return expr;
    }

    if( '$literal' in expr )
    {
        return expr;
    }

    const simplified: Record<string, unknown> = {};

    for( const [ key, val ] of Object.entries( expr ))
    {
        simplified[ key ] = simplifyExpression( val );
    }

    const keys = Object.keys( simplified );

    if( keys.length === 1 )
    {
        const op = keys[ 0 ]!;

        if( op === '$and' && Array.isArray( simplified.$and ))
        {
            if( simplified.$and.length >= 1 && simplified.$and.every( isTruthyConstant ))
            {
                return true;
            }
        }
        else if( op === '$or' && Array.isArray( simplified.$or ))
        {
            if( simplified.$or.length >= 1 && simplified.$or.every( isTruthyConstant ))
            {
                return true;
            }
        }
        else if( op === '$size' && isPlainObject( simplified.$size ))
        {
            const inner = simplified.$size as Record<string, unknown>;

            if( Object.keys( inner ).length === 1 && '$filter' in inner && isPlainObject( inner.$filter ))
            {
                const filterSpec = inner.$filter as Record<string, unknown>;

                if(
                    'cond' in filterSpec
                    && isTruthyConstant( filterSpec.cond )
                    && !( 'limit' in filterSpec && filterSpec.limit !== undefined )
                    && 'input' in filterSpec
                )
                {
                    return { $size: filterSpec.input };
                }
            }
        }
    }

    return simplified;
}

function simplifyStage( stage: unknown ): unknown
{
    const entry = getSingleStageEntry( stage );

    if( !entry || !isPlainObject( entry[ 1 ] ))
    {
        return stage;
    }

    const [ op, spec ] = entry;
    const specObj = spec as Record<string, unknown>;

    if( op === '$addFields' || op === '$set' )
    {
        let changed = false;
        const newSpec: Record<string, unknown> = {};

        for( const [ key, val ] of Object.entries( specObj ))
        {
            const simplified = simplifyExpression( val );

            if( simplified !== val )
            {
                changed = true;
            }

            newSpec[ key ] = simplified;
        }

        return changed ? { [ op ]: newSpec } : stage;
    }

    if( op === '$project' )
    {
        let changed = false;
        const newSpec: Record<string, unknown> = {};

        for( const [ key, val ] of Object.entries( specObj ))
        {
            if( typeof val === 'number' || typeof val === 'boolean' )
            {
                newSpec[ key ] = val;
                continue;
            }

            const simplified = simplifyExpression( val );

            if( simplified !== val )
            {
                changed = true;
            }

            newSpec[ key ] = simplified;
        }

        return changed ? { [ op ]: newSpec } : stage;
    }

    return stage;
}

export class ExpressionSimplificationPass implements PipelinePass
{
    readonly name       = 'expression-simplification';
    readonly stageTypes = [ '$addFields', '$set', '$project' ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        if( context.strictErrors )
        {
            return pipeline;
        }

        let changed = false;
        const result = pipeline.map(( stage ) =>
        {
            const simplified = simplifyStage( stage );

            if( simplified !== stage )
            {
                changed = true;
            }

            return simplified;
        });

        return changed ? result : pipeline;
    }
}
