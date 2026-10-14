import {
    analyzeExpression,
    createDependencies,
    mergeDependencies,
} from './expressions';
import {
    FilterSummary,
    SemanticAnalysisContext,
} from './types';
import {
    joinDeterminism,
    joinErrors,
} from './semantics';
import { isPlainObject, rewriteSafeBsonArrays } from '../utils.js';

const LOGICAL_OPERATORS = new Set(['$and', '$or', '$nor']);

const DOCUMENT_SCOPE_OPERATORS = new Set([
    '$jsonSchema',
    '$text',
    '$where',
]);

const KNOWN_FIELD_OPERATORS = new Set([
    '$all',
    '$bitsAllClear',
    '$bitsAllSet',
    '$bitsAnyClear',
    '$bitsAnySet',
    '$box',
    '$center',
    '$centerSphere',
    '$eq',
    '$exists',
    '$geoIntersects',
    '$geoWithin',
    '$gt',
    '$gte',
    '$in',
    '$lt',
    '$lte',
    '$maxDistance',
    '$minDistance',
    '$mod',
    '$ne',
    '$near',
    '$nearSphere',
    '$nin',
    '$not',
    '$options',
    '$polygon',
    '$regex',
    '$size',
    '$type',
]);

function emptyFilterSummary(): FilterSummary
{
    return {
        dependencies: createDependencies(),
        determinism: 'deterministic',
        errors: 'none-known',
        unknown: false,
        malformed: false,
    };
}

const REWRITE_SAFE_COMPARISON_OPERATORS = new Set([
    '$eq',
    '$gt',
    '$gte',
    '$lt',
    '$lte',
    '$ne',
]);

function isRewriteSafeBsonArray(
    arr         : readonly unknown[],
    ancestors?  : WeakSet<object>
): boolean
{
    if( rewriteSafeBsonArrays.has( arr )){ return true }

    const len = arr.length;

    if( len === 0 ){ return true }

    const first = arr[ 0 ];
    const exoticFirstCtor = (
        first !== null
        && typeof first === 'object'
        && !Array.isArray( first )
        && !isPlainObject( first )
    )
        ? ( first as { constructor: new ( ...args: any[] ) => unknown } ).constructor
        : null;

    for( let i = 0; i < len; i++ )
    {
        const item = arr[ i ];

        if(
            typeof item === 'string'
            || typeof item === 'number'
            || typeof item === 'boolean'
            || item === null
        )
        {
            continue;
        }

        if( exoticFirstCtor !== null && item instanceof exoticFirstCtor )
        {
            continue;
        }

        if( !isRewriteSafeBsonLiteral( item, ancestors ))
        {
            return false;
        }
    }

    rewriteSafeBsonArrays.add( arr );

    return true;
}

function isRewriteSafeBsonLiteral(
    value       : unknown,
    ancestors?  : WeakSet<object>
): boolean
{
    if(
        value === undefined
        || typeof value === 'function'
        || typeof value === 'symbol'
        || typeof value === 'bigint'
    )
    {
        return false;
    }

    if( value === null || typeof value !== 'object' )
    {
        return true;
    }

    if( !isPlainObject( value ) && !Array.isArray( value ))
    {
        return true;
    }

    const activeAncestors = ancestors ?? new WeakSet<object>();

    if( activeAncestors.has( value ))
    {
        return false;
    }

    activeAncestors.add( value );
    const safe = Array.isArray( value )
        ? isRewriteSafeBsonArray( value, activeAncestors )
        : Object.values( value ).every(
            ( item ) => isRewriteSafeBsonLiteral( item, activeAncestors )
        );
    activeAncestors.delete( value );

    return safe;
}

function isRewriteSafeRegexOperand(value: unknown): boolean
{
    return (
        typeof value === 'string'
        || value instanceof RegExp
        || (
            value !== null
            && typeof value === 'object'
            && (value as { _bsontype?: unknown })._bsontype === 'BSONRegExp'
        )
    );
}

function isRewriteSafeTypeOperand(value: unknown): boolean
{
    if (typeof value === 'string' || typeof value === 'number')
    {
        return true;
    }

    return Array.isArray(value)
        && value.length > 0
        && value.every(
            (item) => typeof item === 'string' || typeof item === 'number',
        );
}

function isRewriteSafeElementFilter(
    value: unknown
): boolean
{
    if( !isPlainObject( value ))
    {
        return false;
    }

    const entries = Object.entries( value );
    const operatorEntries = entries.filter(( [ key ] ) => key.startsWith( '$' ));

    if( operatorEntries.length === entries.length && entries.length > 0 )
    {
        return operatorEntries.every(
            ( [ operator, operand ] ) => isRewriteSafeFieldOperator( operator, operand )
        );
    }

    return isFilterRewriteSafe( value );
}

function isRewriteSafeFieldOperator(
    operator: string,
    operand: unknown,
): boolean
{
    if (REWRITE_SAFE_COMPARISON_OPERATORS.has(operator))
    {
        return isRewriteSafeBsonLiteral(operand);
    }

    if (operator === '$in' || operator === '$nin')
    {
        return Array.isArray(operand)
            && isRewriteSafeBsonArray(operand);
    }

    if (operator === '$exists')
    {
        return typeof operand === 'boolean';
    }

    if (operator === '$regex')
    {
        return isRewriteSafeRegexOperand(operand);
    }

    if (operator === '$options')
    {
        return typeof operand === 'string';
    }

    if (operator === '$size')
    {
        return Number.isSafeInteger(operand) && (operand as number) >= 0;
    }

    if (operator === '$mod')
    {
        return (
            Array.isArray(operand)
            && operand.length === 2
            && operand.every((item) => typeof item === 'number')
        );
    }

    if (operator === '$type')
    {
        return isRewriteSafeTypeOperand(operand);
    }

    if (operator === '$not')
    {
        return operand instanceof RegExp
            || (
                isPlainObject(operand)
                && Object.entries(operand).every(
                    ([nestedOperator, nestedOperand]) =>
                        nestedOperator.startsWith('$')
                        && isRewriteSafeFieldOperator(nestedOperator, nestedOperand),
                )
            );
    }

    if( operator === '$elemMatch' )
    {
        return isRewriteSafeElementFilter( operand );
    }

    if( operator === '$all' )
    {
        return Array.isArray( operand ) && operand.every(( item ) =>
        {
            if(
                isPlainObject( item )
                && Object.keys( item ).length === 1
                && '$elemMatch' in item
            )
            {
                return isRewriteSafeElementFilter( item.$elemMatch );
            }

            return isRewriteSafeBsonLiteral( item );
        });
    }

    return false;
}

const rewriteSafeFieldConditionCache = new WeakMap<object, boolean>();

function isRewriteSafePlainFieldCondition(
    condition: Record<string, unknown>
): boolean
{
    const entries = Object.entries( condition );

    if( entries.length === 0 )
    {
        return true;
    }

    const operatorEntries = entries.filter(( [ key ] ) => key.startsWith( '$' ));

    if( operatorEntries.length === 0 )
    {
        return isRewriteSafeBsonLiteral( condition );
    }

    if( operatorEntries.length !== entries.length )
    {
        return false;
    }

    return operatorEntries.every(
        ( [ operator, operand ] ) => isRewriteSafeFieldOperator( operator, operand )
    );
}

function isRewriteSafeFieldCondition( condition: unknown ): boolean
{
    if( !isPlainObject( condition ))
    {
        return isRewriteSafeBsonLiteral( condition );
    }

    const cached = rewriteSafeFieldConditionCache.get( condition );

    if( cached !== undefined )
    {
        return cached;
    }

    const safe = isRewriteSafePlainFieldCondition( condition );
    rewriteSafeFieldConditionCache.set( condition, safe );

    return safe;
}

function isRewriteSafeFilterObject(
    filter: Record<string, unknown>
): boolean
{
    for( const key in filter )
    {
        const value = filter[ key ];

        if( !key.startsWith( '$' ))
        {
            if( !isRewriteSafeFieldCondition( value ))
            {
                return false;
            }

            continue;
        }

        if( key !== '$and' && key !== '$or' )
        {
            return false;
        }

        if(
            !Array.isArray( value )
            || value.length === 0
            || value.some(( branch ) => !isFilterRewriteSafe( branch ))
        )
        {
            return false;
        }
    }

    return true;
}

function mergeFilterSummary(
    target: FilterSummary,
    source: FilterSummary,
): void
{
    mergeDependencies(target.dependencies, source.dependencies);
    target.determinism = joinDeterminism(
        target.determinism,
        source.determinism,
    );
    target.errors = joinErrors(target.errors, source.errors);
    target.unknown ||= source.unknown;
    target.malformed ||= source.malformed;
}

function mergeExpressionInto(
    target: FilterSummary,
    expression: unknown,
    context: SemanticAnalysisContext,
): void
{
    const expressionSummary = analyzeExpression(expression, context);
    mergeDependencies(target.dependencies, expressionSummary.dependencies);
    target.determinism = joinDeterminism(
        target.determinism,
        expressionSummary.determinism,
    );
    target.errors = joinErrors(target.errors, expressionSummary.errors);
    target.unknown ||= expressionSummary.unknown;
}

function markUnknown(
    summary: FilterSummary,
    context: SemanticAnalysisContext,
    malformed: boolean,
): void
{
    summary.dependencies[context.documentScope].add('*');
    summary.dependencies.unknown = true;
    summary.determinism = 'unknown';
    summary.errors = 'unknown';
    summary.unknown = true;
    summary.malformed ||= malformed;
}

function addFieldDependency(
    summary: FilterSummary,
    path: string,
    context: SemanticAnalysisContext,
    elementRelative: boolean,
): void
{
    if (elementRelative)
    {
        summary.dependencies.element.add(path);
    }
    else
    {
        summary.dependencies[context.documentScope].add(path);
    }
}

function analyzeElemMatch(
    operand: unknown,
    context: SemanticAnalysisContext,
): FilterSummary
{
    if (!isPlainObject(operand))
    {
        const summary = emptyFilterSummary();
        markUnknown(summary, context, true);
        return summary;
    }

    return analyzeFilterObject(operand, context, true);
}

function analyzeFieldCondition(
    condition: unknown,
    context: SemanticAnalysisContext,
): FilterSummary
{
    const summary = emptyFilterSummary();
    if (!isPlainObject(condition))
    {
        return summary;
    }

    const entries = Object.entries(condition);
    if (entries.length === 0)
    {
        return summary;
    }

    const operatorEntries = entries.filter(([key]) => key.startsWith('$'));
    if (operatorEntries.length === 0)
    {
        return summary;
    }

    if (operatorEntries.length !== entries.length)
    {
        markUnknown(summary, context, true);
        return summary;
    }

    for (const [operator, operand] of operatorEntries)
    {
        if (operator === '$elemMatch')
        {
            mergeFilterSummary(summary, analyzeElemMatch(operand, context));
            continue;
        }

        if (operator === '$not')
        {
            mergeFilterSummary(
                summary,
                analyzeFieldCondition(operand, context),
            );
            continue;
        }

        if (operator === '$all')
        {
            if (!Array.isArray(operand))
            {
                markUnknown(summary, context, true);
                continue;
            }

            for (const item of operand)
            {
                if (isPlainObject(item) && '$elemMatch' in item)
                {
                    mergeFilterSummary(
                        summary,
                        analyzeElemMatch(item.$elemMatch, context),
                    );
                }
            }
            continue;
        }

        if (!KNOWN_FIELD_OPERATORS.has(operator))
        {
            const exprSummary = analyzeExpression(operand, context);
            mergeDependencies(summary.dependencies, exprSummary.dependencies);
            summary.determinism = joinDeterminism(
                joinDeterminism(summary.determinism, exprSummary.determinism),
                'volatile',
            );
            summary.errors = joinErrors(
                joinErrors(summary.errors, exprSummary.errors),
                'may-error',
            );
            summary.unknown = true;
        }
    }

    return summary;
}

function analyzeLogical(
    operand         : unknown,
    context         : SemanticAnalysisContext,
    elementRelative : boolean
): FilterSummary
{
    const summary = emptyFilterSummary();

    if( !Array.isArray( operand ) || operand.length === 0 )
    {
        markUnknown( summary, context, true );

        return summary;
    }

    for( const branch of operand )
    {
        if( !isPlainObject( branch ))
        {
            markUnknown( summary, context, true );
            continue;
        }

        mergeFilterSummary(
            summary,
            elementRelative
                ? analyzeFilterObject( branch, context, true )
                : analyzeFilter( branch, context )
        );
    }

    return summary;
}

function analyzeFilterObject(
    filter: Record<string, unknown>,
    context: SemanticAnalysisContext,
    elementRelative: boolean,
): FilterSummary
{
    const summary = emptyFilterSummary();

    for (const [key, value] of Object.entries(filter))
    {
        if (!key.startsWith('$'))
        {
            addFieldDependency(summary, key, context, elementRelative);
            mergeFilterSummary(
                summary,
                analyzeFieldCondition(value, context),
            );
            continue;
        }

        if (LOGICAL_OPERATORS.has(key))
        {
            mergeFilterSummary(
                summary,
                analyzeLogical(value, context, elementRelative),
            );
            continue;
        }

        if (key === '$expr')
        {
            mergeExpressionInto(summary, value, context);
            continue;
        }

        if (key === '$comment')
        {
            continue;
        }

        if (DOCUMENT_SCOPE_OPERATORS.has(key))
        {
            summary.dependencies[context.documentScope].add('*');
            summary.dependencies.unknown = true;
            summary.unknown = true;
            summary.errors = joinErrors(summary.errors, 'may-error');
            if (key === '$where')
            {
                summary.determinism = 'unknown';
            }
            continue;
        }

        if (elementRelative && KNOWN_FIELD_OPERATORS.has(key))
        {
            continue;
        }

        const exprSummary = analyzeExpression(value, context);
        mergeDependencies(summary.dependencies, exprSummary.dependencies);
        summary.determinism = joinDeterminism(
            joinDeterminism(summary.determinism, exprSummary.determinism),
            'volatile',
        );
        summary.errors = joinErrors(
            joinErrors(summary.errors, exprSummary.errors),
            'may-error',
        );
        summary.unknown = true;
    }

    return summary;
}

const defaultFilterSummaryCache = new WeakMap<object, FilterSummary>();
const rewriteSafeFilterCache = new WeakMap<object, boolean>();

function isDefaultFilterAnalysisContext(
    context: SemanticAnalysisContext
): boolean
{
    return (
        context.documentScope === 'local'
        && !context.variables?.size
        && context.elementPath === undefined
    );
}

export function analyzeFilter(
    filter  : unknown,
    context : SemanticAnalysisContext = { documentScope: 'local' }
): FilterSummary
{
    if( !isPlainObject( filter ))
    {
        const summary = emptyFilterSummary();
        markUnknown( summary, context, true );

        return summary;
    }

    if( isDefaultFilterAnalysisContext( context ))
    {
        const cached = defaultFilterSummaryCache.get( filter );

        if( cached !== undefined )
        {
            return cached;
        }

        const summary = analyzeFilterObject( filter, context, false );
        defaultFilterSummaryCache.set( filter, summary );

        return summary;
    }

    return analyzeFilterObject( filter, context, false );
}

export function isFilterRewriteSafe( filter: unknown ): boolean
{
    if( !isPlainObject( filter ))
    {
        return false;
    }

    const cached = rewriteSafeFilterCache.get( filter );

    if( cached !== undefined )
    {
        return cached;
    }

    const safe = isRewriteSafeFilterObject( filter );
    rewriteSafeFilterCache.set( filter, safe );

    return safe;
}

export function markFilterRewriteSafe( filter: Record<string, unknown> ): void
{
    rewriteSafeFilterCache.set( filter, true );
}

export function isFilterContradiction( filter: unknown ): boolean
{
    if( !isPlainObject( filter )){ return false }

    for( const key in filter )
    {
        if( !key.startsWith( '$' ))
        {
            const value = ( filter as Record<string, unknown> )[ key ];

            if( isPlainObject( value ) && Array.isArray( value.$in ) && value.$in.length === 0 )
            {
                return true;
            }
        }
    }

    return false;
}
