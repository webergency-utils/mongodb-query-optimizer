import
{
    isFilterContradiction,
    isFilterRewriteSafe,
    markFilterRewriteSafe
}
from './analyzer/filters';
import { GuaranteeContext } from './guarantees';
import
{
    deduplicateBoundedArray,
    hasSingleKey,
    isEmptyObject,
    isEqual,
    isOperatorSubdocument,
    isPlainObject
}
from './utils';

type FilterDocument = Record<string, any>;

const registeredFilterRuleIds = Object.freeze([
    'simplify-equality',
    'simplify-singleton-in',
    'flatten-conjunctions',
    'flatten-disjunctions',
    'simplify-conjunction-identities',
    'simplify-disjunction-identities',
    'deduplicate-conjunctions',
    'merge-conjunctions'
] as const );

export type FilterRuleId = typeof registeredFilterRuleIds[number];

const activeFilterRuleIds: readonly FilterRuleId[] = Object.freeze(
[
    'simplify-equality',
    'simplify-singleton-in',
    'flatten-conjunctions',
    'flatten-disjunctions',
    'deduplicate-conjunctions',
    'merge-conjunctions',
    'simplify-conjunction-identities',
    'simplify-disjunction-identities'
] );

const containedFilterRuleIds: readonly FilterRuleId[] = Object.freeze([]);

export interface FilterRuleRegistryStatus
{
    readonly registered : readonly FilterRuleId[]
    readonly active     : readonly FilterRuleId[]
    readonly contained  : readonly FilterRuleId[]
}

const filterRuleRegistryStatus: FilterRuleRegistryStatus = Object.freeze({
    registered: registeredFilterRuleIds,
    active: activeFilterRuleIds,
    contained: containedFilterRuleIds
});

export interface FilterRule
{
    readonly id : FilterRuleId
    apply( filter: FilterDocument, context: GuaranteeContext, isOwned?: boolean ): any
}

const isEmptyFilter = isEmptyObject;

function cloneOrMutateFilter(
    filter  : FilterDocument,
    isOwned : boolean
): FilterDocument
{
    if( isOwned )
    {
        return filter;
    }

    const cloned = { ...filter };
    markFilterRewriteSafe( cloned );

    return cloned;
}

export function isSafeImplicitEqualityValue( value: any ): boolean
{
    return (
        typeof value === 'string'
        || typeof value === 'boolean'
        || ( typeof value === 'number' && Number.isFinite( value ))
        || ( value instanceof Date && !Number.isNaN( value.getTime() ))
        || Boolean( value && typeof value === 'object' && value._bsontype === 'ObjectId' )
    );
}

function simplifySingleFieldOperator(
    filter      : FilterDocument,
    operator    : '$eq' | '$in',
    isOwned     = false
): FilterDocument
{
    let result = filter;
    let owned = isOwned;

    for( const key in filter )
    {
        const value = filter[ key ];

        if(
            key.startsWith( '$' )
            || !isOperatorSubdocument( value )
            || !( operator in value )
            || !hasSingleKey( value )
        )
        {
            continue;
        }

        if( operator === '$in' )
        {
            if( !Array.isArray( value.$in )){ continue }

            const unique = deduplicateBoundedArray( value.$in );

            if( unique.length === 1 && isSafeImplicitEqualityValue( unique[ 0 ] ))
            {
                if( !owned )
                {
                    result = cloneOrMutateFilter( result, false );
                    owned = true;
                }

                result[ key ] = unique[ 0 ];
                continue;
            }

            if( unique !== value.$in )
            {
                if( !owned )
                {
                    result = cloneOrMutateFilter( result, false );
                    owned = true;
                }

                result[ key ] = { ...value, $in: unique };
                continue;
            }

            continue;
        }

        const operand = value.$eq;

        if( !isSafeImplicitEqualityValue( operand ))
        {
            continue;
        }

        if( !owned )
        {
            result = cloneOrMutateFilter( result, false );
            owned = true;
        }

        result[ key ] = operand;
    }

    return result;
}

const simplifyEqualityRule: FilterRule =
{
    id: 'simplify-equality',
    apply( filter, _context, isOwned = false )
    {
        return simplifySingleFieldOperator( filter, '$eq', isOwned );
    }
};

const simplifySingletonInRule: FilterRule =
{
    id: 'simplify-singleton-in',
    apply( filter, _context, isOwned = false )
    {
        return simplifySingleFieldOperator( filter, '$in', isOwned );
    }
};

function canFlattenLogicalItem(
    condition   : unknown,
    operator    : '$and' | '$or'
): condition is FilterDocument
{
    return (
        isPlainObject( condition )
        && ( operator in condition )
        && hasSingleKey( condition )
        && Array.isArray( condition[ operator ] )
        && condition[ operator ].length > 0
    );
}

function flattenLogicalArray(
    filter      : FilterDocument,
    operator    : '$and' | '$or',
    isOwned     = false
): FilterDocument
{
    const conditions = filter[ operator ];

    if(
        !Array.isArray( conditions )
        || conditions.length === 0
        || !isFilterRewriteSafe( filter )
    )
    {
        return filter;
    }

    if( !conditions.some(( condition ) => canFlattenLogicalItem( condition, operator )))
    {
        return filter;
    }

    const flattened: any[] = [];

    for( const condition of conditions )
    {
        if( canFlattenLogicalItem( condition, operator ))
        {
            flattened.push( ...condition[ operator ] );
        }
        else
        {
            flattened.push( condition );
        }
    }

    const target = cloneOrMutateFilter( filter, isOwned );
    target[ operator ] = flattened;

    return target;
}

const flattenConjunctionsRule: FilterRule =
{
    id: 'flatten-conjunctions',
    apply( filter, _context, isOwned = false )
    {
        return flattenLogicalArray( filter, '$and', isOwned );
    }
};

const flattenDisjunctionsRule: FilterRule =
{
    id: 'flatten-disjunctions',
    apply( filter, _context, isOwned = false )
    {
        return flattenLogicalArray( filter, '$or', isOwned );
    }
};

const simplifyConjunctionIdentitiesRule: FilterRule =
{
    id: 'simplify-conjunction-identities',
    apply( filter, _context, isOwned = false )
    {
        const conditions = filter.$and;

        if(
            !Array.isArray( conditions )
            || conditions.length === 0
            || !isFilterRewriteSafe( filter )
        )
        {
            return filter;
        }

        const contradiction = conditions.find(( condition ) => isFilterContradiction( condition ));
        const isOnlyCondition = hasSingleKey( filter );

        if( contradiction )
        {
            if( isOnlyCondition ){ return contradiction }

            const target = cloneOrMutateFilter( filter, isOwned );
            target.$and = [ contradiction ];

            return target;
        }

        const hasEmpty = conditions.some(( condition ) => isEmptyFilter( condition ));
        const remaining = hasEmpty
            ? conditions.filter(( condition ) => !isEmptyFilter( condition ))
            : conditions;

        if( isOnlyCondition && remaining.length === 0 )
        {
            return {};
        }

        if( isOnlyCondition && remaining.length === 1 )
        {
            return remaining[ 0 ];
        }

        if( remaining.length === 0 )
        {
            const { $and: _removed, ...rest } = filter;
            markFilterRewriteSafe( rest );

            return rest;
        }

        if(
            remaining.length === 1
            && !( '$or' in filter )
            && canFlattenLogicalItem( remaining[ 0 ], '$or' )
        )
        {
            const { $and: _removed, ...rest } = filter;
            const target: FilterDocument =
            {
                ...rest,
                $or: remaining[ 0 ].$or
            };
            markFilterRewriteSafe( target );

            return target;
        }

        if( remaining === conditions )
        {
            return filter;
        }

        const target = cloneOrMutateFilter( filter, isOwned );
        target.$and = remaining;

        return target;
    }
};

const simplifyDisjunctionIdentitiesRule: FilterRule =
{
    id: 'simplify-disjunction-identities',
    apply( filter, _context, isOwned = false )
    {
        const conditions = filter.$or;

        if(
            !Array.isArray( conditions )
            || conditions.length === 0
            || !isFilterRewriteSafe( filter )
        )
        {
            return filter;
        }

        if( conditions.some(( condition ) => isEmptyFilter( condition )))
        {
            const { $or: _removed, ...rest } = filter;
            markFilterRewriteSafe( rest );

            return rest;
        }

        const hasContradiction = conditions.some(( condition ) => isFilterContradiction( condition ));
        const nonContradictory = hasContradiction
            ? conditions.filter(( condition ) => !isFilterContradiction( condition ))
            : conditions;

        if( nonContradictory.length === 0 )
        {
            return conditions[ 0 ];
        }

        const unique = deduplicateBoundedArray( nonContradictory );
        const isOnlyCondition = hasSingleKey( filter );

        if( isOnlyCondition && unique.length === 1 ){ return unique[ 0 ] }

        if( unique === conditions )
        {
            return filter;
        }

        const target = cloneOrMutateFilter( filter, isOwned );
        target.$or = unique;

        return target;
    }
};

const deduplicateConjunctionsRule: FilterRule =
{
    id: 'deduplicate-conjunctions',
    apply( filter, _context, isOwned = false )
    {
        const conditions = filter.$and;

        if(
            !Array.isArray( conditions )
            || conditions.length === 0
            || !isFilterRewriteSafe( filter )
        )
        {
            return filter;
        }

        const unique = deduplicateBoundedArray( conditions );

        if( unique === conditions )
        {
            return filter;
        }

        const target = cloneOrMutateFilter( filter, isOwned );
        target.$and = unique;

        return target;
    }
};

function hasFieldPredicate( value: any ): value is FilterDocument
{
    if( !isPlainObject( value ))
    {
        return false;
    }

    for( const key in value )
    {
        if( !key.startsWith( '$' )){ return true }
    }

    return false;
}

const mergeConjunctionsRule: FilterRule =
{
    id: 'merge-conjunctions',
    apply( filter )
    {
        const conditions = filter.$and;

        if(
            !Array.isArray( conditions )
            || conditions.length === 0
            || !isFilterRewriteSafe( filter )
            || !conditions.some( hasFieldPredicate )
        )
        {
            return filter;
        }

        const { $and: _removed, ...rest } = filter;
        const merged: FilterDocument = { ...rest };
        const occupiedFields = new Set<string>();

        for( const key in rest )
        {
            if( !key.startsWith( '$' ))
            {
                occupiedFields.add( key );
            }
        }

        const remaining: any[] = [];
        let changed = false;

        for( const condition of conditions )
        {
            if( !hasFieldPredicate( condition ))
            {
                remaining.push( condition );
                continue;
            }

            let unmerged: FilterDocument | undefined;
            let branchChanged = false;

            for( const [ field, val ] of Object.entries( condition ))
            {
                if( field.startsWith( '$' ))
                {
                    if( unmerged === undefined )
                    {
                        unmerged = {};
                    }

                    unmerged[ field ] = val;
                }
                else if( !occupiedFields.has( field ))
                {
                    merged[ field ] = val;
                    occupiedFields.add( field );
                    changed = true;
                    branchChanged = true;
                }
                else if( isEqual( merged[ field ], val ))
                {
                    changed = true;
                    branchChanged = true;
                }
                else
                {
                    if( unmerged === undefined )
                    {
                        unmerged = {};
                    }

                    unmerged[ field ] = val;
                }
            }

            if( unmerged !== undefined )
            {
                if( branchChanged )
                {
                    markFilterRewriteSafe( unmerged );
                    remaining.push( unmerged );
                }
                else
                {
                    remaining.push( condition );
                }
            }
        }

        if( !changed )
        {
            return filter;
        }

        if( remaining.length > 0 )
        {
            merged.$and = remaining;
        }

        markFilterRewriteSafe( merged );

        return merged;
    }
};

const candidateFilterRuleRegistry: Readonly<Record<FilterRuleId, FilterRule>> = Object.freeze({
    'simplify-equality': simplifyEqualityRule,
    'simplify-singleton-in': simplifySingletonInRule,
    'flatten-conjunctions': flattenConjunctionsRule,
    'flatten-disjunctions': flattenDisjunctionsRule,
    'simplify-conjunction-identities': simplifyConjunctionIdentitiesRule,
    'simplify-disjunction-identities': simplifyDisjunctionIdentitiesRule,
    'deduplicate-conjunctions': deduplicateConjunctionsRule,
    'merge-conjunctions': mergeConjunctionsRule,
});

const candidateFilterProfile: readonly FilterRuleId[] =
    registeredFilterRuleIds;

const productionFilterRuleRegistry: readonly FilterRule[] = Object.freeze(
    activeFilterRuleIds.map((id) => candidateFilterRuleRegistry[id]),
);

let injectedFilterRuleRegistry: readonly FilterRule[] | undefined;

export function isUsingProductionFilterRules( rules: readonly FilterRule[] ): boolean
{
    return rules === productionFilterRuleRegistry;
}

/**
 * Package-private immutable registry introspection for proof-manifest tests.
 */
export function getFilterRuleRegistryStatus(): FilterRuleRegistryStatus
{
    return filterRuleRegistryStatus;
}

export function getActiveFilterRules(): readonly FilterRule[]
{
    return injectedFilterRuleRegistry ?? productionFilterRuleRegistry;
}

function resolveCandidateRules(selectedRuleIds: readonly string[]): readonly FilterRule[]
{
    const resolved: FilterRule[] = [];

    for (const id of selectedRuleIds)
    {
        const rule = (candidateFilterRuleRegistry as Record<string, FilterRule | undefined>)[id];
        if (!rule)
        {
            throw new Error(`Filter rule is not registered: ${id}`);
        }

        resolved.push(rule);
    }

    return Object.freeze(resolved);
}

export function withCandidateFilterRuleProfile<T>(
    run: () => T,
    selectedRuleIds: readonly string[] = candidateFilterProfile,
): T
{
    const selectedRules = resolveCandidateRules(selectedRuleIds);
    const previousRegistry = injectedFilterRuleRegistry;
    injectedFilterRuleRegistry = selectedRules;

    try
    {
        return run();
    }
    finally
    {
        injectedFilterRuleRegistry = previousRegistry;
    }
}
