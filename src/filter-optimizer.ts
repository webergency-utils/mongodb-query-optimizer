import {
    FilterRule,
    getActiveFilterRules,
    withCandidateFilterRuleProfile,
} from './filter-rule-registry';
import { isFilterContradiction, isFilterRewriteSafe } from './analyzer/filters';
import
{
    GuaranteeContext,
    OptimizerOptions,
    resolveFilterGuarantees
}
from './guarantees';
import {
    isEmptyObject,
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

    if( Array.isArray( operatorDocument.$all ) && operatorDocument.$all.length >= 2 )
    {
        const dedupedAll = deduplicateOperatorArray( operatorDocument.$all );

        if( dedupedAll )
        {
            operatorDocument = { ...operatorDocument, $all: dedupedAll };
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

        if(
            Array.isArray( operatorDocument.$all )
            && operatorDocument.$all.some(
                ( item: unknown ) => !isRegexLike( item ) && forbidden.has( structuralFingerprint( item ))
            )
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

    if( Array.isArray( operatorDocument.$in ) && operatorDocument.$in.length > 0 )
    {
        const filteredIn = operatorDocument.$in.filter(( item: unknown ) =>
        {
            const itemVal = extractComparableBound( item, isDateMode );

            if( itemVal === undefined )
            {
                return true;
            }

            if( finalLower !== undefined )
            {
                const belowLower = finalLower.strict ? itemVal <= finalLower.val : itemVal < finalLower.val;

                if( belowLower ){ return false }
            }

            if( finalUpper !== undefined )
            {
                const aboveUpper = finalUpper.strict ? itemVal >= finalUpper.val : itemVal > finalUpper.val;

                if( aboveUpper ){ return false }
            }

            return true;
        });

        if( filteredIn.length === 0 )
        {
            return { $in: [] };
        }

        if( filteredIn.length < operatorDocument.$in.length )
        {
            operatorDocument = { ...operatorDocument, $in: filteredIn };
        }
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

function isConsolidatableScalar( val: unknown ): boolean
{
    if( val === null || typeof val === 'string' || typeof val === 'boolean' || val instanceof Date )
    {
        return true;
    }

    return typeof val === 'number' && Number.isFinite( val );
}

function extractBranchScalarOrInValues( branch: unknown ): { field: string; values: any[] } | null
{
    if( !isPlainObject( branch ))
    {
        return null;
    }

    const entries = Object.entries( branch );
    if( entries.length !== 1 )
    {
        return null;
    }

    const [ field, cond ] = entries[ 0 ]!;
    if( field.startsWith( '$' ))
    {
        return null;
    }

    if( isConsolidatableScalar( cond ))
    {
        return { field, values: [ cond ] };
    }

    if( !isPlainObject( cond ) || Object.keys( cond ).length !== 1 )
    {
        return null;
    }

    if( '$eq' in cond && isConsolidatableScalar( cond.$eq ))
    {
        return { field, values: [ cond.$eq ] };
    }

    if(
        '$in' in cond
        && Array.isArray( cond.$in )
        && cond.$in.length > 0
        && cond.$in.every( isConsolidatableScalar )
    )
    {
        return { field, values: cond.$in };
    }

    return null;
}

function consolidateOrSameFieldDocument(
    filter: Record<string, any>
): Record<string, any>
{
    if( !Array.isArray( filter.$or ) || filter.$or.length < 2 )
    {
        return filter;
    }

    const branches = filter.$or;
    let commonField: string | null = null;
    const values: any[] = [];
    const seen = new Set<string>();

    for( const branch of branches )
    {
        const extracted = extractBranchScalarOrInValues( branch );
        if( !extracted )
        {
            return filter;
        }

        if( commonField === null )
        {
            commonField = extracted.field;
        }
        else if( extracted.field !== commonField )
        {
            return filter;
        }

        for( const v of extracted.values )
        {
            const fp = structuralFingerprint( v );
            if( !seen.has( fp ))
            {
                seen.add( fp );
                values.push( v );
            }
        }
    }

    if( commonField === null || commonField in filter )
    {
        return filter;
    }

    const result: Record<string, any> = {};
    for( const [ k, v ] of Object.entries( filter ))
    {
        if( k === '$or' )
        {
            result[ commonField ] = values.length === 1
                ? values[ 0 ]
                : { $in: values };
        }
        else
        {
            result[ k ] = v;
        }
    }

    return result;
}

function extractCommonOrFactors(
    filter: Record<string, any>
): Record<string, any>
{
    if( !Array.isArray( filter.$or ) || filter.$or.length < 2 )
    {
        return filter;
    }

    const branches = filter.$or;
    for( const b of branches )
    {
        if( !isPlainObject( b ) || Object.keys( b ).length < 2 )
        {
            return filter;
        }
    }

    const firstBranch = branches[ 0 ] as Record<string, any>;
    const commonKeys: string[] = [];

    for( const [ key, val ] of Object.entries( firstBranch ))
    {
        if( key.startsWith( '$' ) || key in filter )
        {
            continue;
        }

        const targetFp = structuralFingerprint( val );
        const presentInAll = branches.every(( b: Record<string, any> ) =>
            key in b
            && Object.keys( b ).length >= 2
            && structuralFingerprint( b[ key ] ) === targetFp
        );

        if( presentInAll && Object.keys( firstBranch ).length - ( commonKeys.length + 1 ) >= 1 )
        {
            commonKeys.push( key );
        }
    }

    if( commonKeys.length === 0 )
    {
        return filter;
    }

    const commonSet = new Set( commonKeys );
    const updatedBranches = branches.map(( b: Record<string, any> ) =>
    {
        const nextBranch: Record<string, any> = {};
        for( const [ k, v ] of Object.entries( b ))
        {
            if( !commonSet.has( k ))
            {
                nextBranch[ k ] = v;
            }
        }
        return nextBranch;
    });

    const result: Record<string, any> = {};
    for( const k of commonKeys )
    {
        result[ k ] = firstBranch[ k ];
    }

    for( const [ k, v ] of Object.entries( filter ))
    {
        result[ k ] = k === '$or' ? updatedBranches : v;
    }

    return result;
}

function normalizeSpecialFilterOperators(
    filter  : Record<string, any>,
    rules   : readonly FilterRule[],
    context : GuaranteeContext
): Record<string, any> | null
{
    if( '$expr' in filter )
    {
        const exprVal = filter.$expr;
        const { $expr: _removedExpr, ...rest } = filter;

        if( isFilterRewriteSafe( rest ))
        {
            if( exprVal === false || exprVal === 0 || exprVal === null )
            {
                return { _id: { $in: [] } };
            }

            if( exprVal === true || ( typeof exprVal === 'number' && Number.isFinite( exprVal )))
            {
                return rest;
            }
        }
    }

    if( Array.isArray( filter.$nor ) && filter.$nor.length > 0 )
    {
        const norBranches = filter.$nor as unknown[];
        const { $nor: _removedNor, ...rest } = filter;

        if(
            isFilterRewriteSafe( rest )
            && norBranches.every(( b ) => isPlainObject( b ) && isFilterRewriteSafe( b ))
        )
        {
            const sweptBranches = norBranches.map(( b ) => applyFilterSweep( b, rules, context ));
            const uniqueBranches = deduplicateOperatorArray( sweptBranches ) ?? sweptBranches;

            if( uniqueBranches.some(( b ) => isEmptyObject( b )))
            {
                return { _id: { $in: [] } };
            }

            const liveBranches = uniqueBranches.filter(( b ) => !isFilterContradiction( b ));

            if( liveBranches.length === 0 )
            {
                return rest;
            }

            if( liveBranches.length === 1 )
            {
                const single = liveBranches[ 0 ] as Record<string, any>;
                const entries = Object.entries( single );

                if( entries.length === 1 )
                {
                    const [ field, cond ] = entries[ 0 ]!;

                    if( !field.startsWith( '$' ) && !( field in rest ))
                    {
                        if(
                            isConsolidatableScalar( cond )
                            || (
                                isPlainObject( cond )
                                && Object.keys( cond ).length === 1
                                && '$eq' in cond
                                && isConsolidatableScalar( cond.$eq )
                            )
                        )
                        {
                            const eqVal = isConsolidatableScalar( cond ) ? cond : cond.$eq;
                            return { ...rest, [ field ]: { $ne: eqVal } };
                        }

                        if(
                            isPlainObject( cond )
                            && Object.keys( cond ).length === 1
                            && '$in' in cond
                            && Array.isArray( cond.$in )
                        )
                        {
                            return { ...rest, [ field ]: { $nin: cond.$in } };
                        }
                    }
                }
            }

            if(
                liveBranches.length < norBranches.length
                || liveBranches.some(( b, idx ) => b !== norBranches[ idx ] )
            )
            {
                return { ...rest, $nor: liveBranches };
            }
        }
    }

    return null;
}

function simplifyBooleanAbsorption(
    filter: Record<string, any>
): Record<string, any>
{
    let current = filter;

    if( Array.isArray( current.$or ) && current.$or.length >= 2 )
    {
        const absorbedByTopLevel = current.$or.some(( branch: unknown ) =>
        {
            if( !isPlainObject( branch ) || Object.keys( branch ).length !== 1 )
            {
                return false;
            }

            const [ k, v ] = Object.entries( branch )[ 0 ]!;

            return (
                !k.startsWith( '$' )
                && k in current
                && structuralFingerprint( current[ k ] ) === structuralFingerprint( v )
            );
        });

        if( absorbedByTopLevel )
        {
            const { $or: _removedOr, ...rest } = current;
            current = rest;
        }
    }

    if( Array.isArray( current.$or ) && current.$or.length >= 2 )
    {
        const singleKeyMap = new Map<string, Set<string>>();
        const branchFingerprints = new Set<string>();

        for( const branch of current.$or )
        {
            branchFingerprints.add( structuralFingerprint( branch ));

            if( isPlainObject( branch ) && Object.keys( branch ).length === 1 )
            {
                const [ k, v ] = Object.entries( branch )[ 0 ]!;
                if( !k.startsWith( '$' ))
                {
                    let set = singleKeyMap.get( k );
                    if( !set )
                    {
                        set = new Set<string>();
                        singleKeyMap.set( k, set );
                    }
                    set.add( structuralFingerprint( v ));
                }
            }
        }

        const filteredOr = current.$or.filter(( branch: unknown ) =>
        {
            if( !isPlainObject( branch ))
            {
                return true;
            }

            const keys = Object.keys( branch );

            if(
                keys.length >= 2
                && Object.entries( branch ).some(
                    ([ k, v ]) => singleKeyMap.get( k )?.has( structuralFingerprint( v )) === true
                )
            )
            {
                return false;
            }

            if(
                keys.length === 1
                && Array.isArray( branch.$and )
                && branch.$and.some(( item: unknown ) => branchFingerprints.has( structuralFingerprint( item )))
            )
            {
                return false;
            }

            return true;
        });

        if( filteredOr.length < current.$or.length )
        {
            current = ( filteredOr.length === 1 && Object.keys( current ).length === 1 )
                ? filteredOr[ 0 ]
                : { ...current, $or: filteredOr };
        }
    }

    if( isPlainObject( current ) && Array.isArray( current.$and ) && current.$and.length >= 2 )
    {
        const andFingerprints = new Set<string>(
            current.$and.map(( b: unknown ) => structuralFingerprint( b ))
        );

        const filteredAnd = current.$and.filter(( branch: unknown ) =>
            !(
                isPlainObject( branch )
                && Object.keys( branch ).length === 1
                && Array.isArray( branch.$or )
                && branch.$or.some(( item: unknown ) => andFingerprints.has( structuralFingerprint( item )))
            )
        );

        if( filteredAnd.length < current.$and.length )
        {
            current = { ...current, $and: filteredAnd };
        }
    }

    return current;
}

function applyFilterDocumentSweep(
    filter: Record<string, any>,
    rules: readonly FilterRule[],
    context: GuaranteeContext,
): any
{
    const specialNormalized = normalizeSpecialFilterOperators( filter, rules, context );
    if( specialNormalized !== null )
    {
        return specialNormalized;
    }

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

    if (isPlainObject(current))
    {
        current = simplifyBooleanAbsorption(current);

        if (Array.isArray(current.$or))
        {
            current = extractCommonOrFactors(current);
        }
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
            let next = applyFilterSweep(current, rules, context);
            if (isPlainObject(next) && Array.isArray(next.$or))
            {
                next = consolidateOrSameFieldDocument(next);
            }
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
