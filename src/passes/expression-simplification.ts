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

export function isFalsyConstant( expr: unknown ): boolean
{
    if( expr === false || expr === 0 || expr === null )
    {
        return true;
    }

    if( isPlainObject( expr ))
    {
        const keys = Object.keys( expr );

        if( keys.length === 1 && keys[ 0 ] === '$literal' )
        {
            const lit = ( expr as Record<string, unknown> ).$literal;

            return lit === false || lit === 0 || lit === null;
        }
    }

    return false;
}

export function isNonNullConstant( expr: unknown ): boolean
{
    if( isTruthyConstant( expr ))
    {
        return true;
    }

    return expr === false
        || expr === 0
        || (
            isPlainObject( expr )
            && Object.keys( expr ).length === 1
            && '$literal' in expr
            && ( expr.$literal === false || expr.$literal === 0 )
        );
}

export function extractStringConstant( expr: unknown ): string | null
{
    if( typeof expr === 'string' && !expr.startsWith( '$' ))
    {
        return expr;
    }

    if(
        isPlainObject( expr )
        && Object.keys( expr ).length === 1
        && '$literal' in expr
        && typeof expr.$literal === 'string'
    )
    {
        return expr.$literal;
    }

    return null;
}

function isFiniteNumber( val: unknown ): val is number
{
    return typeof val === 'number' && Number.isFinite( val );
}

function evaluateConstantComparison(
    op    : string,
    left  : number | string,
    right : number | string
): boolean | number
{
    switch( op )
    {
        case '$eq':
            return left === right;
        case '$ne':
            return left !== right;
        case '$gt':
            return left > right;
        case '$gte':
            return left >= right;
        case '$lt':
            return left < right;
        case '$lte':
            return left <= right;
        default:
            return left < right ? -1 : ( left > right ? 1 : 0 );
    }
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

        if( op === '$and' && Array.isArray( simplified.$and ) && simplified.$and.length >= 1 )
        {
            if( simplified.$and.some( isFalsyConstant ))
            {
                return false;
            }

            if( simplified.$and.every( isTruthyConstant ))
            {
                return true;
            }

            const remaining = simplified.$and.filter(( item ) => !isTruthyConstant( item ));

            if( remaining.length < simplified.$and.length )
            {
                return { $and: remaining };
            }
        }
        else if( op === '$or' && Array.isArray( simplified.$or ) && simplified.$or.length >= 1 )
        {
            if( simplified.$or.some( isTruthyConstant ))
            {
                return true;
            }

            if( simplified.$or.every( isFalsyConstant ))
            {
                return false;
            }

            const remaining = simplified.$or.filter(( item ) => !isFalsyConstant( item ));

            if( remaining.length < simplified.$or.length )
            {
                return { $or: remaining };
            }
        }
        else if( op === '$not' && Array.isArray( simplified.$not ) && simplified.$not.length === 1 )
        {
            if( isTruthyConstant( simplified.$not[ 0 ] ))
            {
                return false;
            }

            if( isFalsyConstant( simplified.$not[ 0 ] ))
            {
                return true;
            }
        }
        else if( op === '$cond' )
        {
            if( Array.isArray( simplified.$cond ) && simplified.$cond.length === 3 )
            {
                if( isTruthyConstant( simplified.$cond[ 0 ] ))
                {
                    return simplified.$cond[ 1 ];
                }

                if( isFalsyConstant( simplified.$cond[ 0 ] ))
                {
                    return simplified.$cond[ 2 ];
                }
            }
            else if( isPlainObject( simplified.$cond ))
            {
                const condSpec = simplified.$cond as Record<string, unknown>;

                if(
                    Object.keys( condSpec ).length === 3
                    && 'if' in condSpec
                    && 'then' in condSpec
                    && 'else' in condSpec
                )
                {
                    if( isTruthyConstant( condSpec.if ))
                    {
                        return condSpec.then;
                    }

                    if( isFalsyConstant( condSpec.if ))
                    {
                        return condSpec.else;
                    }
                }
            }
        }
        else if( op === '$switch' && isPlainObject( simplified.$switch ))
        {
            const switchSpec = simplified.$switch as Record<string, unknown>;
            const switchKeys = Object.keys( switchSpec );

            if(
                Array.isArray( switchSpec.branches )
                && switchSpec.branches.length >= 1
                && switchKeys.every(( k ) => k === 'branches' || k === 'default' )
                && switchSpec.branches.every(
                    ( b ): b is Record<string, unknown> =>
                        isPlainObject( b )
                        && Object.keys( b ).length === 2
                        && 'case' in b
                        && 'then' in b
                )
            )
            {
                const liveBranches = switchSpec.branches.filter(
                    ( b ) => !isFalsyConstant( b.case )
                );

                if( liveBranches.length > 0 && isTruthyConstant( liveBranches[ 0 ]!.case ))
                {
                    return liveBranches[ 0 ]!.then;
                }

                if( liveBranches.length === 0 && 'default' in switchSpec )
                {
                    return switchSpec.default;
                }

                if( liveBranches.length > 0 && liveBranches.length < switchSpec.branches.length )
                {
                    return {
                        $switch: {
                            ...switchSpec,
                            branches: liveBranches
                        }
                    };
                }
            }
        }
        else if( op === '$ifNull' && Array.isArray( simplified.$ifNull ) && simplified.$ifNull.length >= 2 )
        {
            const args = simplified.$ifNull.filter(
                ( item, idx, arr ) => idx >= arr.length - 2 || item !== null
            );

            if( isNonNullConstant( args[ 0 ] ))
            {
                return args[ 0 ];
            }

            if( args.length < simplified.$ifNull.length )
            {
                return { $ifNull: args };
            }
        }
        else if( op === '$add' && Array.isArray( simplified.$add ) && simplified.$add.length >= 1 )
        {
            if( simplified.$add.every( isFiniteNumber ))
            {
                return simplified.$add.reduce(( acc, val ) => acc + val, 0 );
            }
        }
        else if( op === '$multiply' && Array.isArray( simplified.$multiply ) && simplified.$multiply.length >= 1 )
        {
            if( simplified.$multiply.every( isFiniteNumber ))
            {
                return simplified.$multiply.reduce(( acc, val ) => acc * val, 1 );
            }
        }
        else if( op === '$subtract' && Array.isArray( simplified.$subtract ) && simplified.$subtract.length === 2 )
        {
            if( isFiniteNumber( simplified.$subtract[ 0 ] ) && isFiniteNumber( simplified.$subtract[ 1 ] ))
            {
                return simplified.$subtract[ 0 ] - simplified.$subtract[ 1 ];
            }
        }
        else if( op === '$concat' && Array.isArray( simplified.$concat ) && simplified.$concat.length >= 1 )
        {
            const parts = simplified.$concat.map( extractStringConstant );

            if( parts.every(( p ): p is string => p !== null ))
            {
                const joined = parts.join( '' );

                return joined.startsWith( '$' ) ? { $literal: joined } : joined;
            }
        }
        else if(
            (
                op === '$eq'
                || op === '$ne'
                || op === '$gt'
                || op === '$gte'
                || op === '$lt'
                || op === '$lte'
                || op === '$cmp'
            )
            && Array.isArray( simplified[ op ] )
            && ( simplified[ op ] as unknown[] ).length === 2
        )
        {
            const [ left, right ] = simplified[ op ] as [ unknown, unknown ];
            const leftStr = extractStringConstant( left );
            const rightStr = extractStringConstant( right );

            if( isFiniteNumber( left ) && isFiniteNumber( right ))
            {
                return evaluateConstantComparison( op, left, right );
            }

            if( leftStr !== null && rightStr !== null )
            {
                return evaluateConstantComparison( op, leftStr, rightStr );
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
