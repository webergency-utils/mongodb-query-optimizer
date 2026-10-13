import { analyzeExpression } from '../analyzer/expressions.js';
import { analyzeFilter } from '../analyzer/filters.js';
import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { isPlainObject } from '../utils.js';
import { getSingleStageEntry } from './helpers.js';
import { PipelinePass } from './types.js';

const ASCII_PATTERN = /^[\x00-\x7F]*$/;

const GROUP_ACCUMULATORS = new Set([
    '$sum',
    '$avg',
    '$min',
    '$max',
    '$push',
    '$addToSet',
    '$first',
    '$last',
    '$stdDevPop',
    '$stdDevSamp'
]);

const BOOLEAN_PRODUCING_OPERATORS = new Set([
    '$eq',
    '$ne',
    '$gt',
    '$gte',
    '$lt',
    '$lte',
    '$and',
    '$or',
    '$not',
    '$in',
    '$isArray',
    '$isNumber',
    '$regexMatch',
    '$toBool',
    '$allElementsTrue',
    '$anyElementTrue',
    '$setEquals',
    '$setIsSubset'
]);

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

function extractUnaryOperand(
    operand: unknown
): { valid: true; value: unknown } | { valid: false }
{
    if( Array.isArray( operand ))
    {
        return operand.length === 1
            ? { valid: true, value: operand[ 0 ] }
            : { valid: false };
    }

    return { valid: true, value: operand };
}

function extractPrimitiveConstant(
    expr: unknown
): { valid: true; value: string | number | boolean | null } | { valid: false }
{
    if( isFiniteNumber( expr ) || typeof expr === 'boolean' || expr === null )
    {
        return { valid: true, value: expr };
    }

    const str = extractStringConstant( expr );

    if( str !== null )
    {
        return { valid: true, value: str };
    }

    return { valid: false };
}

function isBooleanProducingExpression( expr: unknown ): expr is Record<string, unknown>
{
    if( !isPlainObject( expr ))
    {
        return false;
    }

    const keys = Object.keys( expr );

    return keys.length === 1 && BOOLEAN_PRODUCING_OPERATORS.has( keys[ 0 ]! );
}

function isErrorFreeDeterministicCondition( condExpr: unknown ): boolean
{
    const summary = analyzeExpression( condExpr );

    return (
        !summary.unknown
        && summary.determinism === 'deterministic'
        && summary.errors === 'none-known'
    );
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
        let arrayChanged = false;
        const mapped = expr.map(( item ) =>
        {
            const next = simplifyExpression( item );

            if( next !== item )
            {
                arrayChanged = true;
            }

            return next;
        });

        return arrayChanged ? mapped : expr;
    }

    if( !isPlainObject( expr ))
    {
        return expr;
    }

    if( '$literal' in expr )
    {
        return expr;
    }

    let childChanged = false;
    const simplified: Record<string, unknown> = {};

    for( const [ key, val ] of Object.entries( expr ))
    {
        const next = simplifyExpression( val );

        if( next !== val )
        {
            childChanged = true;
        }

        simplified[ key ] = next;
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

            if( remaining.length === 1 && isBooleanProducingExpression( remaining[ 0 ] ))
            {
                return remaining[ 0 ];
            }

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

            if( remaining.length === 1 && isBooleanProducingExpression( remaining[ 0 ] ))
            {
                return remaining[ 0 ];
            }

            if( remaining.length < simplified.$or.length )
            {
                return { $or: remaining };
            }
        }
        else if( op === '$not' && Array.isArray( simplified.$not ) && simplified.$not.length === 1 )
        {
            const innerOperand = simplified.$not[ 0 ];

            if( isTruthyConstant( innerOperand ))
            {
                return false;
            }

            if( isFalsyConstant( innerOperand ))
            {
                return true;
            }

            if( isPlainObject( innerOperand ))
            {
                const innerKeys = Object.keys( innerOperand );

                if(
                    innerKeys.length === 1
                    && innerKeys[ 0 ] === '$not'
                    && Array.isArray( innerOperand.$not )
                    && innerOperand.$not.length === 1
                    && isBooleanProducingExpression( innerOperand.$not[ 0 ] )
                )
                {
                    return innerOperand.$not[ 0 ];
                }
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

                const thenPrim = extractPrimitiveConstant( simplified.$cond[ 1 ] );
                const elsePrim = extractPrimitiveConstant( simplified.$cond[ 2 ] );

                if(
                    thenPrim.valid
                    && elsePrim.valid
                    && thenPrim.value === elsePrim.value
                    && isErrorFreeDeterministicCondition( simplified.$cond[ 0 ] )
                )
                {
                    return simplified.$cond[ 1 ];
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

                    const thenPrim = extractPrimitiveConstant( condSpec.then );
                    const elsePrim = extractPrimitiveConstant( condSpec.else );

                    if(
                        thenPrim.valid
                        && elsePrim.valid
                        && thenPrim.value === elsePrim.value
                        && isErrorFreeDeterministicCondition( condSpec.if )
                    )
                    {
                        return condSpec.then;
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
        else if(
            ( op === '$divide' || op === '$mod' )
            && Array.isArray( simplified[ op ] )
            && ( simplified[ op ] as unknown[] ).length === 2
        )
        {
            const [ dividend, divisor ] = simplified[ op ] as [ unknown, unknown ];

            if( isFiniteNumber( dividend ) && isFiniteNumber( divisor ) && divisor !== 0 )
            {
                const raw = op === '$divide' ? dividend / divisor : dividend % divisor;

                if( Number.isFinite( raw ))
                {
                    return raw === 0 ? 0 : raw;
                }
            }
        }
        else if( op === '$abs' || op === '$ceil' || op === '$floor' )
        {
            const unary = extractUnaryOperand( simplified[ op ] );

            if( unary.valid && isFiniteNumber( unary.value ))
            {
                const raw = op === '$abs'
                    ? Math.abs( unary.value )
                    : ( op === '$ceil' ? Math.ceil( unary.value ) : Math.floor( unary.value ));

                return raw === 0 ? 0 : raw;
            }
        }
        else if( op === '$toLower' || op === '$toUpper' || op === '$strLenBytes' || op === '$strLenCP' )
        {
            const unary = extractUnaryOperand( simplified[ op ] );

            if( unary.valid )
            {
                const str = extractStringConstant( unary.value );

                if( str !== null )
                {
                    if( op === '$strLenBytes' )
                    {
                        return Buffer.byteLength( str, 'utf8' );
                    }

                    if( op === '$strLenCP' )
                    {
                        return Array.from( str ).length;
                    }

                    if( ASCII_PATTERN.test( str ))
                    {
                        const converted = op === '$toLower' ? str.toLowerCase() : str.toUpperCase();

                        return converted.startsWith( '$' ) ? { $literal: converted } : converted;
                    }
                }
            }
        }
        else if(
            op === '$in'
            && Array.isArray( simplified.$in )
            && simplified.$in.length === 2
            && Array.isArray( simplified.$in[ 1 ] )
        )
        {
            const target = extractPrimitiveConstant( simplified.$in[ 0 ] );
            const candidates = ( simplified.$in[ 1 ] as unknown[] ).map( extractPrimitiveConstant );

            if(
                target.valid
                && candidates.every(
                    ( c ): c is { valid: true; value: string | number | boolean | null } => c.valid
                )
            )
            {
                return candidates.some(( c ) => c.value === target.value );
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

    return childChanged ? simplified : expr;
}

function simplifyMatchFilterExpressions(
    filter: Record<string, unknown>
): Record<string, unknown>
{
    const summary = analyzeFilter( filter );

    if( summary.unknown || summary.malformed )
    {
        return filter;
    }

    const keys = Object.keys( filter );

    if( keys.length === 1 && keys[ 0 ] === '$expr' )
    {
        const simplifiedExpr = simplifyExpression( filter.$expr );

        if( isTruthyConstant( simplifiedExpr ))
        {
            return {};
        }

        if( isFalsyConstant( simplifiedExpr ))
        {
            return { _id: { $in: [] } };
        }

        if( simplifiedExpr !== filter.$expr )
        {
            return { $expr: simplifiedExpr };
        }

        return filter;
    }

    let changed = false;
    const nextFilter: Record<string, unknown> = {};

    for( const [ key, val ] of Object.entries( filter ))
    {
        if( key === '$expr' )
        {
            const simplifiedExpr = simplifyExpression( val );

            if( isFalsyConstant( simplifiedExpr ))
            {
                return { _id: { $in: [] } };
            }

            if( isTruthyConstant( simplifiedExpr ))
            {
                changed = true;
                continue;
            }

            if( simplifiedExpr !== val )
            {
                changed = true;
            }

            nextFilter[ key ] = simplifiedExpr;
            continue;
        }

        if(
            ( key === '$and' || key === '$or' || key === '$nor' )
            && Array.isArray( val )
        )
        {
            let branchChanged = false;
            const mapped = ( val as Record<string, unknown>[] ).map(( item ) =>
            {
                const nextItem = simplifyMatchFilterExpressions( item );

                if( nextItem !== item )
                {
                    branchChanged = true;
                }

                return nextItem;
            });

            if( branchChanged )
            {
                changed = true;
                nextFilter[ key ] = mapped;
                continue;
            }
        }

        nextFilter[ key ] = val;
    }

    return changed ? nextFilter : filter;
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

    if( op === '$group' )
    {
        let changed = false;
        const newSpec: Record<string, unknown> = {};

        for( const [ key, val ] of Object.entries( specObj ))
        {
            if( key === '_id' )
            {
                const simplified = val === null ? null : simplifyExpression( val );

                if( simplified !== val )
                {
                    changed = true;
                }

                newSpec[ key ] = simplified;
                continue;
            }

            if( isPlainObject( val ))
            {
                const accKeys = Object.keys( val );

                if( accKeys.length === 1 && GROUP_ACCUMULATORS.has( accKeys[ 0 ]! ))
                {
                    const accOp = accKeys[ 0 ]!;
                    const accArg = ( val as Record<string, unknown> )[ accOp ];
                    const simplifiedArg = simplifyExpression( accArg );

                    if( simplifiedArg !== accArg )
                    {
                        changed = true;
                        newSpec[ key ] = { [ accOp ]: simplifiedArg };
                        continue;
                    }
                }
            }

            newSpec[ key ] = val;
        }

        return changed ? { $group: newSpec } : stage;
    }

    if( op === '$match' )
    {
        const simplifiedMatch = simplifyMatchFilterExpressions( specObj );

        return simplifiedMatch !== specObj ? { $match: simplifiedMatch } : stage;
    }

    return stage;
}

export class ExpressionSimplificationPass implements PipelinePass
{
    readonly name       = 'expression-simplification';
    readonly stageTypes = [ '$addFields', '$set', '$project', '$group', '$match' ] as const;

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
