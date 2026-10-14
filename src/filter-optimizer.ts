import
{
    FilterRule,
    getActiveFilterRules,
    isSafeImplicitEqualityValue,
    isUsingProductionFilterRules,
    withCandidateFilterRuleProfile
}
from './filter-rule-registry';
import
{
    isFilterContradiction,
    isFilterRewriteSafe,
    markFilterRewriteSafe
}
from './analyzer/filters';
import
{
    GuaranteeContext,
    OptimizerOptions,
    resolveFilterGuarantees
}
from './guarantees';
import
{
    MAX_ANALYZED_ARRAY_LENGTH,
    containsValue,
    deduplicateBoundedArray,
    hasCycle,
    hasSingleKey,
    isEmptyObject,
    isEqual,
    isOperatorSubdocument,
    isPlainObject
}
from './utils';

const DEFAULT_FILTER_SWEEP_BUDGET = 32;

function optimizeOperatorChildren(
    operatorDocument    : Record<string, any>,
    rules               : readonly FilterRule[],
    context             : GuaranteeContext
): Record<string, any>
{
    let result = operatorDocument;

    for( const [ operator, value ] of Object.entries( operatorDocument ))
    {
        if( operator === '$not' || operator === '$elemMatch' )
        {
            const optimized = applyFilterSweep( value, rules, context );

            if( optimized !== value )
            {
                if( result === operatorDocument )
                {
                    result = { ...operatorDocument };
                }

                result[ operator ] = optimized;
            }

            continue;
        }

        if( operator === '$all' && Array.isArray( value ))
        {
            let nextAll: any[] | undefined;

            for( let i = 0; i < value.length; i++ )
            {
                const item = value[ i ];
                let nextItem = item;

                if(
                    isPlainObject( item )
                    && Object.keys( item ).length === 1
                    && isPlainObject( item.$elemMatch )
                )
                {
                    const sweptElemMatch = applyFilterSweep( item.$elemMatch, rules, context );

                    if( sweptElemMatch !== item.$elemMatch )
                    {
                        nextItem = { $elemMatch: sweptElemMatch };
                    }
                }

                if( nextItem !== item && nextAll === undefined )
                {
                    nextAll = value.slice( 0, i );
                }

                if( nextAll !== undefined )
                {
                    nextAll.push( nextItem );
                }
            }

            if( nextAll !== undefined )
            {
                if( result === operatorDocument )
                {
                    result = { ...operatorDocument };
                }

                result.$all = nextAll;
            }
        }
    }

    return result;
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
    inputDocument   : Record<string, any>,
    alreadyCloned   = false
): Record<string, any>
{
    let operatorDocument = inputDocument;
    let owned = alreadyCloned;

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
                owned = true;
            }
        }
    }

    if( Array.isArray( operatorDocument.$nin ) && operatorDocument.$nin.length >= 2 )
    {
        const dedupedNin = deduplicateBoundedArray( operatorDocument.$nin );

        if( dedupedNin !== operatorDocument.$nin )
        {
            if( !owned )
            {
                operatorDocument = { ...operatorDocument };
                owned = true;
            }

            operatorDocument.$nin = dedupedNin;
        }
    }

    if( Array.isArray( operatorDocument.$all ) && operatorDocument.$all.length >= 2 )
    {
        const dedupedAll = deduplicateBoundedArray( operatorDocument.$all );

        if( dedupedAll !== operatorDocument.$all )
        {
            if( !owned )
            {
                operatorDocument = { ...operatorDocument };
                owned = true;
            }

            operatorDocument.$all = dedupedAll;
        }
    }

function buildFastForbiddenChecker( forbiddenItems: readonly unknown[] ): ( item: unknown ) => boolean
{
    if( forbiddenItems.length <= 16 )
    {
        return ( target: unknown ) => containsValue( forbiddenItems, target );
    }

    let primitiveSet: Set<unknown> | undefined;
    let hasNegZero = false;
    let dateSet: Set<number> | undefined;
    let hexSet: Set<string> | undefined;
    let oidTable: Int32Array | undefined;
    let oidMask = 0;
    const nonPrimitives: unknown[] = [];

    const len = forbiddenItems.length;
    for( let i = 0; i < len; i++ )
    {
        const item = forbiddenItems[ i ] as any;
        if( item === null || ( typeof item !== 'object' && typeof item !== 'function' ))
        {
            if( Object.is( item, -0 )){ hasNegZero = true }
            else { primitiveSet ??= new Set(); primitiveSet.add( item ); }
        }
        else if(
            typeof item.i0 === 'number'
            && typeof item.i1 === 'number'
            && typeof item.i2 === 'number'
            && typeof item.i3 === 'number'
        )
        {
            if( oidTable === undefined )
            {
                let cap = 16;
                while( cap < len * 2 && cap < 131072 ){ cap <<= 1 }
                oidMask = cap - 1;
                oidTable = new Int32Array( cap ).fill( -1 );
            }
            const { i0, i1, i2, i3 } = item;
            const hash = ( i0 ^ ( i1 * 31 ) ^ ( i2 * 101 ) ^ ( i3 * 1009 )) >>> 0;
            let slot = hash & oidMask;
            while( oidTable[ slot ] !== -1 )
            {
                const ex = forbiddenItems[ oidTable[ slot ]! ] as any;
                if( ex.i0 === i0 && ex.i1 === i1 && ex.i2 === i2 && ex.i3 === i3 )
                {
                    break;
                }
                slot = ( slot + 1 ) & oidMask;
            }
            oidTable[ slot ] = i;
        }
        else if( item instanceof Date )
        {
            dateSet ??= new Set();
            dateSet.add( item.getTime() );
        }
        else if( item && ( item._bsontype === 'ObjectId' || typeof item.toHexString === 'function' ))
        {
            hexSet ??= new Set();
            hexSet.add( typeof item.toHexString === 'function' ? item.toHexString() : String( item ));
        }
        else
        {
            nonPrimitives.push( item );
        }
    }

    return ( target: unknown ) =>
    {
        if( target === null || ( typeof target !== 'object' && typeof target !== 'function' ))
        {
            if( Object.is( target, -0 )){ return hasNegZero }
            return primitiveSet !== undefined && primitiveSet.has( target );
        }
        if(
            oidTable !== undefined
            && typeof ( target as any ).i0 === 'number'
            && typeof ( target as any ).i1 === 'number'
            && typeof ( target as any ).i2 === 'number'
            && typeof ( target as any ).i3 === 'number'
        )
        {
            const { i0, i1, i2, i3 } = target as any;
            const hash = ( i0 ^ ( i1 * 31 ) ^ ( i2 * 101 ) ^ ( i3 * 1009 )) >>> 0;
            let slot = hash & oidMask;
            while( oidTable[ slot ] !== -1 )
            {
                const ex = forbiddenItems[ oidTable[ slot ]! ] as any;
                if( ex.i0 === i0 && ex.i1 === i1 && ex.i2 === i2 && ex.i3 === i3 )
                {
                    return true;
                }
                slot = ( slot + 1 ) & oidMask;
            }
            return false;
        }
        if( target instanceof Date )
        {
            return dateSet !== undefined && dateSet.has( target.getTime() );
        }
        if( hexSet !== undefined && target && ( ( target as any )._bsontype === 'ObjectId' || typeof ( target as any ).toHexString === 'function' ))
        {
            const hex = typeof ( target as any ).toHexString === 'function' ? ( target as any ).toHexString() : String( target );
            return hexSet.has( hex );
        }
        return containsValue( nonPrimitives, target );
    };
}

    const hasCrossFilterTarget = (
        '$eq' in operatorDocument
        || Array.isArray( operatorDocument.$all )
        || ( Array.isArray( operatorDocument.$in ) && operatorDocument.$in.length > 0 )
    );
    const forbiddenItems: any[] = [];

    if( hasCrossFilterTarget )
    {
        if( Array.isArray( operatorDocument.$nin ))
        {
            for( const item of operatorDocument.$nin )
            {
                if( !isRegexLike( item ))
                {
                    forbiddenItems.push( item );
                }
            }
        }

        if( '$ne' in operatorDocument && !isRegexLike( operatorDocument.$ne ))
        {
            forbiddenItems.push( operatorDocument.$ne );
        }
    }

    if( forbiddenItems.length > 0 )
    {
        const isForbidden = buildFastForbiddenChecker( forbiddenItems );

        if(
            '$eq' in operatorDocument
            && !isRegexLike( operatorDocument.$eq )
            && isForbidden( operatorDocument.$eq )
        )
        {
            return { $in: [] };
        }

        if(
            Array.isArray( operatorDocument.$all )
            && operatorDocument.$all.some(
                ( item: unknown ) => !isRegexLike( item ) && isForbidden( item )
            )
        )
        {
            return { $in: [] };
        }

        if(
            Array.isArray( operatorDocument.$in )
            && operatorDocument.$in.length > 0
        )
        {
            const remainingIn = operatorDocument.$in.filter(
                ( item: unknown ) => isRegexLike( item ) || !isForbidden( item )
            );

            if( remainingIn.length === 0 )
            {
                return { $in: [] };
            }

            if( remainingIn.length < operatorDocument.$in.length )
            {
                if( !owned )
                {
                    operatorDocument = { ...operatorDocument };
                    owned = true;
                }

                operatorDocument.$in = remainingIn;
            }
        }
    }

    const hasRanges = (
        '$gt' in operatorDocument
        || '$gte' in operatorDocument
        || '$lt' in operatorDocument
        || '$lte' in operatorDocument
    );

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

    if(
        Array.isArray( operatorDocument.$in )
        && operatorDocument.$in.length > 0
    )
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
            if( !owned )
            {
                operatorDocument = { ...operatorDocument };
                owned = true;
            }

            operatorDocument.$in = filteredIn;
        }
    }

    const dropGt = gt !== undefined && ( finalLower === undefined || !finalLower.strict || finalLower.val !== gt );
    const dropGte = gte !== undefined && ( finalLower === undefined || finalLower.strict || finalLower.val !== gte );
    const dropLt = lt !== undefined && ( finalUpper === undefined || !finalUpper.strict || finalUpper.val !== lt );
    const dropLte = lte !== undefined && ( finalUpper === undefined || finalUpper.strict || finalUpper.val !== lte );

    if( !dropGt && !dropGte && !dropLt && !dropLte )
    {
        return operatorDocument;
    }

    const result: Record<string, any> = owned ? operatorDocument : { ...operatorDocument };

    if( dropGt ){ delete result.$gt }

    if( dropGte ){ delete result.$gte }

    if( dropLt ){ delete result.$lt }

    if( dropLte ){ delete result.$lte }

    return result;
}

function isConsolidatableScalar( val: unknown ): boolean
{
    return val === null || val instanceof Date || isSafeImplicitEqualityValue( val );
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
    if(
        !Array.isArray( filter.$or )
        || filter.$or.length < 2
        || filter.$or.length > MAX_ANALYZED_ARRAY_LENGTH
    )
    {
        return filter;
    }

    const branches = filter.$or;
    let commonField: string | null = null;
    const values: any[] = [];

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
            if( !containsValue( values, v ))
            {
                if( values.length >= MAX_ANALYZED_ARRAY_LENGTH )
                {
                    return filter;
                }

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
    if(
        !Array.isArray( filter.$or )
        || filter.$or.length < 2
        || filter.$or.length > MAX_ANALYZED_ARRAY_LENGTH
    )
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

        const presentInAll = branches.every(( b: Record<string, any> ) =>
            key in b
            && Object.keys( b ).length >= 2
            && isEqual( b[ key ], val )
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
            const sweptRest = Object.keys( rest ).length > 0
                ? applyFilterSweep( rest, rules, context )
                : rest;
            const normalizedRest = isPlainObject( sweptRest ) ? sweptRest : rest;

            const baseBranches = sweepFilterBranches( norBranches, rules, context );
            const uniqueBranches = deduplicateBoundedArray( baseBranches );

            if( uniqueBranches.some(( b ) => isEmptyObject( b )))
            {
                return { _id: { $in: [] } };
            }

            const hasContradiction = uniqueBranches.some(( b ) => isFilterContradiction( b ));
            const liveBranches = hasContradiction
                ? uniqueBranches.filter(( b ) => !isFilterContradiction( b ))
                : uniqueBranches;

            if( liveBranches.length === 0 )
            {
                return normalizedRest;
            }

            if( liveBranches.length === 1 )
            {
                const single = liveBranches[ 0 ] as Record<string, any>;
                const entries = Object.entries( single );

                if( entries.length === 1 )
                {
                    const [ field, cond ] = entries[ 0 ]!;

                    if( !field.startsWith( '$' ) && !( field in normalizedRest ))
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

                            return { ...normalizedRest, [ field ]: { $ne: eqVal } };
                        }

                        if(
                            isPlainObject( cond )
                            && Object.keys( cond ).length === 1
                            && '$in' in cond
                            && Array.isArray( cond.$in )
                        )
                        {
                            return { ...normalizedRest, [ field ]: { $nin: cond.$in } };
                        }
                    }
                }
            }

            if( liveBranches !== norBranches || normalizedRest !== rest )
            {
                return { ...normalizedRest, $nor: liveBranches };
            }
        }
    }

    return null;
}

function simplifyElemMatchSubsumption(
    filter  : Record<string, any>,
    isOwned = false
): Record<string, any>
{
    let current = filter;
    let owned = isOwned;

    for( const key in current )
    {
        if( key.startsWith( '$' ))
        {
            continue;
        }

        const value = current[ key ];

        if( !isPlainObject( value ) || !isPlainObject( value.$elemMatch ))
        {
            continue;
        }

        const elemMatch = value.$elemMatch;

        for( const subKey in elemMatch )
        {
            if( subKey.startsWith( '$' ))
            {
                continue;
            }

            const dottedKey = `${ key }.${ subKey }`;

            if(
                dottedKey in current
                && isSafeImplicitEqualityValue( current[ dottedKey ] )
                && isEqual( elemMatch[ subKey ], current[ dottedKey ] )
            )
            {
                if( !owned )
                {
                    current = { ...current };
                    markFilterRewriteSafe( current );
                    owned = true;
                }

                delete current[ dottedKey ];
            }
        }
    }

    return current;
}

function simplifyBooleanAbsorption(
    filter  : Record<string, any>,
    isOwned = false
): Record<string, any>
{
    let current = filter;
    let owned = isOwned;

    if(
        Array.isArray( current.$or )
        && current.$or.length >= 2
        && current.$or.length <= MAX_ANALYZED_ARRAY_LENGTH
        && !hasSingleKey( current )
    )
    {
        const absorbedByTopLevel = current.$or.some(( branch: unknown ) =>
        {
            if( !isPlainObject( branch ))
            {
                return false;
            }

            const entries = Object.entries( branch );

            return (
                entries.length > 0
                && entries.every(
                    ([ k, v ]) =>
                        !k.startsWith( '$' )
                        && k in current
                        && isEqual( current[ k ], v )
                )
            );
        });

        if( absorbedByTopLevel )
        {
            const { $or: _removedOr, ...rest } = current;
            markFilterRewriteSafe( rest );

            current = rest;
            owned = true;
        }
    }

    if(
        Array.isArray( current.$or )
        && current.$or.length >= 2
        && current.$or.length <= MAX_ANALYZED_ARRAY_LENGTH
        && current.$or.some(
            ( b: unknown ) => isPlainObject( b ) && ( !hasSingleKey( b ) || Array.isArray( b.$and ))
        )
    )
    {
        const orBranches = current.$or;
        const singleKeyMap = new Map<string, any[]>();

        for( const branch of orBranches )
        {
            if( isPlainObject( branch ) && hasSingleKey( branch ))
            {
                const [ k, v ] = Object.entries( branch )[ 0 ]!;

                if( !k.startsWith( '$' ))
                {
                    let list = singleKeyMap.get( k );

                    if( !list )
                    {
                        list = [];
                        singleKeyMap.set( k, list );
                    }

                    list.push( v );
                }
            }
        }

        const filteredOr = orBranches.filter(( branch: unknown ) =>
        {
            if( !isPlainObject( branch ))
            {
                return true;
            }

            const isSingle = hasSingleKey( branch );

            if(
                !isSingle
                && Object.entries( branch ).some(([ k, v ]) =>
                {
                    const list = singleKeyMap.get( k );

                    return list !== undefined && containsValue( list, v );
                })
            )
            {
                return false;
            }

            if(
                isSingle
                && Array.isArray( branch.$and )
                && branch.$and.length <= MAX_ANALYZED_ARRAY_LENGTH
                && branch.$and.some(( item: unknown ) => containsValue( orBranches, item ))
            )
            {
                return false;
            }

            return true;
        });

        if( filteredOr.length < orBranches.length )
        {
            if( filteredOr.length === 1 && hasSingleKey( current ))
            {
                current = filteredOr[ 0 ];
                owned = false;
            }
            else
            {
                if( !owned )
                {
                    current = { ...current };
                    markFilterRewriteSafe( current );
                    owned = true;
                }

                current.$or = filteredOr;
            }
        }
    }

    if(
        isPlainObject( current )
        && Array.isArray( current.$and )
        && current.$and.length >= 2
        && current.$and.length <= MAX_ANALYZED_ARRAY_LENGTH
        && current.$and.some(
            ( b: unknown ) =>
                isPlainObject( b )
                && ( '$or' in b )
                && hasSingleKey( b )
                && Array.isArray( b.$or )
                && b.$or.length <= MAX_ANALYZED_ARRAY_LENGTH
        )
    )
    {
        const andBranches = current.$and;
        const filteredAnd = andBranches.filter(( branch: unknown ) =>
            !(
                isPlainObject( branch )
                && ( '$or' in branch )
                && hasSingleKey( branch )
                && Array.isArray( branch.$or )
                && branch.$or.length <= MAX_ANALYZED_ARRAY_LENGTH
                && branch.$or.some(( item: unknown ) => containsValue( andBranches, item ))
            )
        );

        if( filteredAnd.length < andBranches.length )
        {
            if( !owned )
            {
                current = { ...current };
                markFilterRewriteSafe( current );
                owned = true;
            }

            current.$and = filteredAnd;
        }
    }

    return current;
}

function sweepFilterBranches(
    branches    : readonly any[],
    rules       : readonly FilterRule[],
    context     : GuaranteeContext
): any[]
{
    let nextBranches: any[] | undefined;

    for( let i = 0; i < branches.length; i++ )
    {
        const condition = branches[ i ];
        const swept = applyFilterSweep( condition, rules, context );

        if( swept !== condition && nextBranches === undefined )
        {
            nextBranches = branches.slice( 0, i );
        }

        if( nextBranches !== undefined )
        {
            nextBranches.push( swept );
        }
    }

    return nextBranches ?? ( branches as any[] );
}

function applyFilterDocumentSweep(
    filter  : Record<string, any>,
    rules   : readonly FilterRule[],
    context : GuaranteeContext
): any
{
    const specialNormalized = normalizeSpecialFilterOperators( filter, rules, context );

    if( specialNormalized !== null )
    {
        return specialNormalized;
    }

    if( !isFilterRewriteSafe( filter ))
    {
        return filter;
    }

    let current = filter;
    let ownedClone: Record<string, any> | null = null;

    for( const key in filter )
    {
        const value = filter[ key ];
        let optimizedValue = value;

        if(( key === '$and' || key === '$or' ) && Array.isArray( value ))
        {
            optimizedValue = sweepFilterBranches( value, rules, context );
        }
        else if( !key.startsWith( '$' ) && isOperatorSubdocument( value ))
        {
            optimizedValue = optimizeOperatorChildren( value, rules, context );
            optimizedValue = simplifyFieldIntervals( optimizedValue, optimizedValue !== value );

            if( Array.isArray( optimizedValue.$in ) && optimizedValue.$in.length === 0 )
            {
                return { [ key ]: { $in: [] } };
            }
        }

        if( optimizedValue !== value )
        {
            if( ownedClone === null )
            {
                ownedClone = { ...filter };
                markFilterRewriteSafe( ownedClone );
                current = ownedClone;
            }

            current[ key ] = optimizedValue;
        }
    }

    for( const rule of rules )
    {
        if( !isPlainObject( current ))
        {
            return current;
        }

        const next = rule.apply( current, context, current === ownedClone );

        if(
            next !== current
            && isPlainObject( next )
            && rule.id !== 'simplify-conjunction-identities'
            && rule.id !== 'simplify-disjunction-identities'
        )
        {
            ownedClone = next;
        }

        current = next;
    }

    if( isPlainObject( current ))
    {
        current = simplifyElemMatchSubsumption( current, current === ownedClone );
        current = simplifyBooleanAbsorption( current, current === ownedClone );

        if( isPlainObject( current ) && Array.isArray( current.$or ))
        {
            current = extractCommonOrFactors( current );
        }
    }

    return current;
}

const fixedPointFilters = new WeakSet<object>();
const productionFilterResultCache = new WeakMap<object, Record<string, any>>();

function applyFilterSweep( filter: any, rules: readonly FilterRule[], context: GuaranteeContext ): any
{
    if(
        !isPlainObject( filter )
        || ( isUsingProductionFilterRules( rules ) && fixedPointFilters.has( filter ))
    )
    {
        return filter;
    }

    const result = applyFilterDocumentSweep( filter, rules, context );

    if(
        result === filter
        && isUsingProductionFilterRules( rules )
        && ( !Array.isArray( filter.$or ) || consolidateOrSameFieldDocument( filter ) === filter )
    )
    {
        fixedPointFilters.add( filter );
    }

    return result;
}

function optimizeFilterWithRules(
    filter      : any,
    rules       : readonly FilterRule[],
    sweepBudget = DEFAULT_FILTER_SWEEP_BUDGET,
    context     : GuaranteeContext
): any
{
    if( !isPlainObject( filter ) || hasCycle( filter ))
    {
        return filter;
    }

    const isProd = isUsingProductionFilterRules( rules );

    if(
        rules.length === 0
        || !Number.isSafeInteger( sweepBudget )
        || sweepBudget <= 0
        || ( isProd && fixedPointFilters.has( filter ))
    )
    {
        return filter;
    }

    if( isProd && sweepBudget === DEFAULT_FILTER_SWEEP_BUDGET )
    {
        const cached = productionFilterResultCache.get( filter );

        if( cached !== undefined )
        {
            return cached;
        }
    }

    try
    {
        let current = filter;
        const history: Record<string, any>[] = [ current ];

        for( let sweep = 0; sweep < sweepBudget; sweep++ )
        {
            let next = applyFilterSweep( current, rules, context );

            if( isPlainObject( next ) && Array.isArray( next.$or ))
            {
                next = consolidateOrSameFieldDocument( next );
            }

            if( next === current || isEqual( next, current ))
            {
                if( isProd )
                {
                    fixedPointFilters.add( current );

                    if( sweepBudget === DEFAULT_FILTER_SWEEP_BUDGET )
                    {
                        productionFilterResultCache.set( filter, current );
                    }
                }

                return current;
            }

            if( sweep > 0 && containsValue( history, next ))
            {
                return filter;
            }

            history.push( next );
            current = next;
        }

        return filter;
    }
    catch
    {
        return filter;
    }
}

export function optimizeFilter<T = any>( filter: any, options?: OptimizerOptions ): T
{
    return optimizeFilterWithRulesForTesting(
        filter,
        getActiveFilterRules(),
        DEFAULT_FILTER_SWEEP_BUDGET,
        options
    ) as T;
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
    filter      : any,
    rules       : readonly FilterRule[],
    sweepBudget = DEFAULT_FILTER_SWEEP_BUDGET,
    options?    : OptimizerOptions
): any
{
    try
    {
        if( !isPlainObject( filter ))
        {
            return filter;
        }

        const result = optimizeFilterWithRules( filter, rules, sweepBudget, resolveFilterGuarantees( options ));

        return isPlainObject( result ) ? { ...result } : result;
    }
    catch
    {
        return filter;
    }
}

/**
 * Package-private candidate seam. The package root intentionally does not export it.
 */
export function optimizeFilterWithCandidateProfile(
    filter          : any,
    selectedRuleIds?: readonly string[],
    options?        : OptimizerOptions
): any
{
    if( selectedRuleIds )
    {
        return withCandidateFilterRuleProfile(
            () => optimizeFilter( filter, options ),
            selectedRuleIds
        );
    }

    return withCandidateFilterRuleProfile(() => optimizeFilter( filter, options ));
}

