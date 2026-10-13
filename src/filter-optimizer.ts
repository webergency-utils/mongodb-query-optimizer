import {
    FilterRule,
    getActiveFilterRules,
    withCandidateFilterRuleProfile,
} from './filter-rule-registry';
import { isFilterRewriteSafe } from './analyzer/filters';
import
{
    GuaranteeContext,
    OptimizerOptions,
    resolveFilterGuarantees
}
from './guarantees';
import {
    isPlainObject,
    isOperatorSubdocument,
    structuralFingerprint,
} from './utils';

const DEFAULT_FILTER_SWEEP_BUDGET = 32;

function optimizeOperatorChildren(
    operatorDocument: Record<string, any>,
    rules: readonly FilterRule[],
    context: GuaranteeContext,
): Record<string, any>
{
    let result = operatorDocument;

    for (const [operator, value] of Object.entries(operatorDocument))
    {
        if (operator !== '$not' && operator !== '$elemMatch')
        {
            continue;
        }

        const optimized = applyFilterSweep(value, rules, context);
        if (optimized !== value)
        {
            if (result === operatorDocument)
            {
                result = { ...operatorDocument };
            }

            result[operator] = optimized;
        }
    }

    return result;
}

function deduplicateOperatorArray( items: readonly any[] ): any[] | null
{
    const seen = new Set<string>();
    const unique: any[] = [];

    for( const item of items )
    {
        const fp = structuralFingerprint( item );

        if( !seen.has( fp ))
        {
            seen.add( fp );
            unique.push( item );
        }
    }

    return unique.length < items.length ? unique : null;
}

function extractComparableBound( val: unknown, isDateMode: boolean ): number | undefined
{
    if( isDateMode )
    {
        return val instanceof Date && !Number.isNaN( val.getTime() )
            ? val.getTime()
            : undefined;
    }

    return typeof val === 'number' && Number.isFinite( val )
        ? val
        : undefined;
}

function isRegexLike( val: unknown ): boolean
{
    return val instanceof RegExp
        || Boolean( val && typeof val === 'object' && ( val as any )._bsontype === 'BSONRegExp' );
}

function simplifyFieldIntervals(
    inputDocument: Record<string, any>
): Record<string, any>
{
    let operatorDocument = inputDocument;

    if( isPlainObject( operatorDocument.$not ))
    {
        const notEntries = Object.entries( operatorDocument.$not );

        if( notEntries.length === 1 )
        {
            const [ innerOp, innerVal ] = notEntries[ 0 ]!;
            const flippedOp = innerOp === '$in'
                ? '$nin'
                : innerOp === '$nin'
                    ? '$in'
                    : innerOp === '$eq'
                        ? '$ne'
                        : innerOp === '$ne'
                            ? '$eq'
                            : null;

            if( flippedOp !== null && !( flippedOp in operatorDocument ))
            {
                const { $not: _removedNot, ...restOps } = operatorDocument;

                operatorDocument = {
                    ...restOps,
                    [ flippedOp ]: innerVal
                };
            }
        }
    }

    if( Array.isArray( operatorDocument.$nin ) && operatorDocument.$nin.length >= 2 )
    {
        const dedupedNin = deduplicateOperatorArray( operatorDocument.$nin );

        if( dedupedNin )
        {
            operatorDocument = { ...operatorDocument, $nin: dedupedNin };
        }
    }

    const forbidden = new Set<string>();

    if( Array.isArray( operatorDocument.$nin ))
    {
        for( const item of operatorDocument.$nin )
        {
            if( !isRegexLike( item ))
            {
                forbidden.add( structuralFingerprint( item ));
            }
        }
    }

    if( '$ne' in operatorDocument && !isRegexLike( operatorDocument.$ne ))
    {
        forbidden.add( structuralFingerprint( operatorDocument.$ne ));
    }

    if( forbidden.size > 0 )
    {
        if(
            '$eq' in operatorDocument
            && !isRegexLike( operatorDocument.$eq )
            && forbidden.has( structuralFingerprint( operatorDocument.$eq ))
        )
        {
            return { $in: [] };
        }

        if( Array.isArray( operatorDocument.$in ) && operatorDocument.$in.length > 0 )
        {
            const remainingIn = operatorDocument.$in.filter(
                ( item: unknown ) => isRegexLike( item ) || !forbidden.has( structuralFingerprint( item ))
            );

            if( remainingIn.length === 0 )
            {
                return { $in: [] };
            }

            if( remainingIn.length < operatorDocument.$in.length )
            {
                operatorDocument = { ...operatorDocument, $in: remainingIn };
            }
        }
    }

    const keys = Object.keys( operatorDocument );
    const hasRanges = keys.some(( k ) => k === '$gt' || k === '$gte' || k === '$lt' || k === '$lte' );

    if( !hasRanges ){ return operatorDocument }

    const isDateMode = [
        operatorDocument.$gt,
        operatorDocument.$gte,
        operatorDocument.$lt,
        operatorDocument.$lte
    ].some(( v ) => v instanceof Date );

    const gt = extractComparableBound( operatorDocument.$gt, isDateMode );
    const gte = extractComparableBound( operatorDocument.$gte, isDateMode );
    const lt = extractComparableBound( operatorDocument.$lt, isDateMode );
    const lte = extractComparableBound( operatorDocument.$lte, isDateMode );

    if( gt === undefined && gte === undefined && lt === undefined && lte === undefined )
    {
        return operatorDocument;
    }

    let finalLower: { val: number; strict: boolean } | undefined;

    if( gt !== undefined && gte !== undefined )
    {
        finalLower = ( gt >= gte )
            ? { val: gt, strict: true }
            : { val: gte, strict: false };
    }
    else if( gt !== undefined )
    {
        finalLower = { val: gt, strict: true };
    }
    else if( gte !== undefined )
    {
        finalLower = { val: gte, strict: false };
    }

    let finalUpper: { val: number; strict: boolean } | undefined;

    if( lt !== undefined && lte !== undefined )
    {
        finalUpper = ( lt <= lte )
            ? { val: lt, strict: true }
            : { val: lte, strict: false };
    }
    else if( lt !== undefined )
    {
        finalUpper = { val: lt, strict: true };
    }
    else if( lte !== undefined )
    {
        finalUpper = { val: lte, strict: false };
    }

    if( finalLower !== undefined && finalUpper !== undefined )
    {
        const isContradiction =
            finalLower.val > finalUpper.val
            || ( finalLower.val === finalUpper.val && ( finalLower.strict || finalUpper.strict ));

        if( isContradiction )
        {
            return { $in: [] };
        }

        if( finalLower.val === finalUpper.val && !finalLower.strict && !finalUpper.strict )
        {
            const { $gt: _1, $gte: _2, $lt: _3, $lte: _4, ...rest } = operatorDocument;

            return {
                ...rest,
                $eq: isDateMode ? new Date( finalLower.val ) : finalLower.val
            };
        }
    }

    const eqVal = extractComparableBound( operatorDocument.$eq, isDateMode );

    if( eqVal !== undefined )
    {
        if( finalLower !== undefined )
        {
            const invalid = finalLower.strict ? eqVal <= finalLower.val : eqVal < finalLower.val;

            if( invalid ){ return { $in: [] } }
        }

        if( finalUpper !== undefined )
        {
            const invalid = finalUpper.strict ? eqVal >= finalUpper.val : eqVal > finalUpper.val;

            if( invalid ){ return { $in: [] } }
        }

        const { $gt: _1, $gte: _2, $lt: _3, $lte: _4, ...rest } = operatorDocument;

        return rest;
    }

    let changed = false;
    const result: Record<string, any> = { ...operatorDocument };

    if( gt !== undefined && ( finalLower === undefined || !finalLower.strict || finalLower.val !== gt ))
    {
        delete result.$gt;
        changed = true;
    }

    if( gte !== undefined && ( finalLower === undefined || finalLower.strict || finalLower.val !== gte ))
    {
        delete result.$gte;
        changed = true;
    }

    if( lt !== undefined && ( finalUpper === undefined || !finalUpper.strict || finalUpper.val !== lt ))
    {
        delete result.$lt;
        changed = true;
    }

    if( lte !== undefined && ( finalUpper === undefined || finalUpper.strict || finalUpper.val !== lte ))
    {
        delete result.$lte;
        changed = true;
    }

    return changed ? result : operatorDocument;
}

function applyFilterDocumentSweep(
    filter: Record<string, any>,
    rules: readonly FilterRule[],
    context: GuaranteeContext,
): any
{
    if (!isFilterRewriteSafe(filter))
    {
        return filter;
    }

    let current = filter;

    for (const [key, value] of Object.entries(filter))
    {
        let optimizedValue = value;

        if ((key === '$and' || key === '$or') && Array.isArray(value))
        {
            optimizedValue = value.map((condition) =>
                applyFilterSweep(condition, rules, context),
            );
        }
        else if (!key.startsWith('$') && isOperatorSubdocument(value))
        {
            optimizedValue = optimizeOperatorChildren(value, rules, context);
            optimizedValue = simplifyFieldIntervals(optimizedValue);

            if (Array.isArray(optimizedValue.$in) && optimizedValue.$in.length === 0)
            {
                return { [key]: { $in: [] } };
            }
        }

        if (optimizedValue !== value)
        {
            if (current === filter)
            {
                current = { ...filter };
            }

            current[key] = optimizedValue;
        }
    }

    for (const rule of rules)
    {
        if (!isPlainObject(current))
        {
            return current;
        }

        current = rule.apply(current, context);
    }

    return current;
}

function applyFilterSweep(filter: any, rules: readonly FilterRule[], context: GuaranteeContext): any
{
    if (
        !filter
        || typeof filter !== 'object'
        || Array.isArray(filter)
        || filter instanceof Date
        || filter instanceof RegExp
    )
    {
        return filter;
    }

    if (!isPlainObject(filter))
    {
        return filter;
    }

    return applyFilterDocumentSweep(filter, rules, context);
}

function optimizeFilterWithRules(
    filter: any,
    rules: readonly FilterRule[],
    sweepBudget = DEFAULT_FILTER_SWEEP_BUDGET,
    context: GuaranteeContext,
): any
{
    if (
        !filter
        || typeof filter !== 'object'
        || Array.isArray(filter)
        || filter instanceof Date
        || filter instanceof RegExp
    )
    {
        return filter;
    }

    if (!isPlainObject(filter))
    {
        return filter;
    }

    let rootCopy: any;
    try
    {
        rootCopy = { ...filter };
    }
    catch
    {
        return filter;
    }

    if (
        rules.length === 0
        || !Number.isSafeInteger(sweepBudget)
        || sweepBudget <= 0
    )
    {
        return rootCopy;
    }

    try
    {
        let current = rootCopy;
        let currentFingerprint = structuralFingerprint(current);
        const history = new Set<string>([currentFingerprint]);

        for (let sweep = 0; sweep < sweepBudget; sweep++)
        {
            const next = applyFilterSweep(current, rules, context);
            const nextFingerprint = structuralFingerprint(next);

            if (nextFingerprint === currentFingerprint)
            {
                return next;
            }

            if (history.has(nextFingerprint))
            {
                return rootCopy;
            }

            history.add(nextFingerprint);
            current = next;
            currentFingerprint = nextFingerprint;
        }

        return rootCopy;
    }
    catch
    {
        return rootCopy;
    }
}

export function optimizeFilter<T = any>( filter: any, options?: OptimizerOptions ): T
{
    try
    {
        if( !isPlainObject( filter ))
        {
            return filter;
        }

        return optimizeFilterWithContext( filter, resolveFilterGuarantees( options ));
    }
    catch
    {
        return filter;
    }
}

/**
 * Package-private entry for passes that already hold a resolved pipeline context.
 */
export function optimizeFilterWithContext( filter: any, context: GuaranteeContext ): any
{
    return optimizeFilterWithRules( filter, getActiveFilterRules(), DEFAULT_FILTER_SWEEP_BUDGET, context );
}

/**
 * Package-private scheduler seam for direct filter cycle and budget tests.
 */
export function optimizeFilterWithRulesForTesting(
    filter: any,
    rules: readonly FilterRule[],
    sweepBudget = DEFAULT_FILTER_SWEEP_BUDGET,
    options?: OptimizerOptions,
): any
{
    return optimizeFilterWithRules(filter, rules, sweepBudget, resolveFilterGuarantees( options ));
}

/**
 * Package-private candidate seam. The package root intentionally does not export it.
 */
export function optimizeFilterWithCandidateProfile(
    filter: any,
    selectedRuleIds?: readonly string[],
    options?: OptimizerOptions,
): any
{
    if (selectedRuleIds)
    {
        return withCandidateFilterRuleProfile(
            () => optimizeFilter(filter, options),
            selectedRuleIds,
        );
    }

    return withCandidateFilterRuleProfile(() => optimizeFilter(filter, options));
}
