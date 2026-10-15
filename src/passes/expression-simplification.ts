import { analyzeExpression } from '../analyzer/expressions.js';
import { analyzeFilter, isFilterRewriteSafe } from '../analyzer/filters.js';
import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { containsValue, hasSingleKey, isEqual, isPlainObject, MAX_ANALYZED_ARRAY_LENGTH } from '../utils.js';
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

function isConstantArray( expr: unknown ): expr is unknown[]
{
    return Array.isArray( expr ) && expr.every(( item ) => extractPrimitiveConstant( item ).valid );
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

function deduplicateBooleanOperands( items: readonly unknown[] ): unknown[]
{
    if( items.length <= 1 || items.length > MAX_ANALYZED_ARRAY_LENGTH )
    {
        return items as unknown[];
    }

    const seen: Record<string, unknown>[] = [];
    const result: unknown[] = [];

    for( const item of items )
    {
        if( isBooleanProducingExpression( item ) && isErrorFreeDeterministicCondition( item ))
        {
            if( containsValue( seen, item ))
            {
                continue;
            }

            seen.push( item );
        }

        result.push( item );
    }

    return result;
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
        let mapped: unknown[] | null = null;

        for( let i = 0; i < expr.length; i++ )
        {
            const item = expr[ i ];
            const next = simplifyExpression( item );

            if( next !== item )
            {
                mapped ??= [ ...expr ];
                mapped[ i ] = next;
            }
        }

        return mapped ?? expr;
    }

    if( !isPlainObject( expr ))
    {
        return expr;
    }

    if( '$literal' in expr )
    {
        return expr;
    }

    let changedObj: Record<string, unknown> | null = null;
    let firstKey: string | undefined;
    let keyCount = 0;

    for( const key in expr )
    {
        if( keyCount === 0 )
        {
            firstKey = key;
        }

        keyCount++;
        const val = expr[ key ];
        const next = simplifyExpression( val );

        if( next !== val )
        {
            changedObj ??= { ...expr };
            changedObj[ key ] = next;
        }
    }

    const simplified = changedObj ?? expr;

    if( keyCount === 1 )
    {
        const op = firstKey!;

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

            const remaining = deduplicateBooleanOperands(
                simplified.$and.filter(( item ) => !isTruthyConstant( item ))
            );

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

            const remaining = deduplicateBooleanOperands(
                simplified.$or.filter(( item ) => !isFalsyConstant( item ))
            );

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
                    isErrorFreeDeterministicCondition( simplified.$cond[ 0 ] )
                    && (
                        ( thenPrim.valid && elsePrim.valid && thenPrim.value === elsePrim.value )
                        || (
                            isErrorFreeDeterministicCondition( simplified.$cond[ 1 ] )
                            && isEqual( simplified.$cond[ 1 ], simplified.$cond[ 2 ] )
                        )
                    )
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
                        isErrorFreeDeterministicCondition( condSpec.if )
                        && (
                            ( thenPrim.valid && elsePrim.valid && thenPrim.value === elsePrim.value )
                            || (
                                isErrorFreeDeterministicCondition( condSpec.then )
                                && isEqual( condSpec.then, condSpec.else )
                            )
                        )
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

            if(
                isErrorFreeDeterministicCondition( args[ 0 ] )
                && args.every(( arg, idx ) => idx === 0 || isEqual( arg, args[ 0 ] ))
            )
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
        else if( op === '$sqrt' )
        {
            const unary = extractUnaryOperand( simplified.$sqrt );

            if( unary.valid && isFiniteNumber( unary.value ) && unary.value >= 0 )
            {
                const raw = Math.sqrt( unary.value );

                return raw === 0 ? 0 : raw;
            }
        }
        else if( op === '$pow' && Array.isArray( simplified.$pow ) && simplified.$pow.length === 2 )
        {
            const [ base, exp ] = simplified.$pow as [ unknown, unknown ];

            if( isFiniteNumber( base ) && isFiniteNumber( exp ))
            {
                const raw = Math.pow( base, exp );

                if( Number.isFinite( raw ))
                {
                    return raw === 0 ? 0 : raw;
                }
            }
        }
        else if( op === '$trunc' || op === '$round' )
        {
            const arg = simplified[ op ];
            const unary = extractUnaryOperand( arg );

            if( unary.valid && isFiniteNumber( unary.value ))
            {
                const raw = op === '$trunc' ? Math.trunc( unary.value ) : Math.round( unary.value );

                return raw === 0 ? 0 : raw;
            }

            if(
                Array.isArray( arg )
                && arg.length === 2
                && isFiniteNumber( arg[ 0 ] )
                && isFiniteNumber( arg[ 1 ] )
                && Number.isSafeInteger( arg[ 1 ] )
                && arg[ 1 ] === 0
            )
            {
                const raw = op === '$trunc' ? Math.trunc( arg[ 0 ] ) : Math.round( arg[ 0 ] );

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
        else if( ( op === '$trim' || op === '$ltrim' || op === '$rtrim' ) && isPlainObject( simplified[ op ] ))
        {
            const trimSpec = simplified[ op ] as Record<string, unknown>;
            const trimKeys = Object.keys( trimSpec );

            if( trimKeys.length === 1 && trimKeys[ 0 ] === 'input' )
            {
                const str = extractStringConstant( trimSpec.input );

                if( str !== null && ASCII_PATTERN.test( str ))
                {
                    const trimmed = op === '$trim'
                        ? str.trim()
                        : ( op === '$ltrim' ? str.trimStart() : str.trimEnd() );

                    return trimmed.startsWith( '$' ) ? { $literal: trimmed } : trimmed;
                }
            }
        }
        else if(
            ( op === '$substrBytes' || op === '$substrCP' )
            && Array.isArray( simplified[ op ] )
            && ( simplified[ op ] as unknown[] ).length === 3
        )
        {
            const [ strExpr, startExpr, countExpr ] = simplified[ op ] as [ unknown, unknown, unknown ];
            const str = extractStringConstant( strExpr );

            if(
                str !== null
                && ASCII_PATTERN.test( str )
                && isFiniteNumber( startExpr )
                && isFiniteNumber( countExpr )
                && Number.isSafeInteger( startExpr )
                && Number.isSafeInteger( countExpr )
                && startExpr >= 0
                && countExpr >= 0
            )
            {
                const sliced = str.slice( startExpr, startExpr + countExpr );

                return sliced.startsWith( '$' ) ? { $literal: sliced } : sliced;
            }
        }
        else if( op === '$concatArrays' && Array.isArray( simplified.$concatArrays ) && simplified.$concatArrays.length >= 1 )
        {
            if( simplified.$concatArrays.every( isConstantArray ))
            {
                return ( simplified.$concatArrays as unknown[][] ).flat( 1 );
            }
        }
        else if( op === '$mergeObjects' && Array.isArray( simplified.$mergeObjects ) && simplified.$mergeObjects.length >= 1 )
        {
            const items = simplified.$mergeObjects;

            if( items.every(( item ): item is Record<string, unknown> => isPlainObject( item ) && Object.keys( item ).every(( k ) => !k.startsWith( '$' ))))
            {
                const merged: Record<string, unknown> = {};
                let canFold = true;

                for( const item of items )
                {
                    for( const [ k, val ] of Object.entries( item ))
                    {
                        if( k in merged )
                        {
                            const summary = analyzeExpression( val );

                            if( !isEqual( merged[ k ], val ) || summary.unknown || summary.determinism !== 'deterministic' )
                            {
                                canFold = false;
                                break;
                            }
                        }
                        else
                        {
                            merged[ k ] = val;
                        }
                    }

                    if( !canFold ){ break }
                }

                if( canFold && Object.keys( merged ).length > 0 )
                {
                    return merged;
                }
            }
        }
        else if( op === '$isArray' )
        {
            const unary = extractUnaryOperand( simplified.$isArray );

            if( unary.valid )
            {
                if( isConstantArray( unary.value ))
                {
                    return true;
                }

                if( extractPrimitiveConstant( unary.value ).valid )
                {
                    return false;
                }
            }
        }
        else if(
            op === '$arrayElemAt'
            && Array.isArray( simplified.$arrayElemAt )
            && simplified.$arrayElemAt.length === 2
        )
        {
            const [ arrExpr, idxExpr ] = simplified.$arrayElemAt as [ unknown, unknown ];

            if(
                isConstantArray( arrExpr )
                && isFiniteNumber( idxExpr )
                && Number.isSafeInteger( idxExpr )
            )
            {
                const resolvedIdx = idxExpr < 0 ? arrExpr.length + idxExpr : idxExpr;

                if( resolvedIdx >= 0 && resolvedIdx < arrExpr.length )
                {
                    return arrExpr[ resolvedIdx ];
                }
            }
        }
        else if( op === '$first' || op === '$last' )
        {
            const unary = extractUnaryOperand( simplified[ op ] );

            if( unary.valid && isConstantArray( unary.value ) && unary.value.length > 0 )
            {
                return op === '$first'
                    ? unary.value[ 0 ]
                    : unary.value[ unary.value.length - 1 ];
            }
        }
        else if( op === '$reverseArray' )
        {
            const unary = extractUnaryOperand( simplified.$reverseArray );

            if( unary.valid && isConstantArray( unary.value ))
            {
                return [ ...unary.value ].reverse();
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

            if( ( op === '$eq' || op === '$ne' ) && typeof left === 'boolean' && typeof right === 'boolean' )
            {
                return op === '$eq' ? left === right : left !== right;
            }
        }
        else if( op === '$size' )
        {
            const sizeArg = (
                Array.isArray( simplified.$size )
                && simplified.$size.length === 1
                && Array.isArray( simplified.$size[ 0 ] )
            )
                ? simplified.$size[ 0 ]
                : simplified.$size;

            if( isConstantArray( sizeArg ))
            {
                return sizeArg.length;
            }

            if( isPlainObject( sizeArg ))
            {
                const inner = sizeArg as Record<string, unknown>;

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
                        return simplifyExpression({ $size: filterSpec.input });
                    }
                }
            }
        }
        else if( op === '$filter' && isPlainObject( simplified.$filter ))
        {
            const filterSpec = simplified.$filter as Record<string, unknown>;

            if(
                isConstantArray( filterSpec.input )
                && 'cond' in filterSpec
                && !( 'limit' in filterSpec && filterSpec.limit !== undefined )
            )
            {
                if( isTruthyConstant( filterSpec.cond ))
                {
                    return [ ...filterSpec.input ];
                }

                if( isFalsyConstant( filterSpec.cond ))
                {
                    return [];
                }
            }

            if( isPlainObject( filterSpec.cond ))
            {
                const condObj = filterSpec.cond as Record<string, unknown>;
                const condItems = Array.isArray( condObj.$and )
                    ? condObj.$and
                    : ( Array.isArray( condObj.$or ) ? condObj.$or : null );

                if( condItems !== null && condItems.length === 1 && Object.keys( condObj ).length === 1 )
                {
                    return {
                        $filter: {
                            ...filterSpec,
                            cond: condItems[ 0 ]
                        }
                    };
                }
            }
        }
        else if( op === '$map' && isPlainObject( simplified.$map ))
        {
            const mapSpec = simplified.$map as Record<string, unknown>;

            if( Array.isArray( mapSpec.input ) && mapSpec.input.length === 0 && 'in' in mapSpec )
            {
                return [];
            }
        }
        else if( op === '$toString' || op === '$toInt' || op === '$toDouble' || op === '$toBool' || op === '$type' )
        {
            const unary = extractUnaryOperand( simplified[ op ] );

            if( unary.valid )
            {
                const prim = extractPrimitiveConstant( unary.value );

                if( prim.valid )
                {
                    if( op === '$toBool' && prim.value !== null )
                    {
                        return Boolean( prim.value );
                    }

                    if( op === '$toString' && prim.value !== null )
                    {
                        const s = String( prim.value );
                        return s.startsWith( '$' ) ? { $literal: s } : s;
                    }

                    if( op === '$toInt' )
                    {
                        if( typeof prim.value === 'number' && Number.isSafeInteger( Math.trunc( prim.value )))
                        {
                            const t = Math.trunc( prim.value );
                            return t === 0 ? 0 : t;
                        }

                        if( typeof prim.value === 'boolean' )
                        {
                            return prim.value ? 1 : 0;
                        }

                        if( typeof prim.value === 'string' && /^-?\d+$/.test( prim.value ))
                        {
                            const parsed = Number( prim.value );
                            if( Number.isSafeInteger( parsed ))
                            {
                                return parsed === 0 ? 0 : parsed;
                            }
                        }
                    }

                    if( op === '$toDouble' )
                    {
                        if( typeof prim.value === 'number' )
                        {
                            return prim.value === 0 ? 0 : prim.value;
                        }

                        if( typeof prim.value === 'boolean' )
                        {
                            return prim.value ? 1 : 0;
                        }
                    }

                    if( op === '$type' )
                    {
                        if( prim.value === null )
                        {
                            return 'null';
                        }

                        if( typeof prim.value === 'boolean' )
                        {
                            return 'bool';
                        }

                        if( typeof prim.value === 'string' )
                        {
                            return 'string';
                        }
                    }
                }
            }
        }
        else if( op === '$split' && Array.isArray( simplified.$split ) && simplified.$split.length === 2 )
        {
            const str = extractStringConstant( simplified.$split[ 0 ] );
            const delim = extractStringConstant( simplified.$split[ 1 ] );

            if( str !== null && delim !== null && delim.length > 0 )
            {
                const parts = str.split( delim );
                if( parts.every(( p ) => !p.startsWith( '$' )))
                {
                    return parts;
                }
            }
        }
        else if(
            ( op === '$indexOfBytes' || op === '$indexOfCP' )
            && Array.isArray( simplified[ op ] )
            && ( simplified[ op ] as unknown[] ).length === 2
        )
        {
            const [ strExpr, subExpr ] = simplified[ op ] as [ unknown, unknown ];
            const str = extractStringConstant( strExpr );
            const sub = extractStringConstant( subExpr );

            if( str !== null && sub !== null && ASCII_PATTERN.test( str ) && ASCII_PATTERN.test( sub ))
            {
                return str.indexOf( sub );
            }
        }
    }

    return simplified;
}

function simplifyMatchFilterExpressions(
    filter: Record<string, unknown>
): Record<string, unknown>
{
    if(
        isFilterRewriteSafe( filter )
        || (
            !( '$expr' in filter )
            && !( '$and' in filter )
            && !( '$or' in filter )
            && !( '$nor' in filter )
        )
    )
    {
        return filter;
    }

    const summary = analyzeFilter( filter );

    if( summary.unknown || summary.malformed )
    {
        return filter;
    }

    if( hasSingleKey( filter ) && '$expr' in filter )
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
            nextFilter[ key ] = ( val as Record<string, unknown>[] ).map(( item ) =>
            {
                const nextItem = simplifyMatchFilterExpressions( item );

                if( nextItem !== item )
                {
                    changed = true;
                }

                return nextItem;
            });
            continue;
        }

        nextFilter[ key ] = val;
    }

    return changed ? nextFilter : filter;
}

function simplifyStage( stage: unknown ): unknown
{
    const entry = getSingleStageEntry( stage );

    if( !entry )
    {
        return stage;
    }

    const [ op, spec ] = entry;

    if( op === '$sortByCount' || op === '$replaceWith' )
    {
        const simplified = simplifyExpression( spec );
        return simplified !== spec ? { [ op ]: simplified } : stage;
    }

    if( !isPlainObject( spec ))
    {
        return stage;
    }

    const specObj = spec as Record<string, unknown>;

    if( op === '$replaceRoot' && 'newRoot' in specObj )
    {
        const simplifiedRoot = simplifyExpression( specObj.newRoot );
        return simplifiedRoot !== specObj.newRoot
            ? { $replaceRoot: { ...specObj, newRoot: simplifiedRoot } }
            : stage;
    }

    if( op === '$bucket' )
    {
        let changed = false;
        const newBucket: Record<string, unknown> = { ...specObj };

        if( 'groupBy' in specObj )
        {
            const simplifiedGroupBy = simplifyExpression( specObj.groupBy );
            if( simplifiedGroupBy !== specObj.groupBy )
            {
                changed = true;
                newBucket.groupBy = simplifiedGroupBy;
            }
        }

        if( isPlainObject( specObj.output ))
        {
            let outputChanged = false;
            const newOutput: Record<string, unknown> = {};

            for( const [ outKey, outVal ] of Object.entries( specObj.output ))
            {
                if( isPlainObject( outVal ))
                {
                    const accKeys = Object.keys( outVal );
                    if( accKeys.length === 1 && GROUP_ACCUMULATORS.has( accKeys[ 0 ]! ))
                    {
                        const accOp = accKeys[ 0 ]!;
                        const accArg = ( outVal as Record<string, unknown> )[ accOp ];
                        const simplifiedArg = simplifyExpression( accArg );

                        if( simplifiedArg !== accArg )
                        {
                            outputChanged = true;
                            newOutput[ outKey ] = { [ accOp ]: simplifiedArg };
                            continue;
                        }
                    }
                }

                newOutput[ outKey ] = outVal;
            }

            if( outputChanged )
            {
                changed = true;
                newBucket.output = newOutput;
            }
        }

        return changed ? { $bucket: newBucket } : stage;
    }

    if( op === '$addFields' || op === '$set' )
    {
        let newSpec: Record<string, unknown> | null = null;

        for( const key in specObj )
        {
            const val = specObj[ key ];
            const simplified = simplifyExpression( val );

            if( simplified !== val )
            {
                newSpec ??= { ...specObj };
                newSpec[ key ] = simplified;
            }
        }

        return newSpec !== null ? { [ op ]: newSpec } : stage;
    }

    if( op === '$project' )
    {
        let newSpec: Record<string, unknown> | null = null;

        for( const key in specObj )
        {
            const val = specObj[ key ];
            if( typeof val === 'number' || typeof val === 'boolean' )
            {
                continue;
            }

            const simplified = simplifyExpression( val );

            if( simplified !== val )
            {
                newSpec ??= { ...specObj };
                newSpec[ key ] = simplified;
            }
        }

        return newSpec !== null ? { [ op ]: newSpec } : stage;
    }

    if( op === '$group' )
    {
        let newSpec: Record<string, unknown> | null = null;

        for( const key in specObj )
        {
            const val = specObj[ key ];
            if( key === '_id' )
            {
                const simplified = val === null ? null : simplifyExpression( val );

                if( simplified !== val )
                {
                    newSpec ??= { ...specObj };
                    newSpec[ key ] = simplified;
                }

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
                        newSpec ??= { ...specObj };
                        newSpec[ key ] = { [ accOp ]: simplifiedArg };
                    }
                }
            }
        }

        return newSpec !== null ? { $group: newSpec } : stage;
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
    readonly stageTypes = [
        '$addFields',
        '$set',
        '$project',
        '$group',
        '$match',
        '$bucket',
        '$sortByCount',
        '$replaceRoot',
        '$replaceWith'
    ] as const;

    execute( pipeline: any[], context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        if( context.strictErrors )
        {
            return pipeline;
        }

        let result: any[] | null = null;

        for( let i = 0; i < pipeline.length; i++ )
        {
            const stage = pipeline[ i ];
            const simplified = simplifyStage( stage );

            if( simplified !== stage )
            {
                result ??= [ ...pipeline ];
                result[ i ] = simplified;
            }
        }

        return result ?? pipeline;
    }
}
