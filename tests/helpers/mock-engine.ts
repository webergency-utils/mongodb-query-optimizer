// Supplemental structural executor only. Real MongoDB is the semantic authority.
export type MockDatabase = Readonly<Record<string, readonly any[]>>;

function cloneJson<T>(value: T): T
{
    return JSON.parse(JSON.stringify(value)) as T;
}

export function runMockPipeline(
    data: any[],
    pipeline: any[],
    db: MockDatabase = {},
): any[]
{
    let docs = cloneJson(data);

    for (const stage of pipeline)
    {
        const op = Object.keys(stage)[0];
        const val = stage[op];

        switch (op)
        {
            case '$match':
            {
                docs = docs.filter((doc: any) => matchDoc(doc, val));
                break;
            }
            case '$project':
            {
                docs = docs.map((doc: any) => projectDocument(doc, val));
                break;
            }
            case '$addFields':
            case '$set':
            {
                docs = docs.map((doc: any) =>
                {
                    let newDoc = { ...doc };
                    for (const [key, value] of Object.entries(val))
                    {
                        newDoc = assignFieldPath(newDoc, key.split('.'), evalExpr(doc, value));
                    }
                    return newDoc;
                });
                break;
            }
            case '$unset':
            {
                const fields = Array.isArray(val) ? val : [val];
                docs = docs.map((doc: any) =>
                {
                    const newDoc = cloneJson(doc);
                    for (const field of fields)
                    {
                        deleteNestedVal(newDoc, field);
                    }
                    return newDoc;
                });
                break;
            }
            case '$unwind':
            {
                const path = typeof val === 'string' ? val : val.path;
                const cleanPath = path.startsWith('$') ? path.slice(1) : path;
                const preserve = (
                    val
                    && typeof val === 'object'
                    && val.preserveNullAndEmptyArrays === true
                );
                const indexField = (
                    val
                    && typeof val === 'object'
                )
                    ? val.includeArrayIndex
                    : undefined;
                const unwound: any[] = [];

                for (const doc of docs)
                {
                    const arrayValue = getNestedVal(doc, cleanPath);
                    if (Array.isArray(arrayValue))
                    {
                        if (arrayValue.length === 0 && preserve)
                        {
                            const newDoc = cloneJson(doc);
                            deleteNestedVal(newDoc, cleanPath);
                            if (indexField)
                            {
                                newDoc[indexField] = null;
                            }
                            unwound.push(newDoc);
                        }
                        else
                        {
                            for (let index = 0; index < arrayValue.length; index++)
                            {
                                const newDoc = cloneJson(doc);
                                setNestedVal(newDoc, cleanPath, arrayValue[index]);
                                if (indexField)
                                {
                                    newDoc[indexField] = index;
                                }
                                unwound.push(newDoc);
                            }
                        }
                    }
                    else if (
                        (arrayValue === null || arrayValue === undefined)
                        && preserve
                    )
                    {
                        const newDoc = cloneJson(doc);
                        if (indexField)
                        {
                            newDoc[indexField] = null;
                        }
                        unwound.push(newDoc);
                    }
                    else if (arrayValue !== null && arrayValue !== undefined)
                    {
                        const newDoc = cloneJson(doc);
                        if (indexField)
                        {
                            newDoc[indexField] = null;
                        }
                        unwound.push(newDoc);
                    }
                }
                docs = unwound;
                break;
            }
            case '$sort':
            {
                docs.sort((left: any, right: any) =>
                {
                    for (const [key, direction] of Object.entries(val))
                    {
                        const descending = (direction as number) === -1;
                        const order = compareSortValues(
                            sortKeyValue(getNestedVal(left, key), descending),
                            sortKeyValue(getNestedVal(right, key), descending),
                        );
                        if (order !== 0)
                        {
                            return descending ? -order : order;
                        }
                    }
                    return 0;
                });
                break;
            }
            case '$limit':
            {
                docs = docs.slice(0, val);
                break;
            }
            case '$skip':
            {
                docs = docs.slice(val);
                break;
            }
            case '$lookup':
            {
                const foreignDocs = db[val.from] || [];

                docs = docs.map((doc: any) =>
                {
                    const newDoc = { ...doc };
                    const localValue = getNestedVal(doc, val.localField);
                    const matches = foreignDocs.filter((foreignDoc: any) =>
                    {
                        const foreignValue = getNestedVal(
                            foreignDoc,
                            val.foreignField,
                        );
                        return JSON.stringify(localValue) === JSON.stringify(foreignValue);
                    });
                    newDoc[val.as] = matches;
                    return newDoc;
                });
                break;
            }
            case '$group':
            {
                const idExpression = val._id;
                const accumulators = { ...val };
                delete accumulators._id;

                const groups: Record<string, any[]> = {};
                for (const doc of docs)
                {
                    const idVal = evalExpr(doc, idExpression) ?? null;
                    const groupKey = JSON.stringify(idVal);
                    if (!groups[groupKey])
                    {
                        groups[groupKey] = [];
                    }
                    groups[groupKey].push(doc);
                }

                const groupedDocs: any[] = [];
                for (const [key, groupDocs] of Object.entries(groups))
                {
                    const groupedDoc: any = {
                        _id: JSON.parse(key),
                    };

                    for (const [field, accumulatorExpression] of Object.entries(
                        accumulators,
                    ))
                    {
                        const accumulatorOperator = Object.keys(
                            accumulatorExpression as any,
                        )[0];
                        const accumulatorValue = (
                            accumulatorExpression as any
                        )[accumulatorOperator];

                        if (accumulatorOperator === '$sum')
                        {
                            let sum = 0;
                            for (const doc of groupDocs)
                            {
                                const evaluated = evalExpr(doc, accumulatorValue);
                                sum += typeof evaluated === 'number' ? evaluated : 0;
                            }
                            groupedDoc[field] = sum;
                        }
                        else if (accumulatorOperator === '$avg')
                        {
                            let sum = 0;
                            let count = 0;
                            for (const doc of groupDocs)
                            {
                                const evaluated = evalExpr(doc, accumulatorValue);
                                if (typeof evaluated === 'number')
                                {
                                    sum += evaluated;
                                    count++;
                                }
                            }
                            groupedDoc[field] = count > 0 ? sum / count : null;
                        }
                        else if (accumulatorOperator === '$min')
                        {
                            let minVal: any = undefined;
                            for (const doc of groupDocs)
                            {
                                const evaluated = evalExpr(doc, accumulatorValue);
                                if (evaluated !== undefined && evaluated !== null)
                                {
                                    if (minVal === undefined || evaluated < minVal)
                                    {
                                        minVal = evaluated;
                                    }
                                }
                            }
                            groupedDoc[field] = minVal === undefined ? null : minVal;
                        }
                        else if (accumulatorOperator === '$max')
                        {
                            let maxVal: any = undefined;
                            for (const doc of groupDocs)
                            {
                                const evaluated = evalExpr(doc, accumulatorValue);
                                if (evaluated !== undefined && evaluated !== null)
                                {
                                    if (maxVal === undefined || evaluated > maxVal)
                                    {
                                        maxVal = evaluated;
                                    }
                                }
                            }
                            groupedDoc[field] = maxVal === undefined ? null : maxVal;
                        }
                        else if (accumulatorOperator === '$first')
                        {
                            groupedDoc[field] = groupDocs.length > 0
                                ? evalExpr(groupDocs[0], accumulatorValue)
                                : null;
                        }
                        else if (accumulatorOperator === '$last')
                        {
                            groupedDoc[field] = groupDocs.length > 0
                                ? evalExpr(groupDocs[groupDocs.length - 1], accumulatorValue)
                                : null;
                        }
                        else if (accumulatorOperator === '$push')
                        {
                            groupedDoc[field] = groupDocs.map((doc) => evalExpr(doc, accumulatorValue));
                        }
                    }
                    groupedDocs.push(groupedDoc);
                }
                docs = groupedDocs;
                break;
            }
            case '$count':
            {
                docs = docs.length === 0 ? [] : [{ [val]: docs.length }];
                break;
            }
            case '$sortByCount':
            {
                const groups: Record<string, number> = {};
                const idValues: Record<string, any> = {};

                for( const doc of docs )
                {
                    const idVal = evalExpr( doc, val ) ?? null;
                    const groupKey = JSON.stringify( idVal );

                    groups[groupKey] = ( groups[groupKey] || 0 ) + 1;
                    idValues[groupKey] = idVal;
                }

                const resultDocs: any[] = [];
                for( const [ key, count ] of Object.entries( groups ))
                {
                    resultDocs.push({
                        _id: idValues[key],
                        count
                    });
                }

                resultDocs.sort( ( a, b ) => b.count - a.count );
                docs = resultDocs;
                break;
            }
            case '$bucket':
            {
                const { groupBy, boundaries, default: defaultVal, output } = val;
                const groups: Record<string, any[]> = {};

                for( const doc of docs )
                {
                    const docVal = evalExpr( doc, groupBy );
                    let matchedBucket: any = undefined;

                    for( let k = 0; k < boundaries.length - 1; k++ )
                    {
                        if( docVal >= boundaries[k] && docVal < boundaries[k + 1] )
                        {
                            matchedBucket = boundaries[k];
                            break;
                        }
                    }

                    if( matchedBucket === undefined )
                    {
                        if( defaultVal !== undefined )
                        {
                            matchedBucket = defaultVal;
                        }
                        else
                        {
                            throw new Error( '$bucket could not find a matching branch for an input, and no default was specified.' );
                        }
                    }

                    const keyStr = JSON.stringify( matchedBucket );
                    if( !groups[keyStr] )
                    {
                        groups[keyStr] = [];
                    }
                    groups[keyStr].push( doc );
                }

                const bucketDocs: any[] = [];
                const effectiveOutput = output || { count: { $sum: 1 } };

                for( const [ keyStr, groupDocs ] of Object.entries( groups ))
                {
                    const bucketId = JSON.parse( keyStr );
                    const bucketDoc: any = { _id: bucketId };

                    for( const [ field, accumulatorExpression ] of Object.entries( effectiveOutput ))
                    {
                        const accumulatorOperator = Object.keys( accumulatorExpression as any )[0];
                        const accumulatorValue = ( accumulatorExpression as any )[accumulatorOperator];

                        if( accumulatorOperator === '$sum' )
                        {
                            let sum = 0;
                            for( const doc of groupDocs )
                            {
                                const evaluated = evalExpr( doc, accumulatorValue );
                                sum += typeof evaluated === 'number' ? evaluated : 0;
                            }
                            bucketDoc[field] = sum;
                        }
                        else if( accumulatorOperator === '$avg' )
                        {
                            let sum = 0;
                            let count = 0;
                            for( const doc of groupDocs )
                            {
                                const evaluated = evalExpr( doc, accumulatorValue );
                                if( typeof evaluated === 'number' )
                                {
                                    sum += evaluated;
                                    count++;
                                }
                            }
                            bucketDoc[field] = count > 0 ? sum / count : null;
                        }
                        else if( accumulatorOperator === '$min' )
                        {
                            let minVal: any = undefined;
                            for( const doc of groupDocs )
                            {
                                const evaluated = evalExpr( doc, accumulatorValue );
                                if( evaluated !== undefined && evaluated !== null )
                                {
                                    if( minVal === undefined || evaluated < minVal )
                                    {
                                        minVal = evaluated;
                                    }
                                }
                            }
                            bucketDoc[field] = minVal === undefined ? null : minVal;
                        }
                        else if( accumulatorOperator === '$max' )
                        {
                            let maxVal: any = undefined;
                            for( const doc of groupDocs )
                            {
                                const evaluated = evalExpr( doc, accumulatorValue );
                                if( evaluated !== undefined && evaluated !== null )
                                {
                                    if( maxVal === undefined || evaluated > maxVal )
                                    {
                                        maxVal = evaluated;
                                    }
                                }
                            }
                            bucketDoc[field] = maxVal === undefined ? null : maxVal;
                        }
                        else if( accumulatorOperator === '$push' )
                        {
                            bucketDoc[field] = groupDocs.map( ( doc ) => evalExpr( doc, accumulatorValue ));
                        }
                    }

                    bucketDocs.push( bucketDoc );
                }

                bucketDocs.sort( ( a, b ) => ( a._id < b._id ? -1 : a._id > b._id ? 1 : 0 ));
                docs = bucketDocs;
                break;
            }
            case '$facet':
            {
                const facetResults: Record<string, any[]> = {};
                for (const [facetName, facetPipeline] of Object.entries(val))
                {
                    facetResults[facetName] = runMockPipeline(docs, facetPipeline as any[], db);
                }
                docs = [facetResults];
                break;
            }
            case '$replaceRoot':
            {
                docs = docs.map((doc: any) =>
                {
                    const rootValue = evalExpr(doc, val.newRoot);
                    return typeof rootValue === 'object' ? rootValue : {};
                });
                break;
            }
            case '$replaceWith':
            {
                docs = docs.map((doc: any) =>
                {
                    const rootValue = evalExpr(doc, val);
                    return typeof rootValue === 'object' ? rootValue : {};
                });
                break;
            }
            default:
                throw new Error(`Mock pipeline runner does not support stage: ${op}`);
        }
    }

    return docs;
}

function projectionMode(
    specification: Record<string, any>,
): "inclusion" | "exclusion"
{
    const entries = Object.entries(specification);
    if (entries.length === 0)
    {
        throw new Error("Mock engine rejects MongoDB empty projection");
    }

    let hasInclusion = false;
    let hasExclusion = false;

    for (const [path, value] of entries)
    {
        if (path === "_id")
        {
            continue;
        }

        if (value === 0 || value === false)
        {
            hasExclusion = true;
        }
        else
        {
            hasInclusion = true;
        }
    }

    if (hasInclusion && hasExclusion)
    {
        throw new Error("Mock engine rejects MongoDB invalid mixed projection");
    }

    if (!hasInclusion && !hasExclusion)
    {
        return specification._id === 0 || specification._id === false
            ? "exclusion"
            : "inclusion";
    }

    return hasInclusion ? "inclusion" : "exclusion";
}

function projectDocument(
    doc: Record<string, any>,
    specification: Record<string, any>,
): Record<string, any>
{
    const mode = projectionMode(specification);
    if (mode === "exclusion")
    {
        const projected = cloneJson(doc);
        for (const [path, value] of Object.entries(specification))
        {
            if (value === 0 || value === false)
            {
                deleteNestedVal(projected, path);
            }
        }
        return projected;
    }

    const projected: Record<string, any> = {};
    if (
        specification._id !== 0
        && specification._id !== false
        && "_id" in doc
    )
    {
        projected._id = doc._id;
    }

    for (const [path, value] of Object.entries(specification))
    {
        if (path === "_id")
        {
            if (
                value !== 0
                && value !== false
                && value !== 1
                && value !== true
            )
            {
                const evaluated = evalExpr(doc, value);
                if (evaluated !== undefined)
                {
                    projected._id = evaluated;
                }
            }
            continue;
        }

        const evaluated = value === 1 || value === true
            ? getNestedVal(doc, path)
            : evalExpr(doc, value);
        if (evaluated !== undefined)
        {
            setNestedVal(projected, path, evaluated);
        }
    }

    return projected;
}

function getNestedVal(obj: any, path: string): any
{
    if (obj === null || obj === undefined)
    {
        return undefined;
    }

    const parts = path.split(".");
    let current: any = obj;

    for (let index = 0; index < parts.length; index++)
    {
        const part = parts[index]!;
        if (Array.isArray(current))
        {
            const remainingPath = parts.slice(index).join(".");
            return current.map((item) => getNestedVal(item, remainingPath));
        }
        if (
            current
            && typeof current === "object"
            && part in current
        )
        {
            current = current[part];
        }
        else
        {
            return undefined;
        }
    }

    return current;
}

function setNestedVal(obj: any, path: string, value: any): void
{
    const parts = path.split(".");
    let current = obj;

    for (let index = 0; index < parts.length - 1; index++)
    {
        const part = parts[index]!;
        if (current[part] === undefined || current[part] === null)
        {
            current[part] = {};
        }
        if (typeof current[part] !== "object" || Array.isArray(current[part]))
        {
            throw new Error(`Mock engine does not model a dotted write through non-document ${part}`);
        }
        current = current[part];
    }

    current[parts[parts.length - 1]!] = value;
}

function isPlainDocument( value: unknown ): value is Record<string, any>
{
    return value !== null && typeof value === 'object' && !Array.isArray( value );
}

// $addFields / $set dotted-path semantics verified against MongoDB 8: arrays apply the
// remaining path to every element, nested arrays recurse, and any non-document value is
// replaced by a fresh sub-document.
function assignFieldPath( target: any, parts: readonly string[], value: any ): any
{
    if( Array.isArray( target ))
    {
        return target.map(( element ) => assignFieldPath( element, parts, value ));
    }

    const base: Record<string, any> = isPlainDocument( target ) ? { ...target } : {};
    const [ head, ...rest ] = parts;

    base[head!] = rest.length === 0 ? value : assignFieldPath( base[head!], rest, value );

    return base;
}

function sortTypeRank( value: unknown ): number
{
    if( value === null || value === undefined )
    {
        return 1;
    }

    if( typeof value === 'number' )
    {
        return 2;
    }

    if( typeof value === 'string' )
    {
        return 3;
    }

    if( typeof value === 'boolean' )
    {
        return 6;
    }

    return Array.isArray( value ) ? 5 : 4;
}

// MongoDB sorts an array by its smallest element ascending and its largest element descending.
// An empty array sorts before null.
const EMPTY_ARRAY_SORT_KEY = Symbol( 'empty-array' );

function sortKeyValue( value: unknown, descending: boolean ): unknown
{
    if( !Array.isArray( value ))
    {
        return value;
    }

    if( value.length === 0 )
    {
        return EMPTY_ARRAY_SORT_KEY;
    }

    return value.reduce(( best, entry ) =>
    {
        const order = compareSortValues( entry, best );

        return ( descending ? order > 0 : order < 0 ) ? entry : best;
    });
}

function compareSortValues( left: unknown, right: unknown ): number
{
    const leftRank = left === EMPTY_ARRAY_SORT_KEY ? 0 : sortTypeRank( left );
    const rightRank = right === EMPTY_ARRAY_SORT_KEY ? 0 : sortTypeRank( right );

    if( leftRank !== rightRank )
    {
        return leftRank < rightRank ? -1 : 1;
    }

    if( leftRank <= 1 )
    {
        return 0;
    }

    if( leftRank >= 4 && leftRank <= 5 )
    {
        const leftJson = JSON.stringify( left );
        const rightJson = JSON.stringify( right );

        return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
    }

    return ( left as any ) < ( right as any ) ? -1 : ( left as any ) > ( right as any ) ? 1 : 0;
}

function deleteNestedVal(obj: any, path: string): void
{
    const parts = path.split(".");
    let current = obj;

    for (let index = 0; index < parts.length - 1; index++)
    {
        const part = parts[index]!;
        if (
            current
            && typeof current === "object"
            && part in current
        )
        {
            current = current[part];
        }
        else
        {
            return;
        }
    }

    if (current && typeof current === "object")
    {
        delete current[parts[parts.length - 1]!];
    }
}

type MockVariables = Readonly<Record<string, unknown>>;

function isMongoTruthy( value: unknown ): boolean
{
    return !( value === false || value === null || value === undefined || value === 0 );
}

function isNullish( value: unknown ): boolean
{
    return value === null || value === undefined;
}

function operandList( doc: any, value: any, vars: MockVariables ): any[]
{
    return Array.isArray( value )
        ? value.map(( entry ) => evalExpr( doc, entry, vars ))
        : [ evalExpr( doc, value, vars ) ];
}

function resolveVariable( reference: string, vars: MockVariables ): any
{
    const [ name, ...path ] = reference.split( '.' );

    if( name === 'REMOVE' )
    {
        return undefined;
    }

    if( !Object.prototype.hasOwnProperty.call( vars, name! ))
    {
        throw new Error( `Mock engine does not define variable $$${ name }` );
    }

    const root = vars[name!];

    return path.length === 0 ? root : getNestedVal( root, path.join( '.' ));
}

function strictArithmetic( operator: string, values: any[] ): any
{
    if( values.some( isNullish ))
    {
        return null;
    }

    for( const entry of values )
    {
        if( typeof entry !== 'number' )
        {
            throw new Error( `Mock engine ${ operator } only supports numeric types, not ${ typeof entry }` );
        }
    }

    if( operator === '$add' )
    {
        return values.reduce(( sum, entry ) => sum + entry, 0 );
    }

    if( operator === '$multiply' )
    {
        return values.reduce(( product, entry ) => product * entry, 1 );
    }

    if( operator === '$subtract' )
    {
        return values[0] - values[1];
    }

    if( values[1] === 0 )
    {
        throw new Error( "Mock engine can't $divide by zero" );
    }

    return values[0] / values[1];
}

function evalFilter( doc: any, spec: any, vars: MockVariables ): any
{
    const input = evalExpr( doc, spec.input, vars );

    if( isNullish( input ))
    {
        return null;
    }

    if( !Array.isArray( input ))
    {
        throw new Error( 'Mock engine $filter input must be an array' );
    }

    const name = typeof spec.as === 'string' ? spec.as : 'this';
    const limit = spec.limit === undefined ? undefined : evalExpr( doc, spec.limit, vars );
    const kept: any[] = [];

    for( const element of input )
    {
        if( limit !== undefined && kept.length >= limit )
        {
            break;
        }

        if( isMongoTruthy( evalExpr( doc, spec.cond, { ...vars, [name]: element })))
        {
            kept.push( element );
        }
    }

    return kept;
}

function evalCond( doc: any, value: any, vars: MockVariables ): any
{
    const [ condition, thenBranch, elseBranch ] = Array.isArray( value )
        ? value
        : [ value.if, value.then, value.else ];

    return isMongoTruthy( evalExpr( doc, condition, vars ))
        ? evalExpr( doc, thenBranch, vars )
        : evalExpr( doc, elseBranch, vars );
}

function evalMergeObjects( doc: any, value: any, vars: MockVariables ): any
{
    const merged: Record<string, any> = {};

    for( const entry of operandList( doc, value, vars ))
    {
        if( isNullish( entry ))
        {
            continue;
        }

        if( typeof entry !== 'object' || Array.isArray( entry ))
        {
            throw new Error( 'Mock engine $mergeObjects requires object inputs' );
        }

        Object.assign( merged, entry );
    }

    return merged;
}

function evalSum( doc: any, value: any, vars: MockVariables ): number
{
    const values = operandList( doc, value, vars );
    const flattened = !Array.isArray( value ) && Array.isArray( values[0] ) ? values[0] : values;

    return flattened.reduce(( sum: number, entry: any ) => sum + ( typeof entry === 'number' ? entry : 0 ), 0 );
}

function evalComparison( operator: string, values: any[] ): boolean
{
    switch( operator )
    {
        case '$gt': return values[0] > values[1];
        case '$gte': return values[0] >= values[1];
        case '$lt': return values[0] < values[1];
        case '$lte': return values[0] <= values[1];
        case '$eq': return values[0] === values[1];
        default: return values[0] !== values[1];
    }
}

const COMPARISON_OPERATORS = new Set([ '$gt', '$gte', '$lt', '$lte', '$eq', '$ne' ]);
const ARITHMETIC_OPERATORS = new Set([ '$add', '$multiply', '$subtract', '$divide' ]);

function evalOperator( doc: any, operator: string, value: any, vars: MockVariables ): any
{
    if( COMPARISON_OPERATORS.has( operator ))
    {
        return evalComparison( operator, operandList( doc, value, vars ));
    }

    if( ARITHMETIC_OPERATORS.has( operator ))
    {
        return strictArithmetic( operator, operandList( doc, value, vars ));
    }

    switch( operator )
    {
        case '$literal':
            return value;
        case '$sum':
            return evalSum( doc, value, vars );
        case '$not':
            return !isMongoTruthy( operandList( doc, value, vars )[0] );
        case '$and':
            return operandList( doc, value, vars ).every( isMongoTruthy );
        case '$or':
            return operandList( doc, value, vars ).some( isMongoTruthy );
        case '$toUpper':
        case '$toLower':
        {
            const text = evalExpr( doc, value, vars );

            if( typeof text !== 'string' )
            {
                return text;
            }

            return operator === '$toUpper' ? text.toUpperCase() : text.toLowerCase();
        }
        case '$concat':
            return operandList( doc, value, vars ).join( '' );
        case '$size':
        {
            const array = evalExpr( doc, value, vars );

            if( !Array.isArray( array ))
            {
                throw new Error( 'Mock engine $size argument must be an array' );
            }

            return array.length;
        }
        case '$ifNull':
        {
            const values = operandList( doc, value, vars );

            return isNullish( values[0] ) ? values[1] : values[0];
        }
        case '$cond':
            return evalCond( doc, value, vars );
        case '$filter':
            return evalFilter( doc, value, vars );
        case '$mergeObjects':
            return evalMergeObjects( doc, value, vars );
        case '$function':
        {
            const { body, args } = value;
            const evaluatedArgs = Array.isArray( args )
                ? args.map(( argument: any ) => evalExpr( doc, argument, vars ))
                : [];
            const callable = typeof body === 'function'
                ? body
                : eval( `(${ body })` );

            return callable( ...evaluatedArgs );
        }
        default:
            throw new Error( `Mock engine does not implement expression operator ${ operator }` );
    }
}

function evalExpr( doc: any, expression: any, vars: MockVariables = { ROOT: doc, CURRENT: doc } ): any
{
    if( typeof expression === 'string' )
    {
        if( expression.startsWith( '$$' ))
        {
            return resolveVariable( expression.slice( 2 ), vars );
        }

        if( expression.startsWith( '$' ))
        {
            return getNestedVal( doc, expression.slice( 1 ));
        }

        return expression;
    }

    if( !expression || typeof expression !== 'object' )
    {
        return expression;
    }

    if( Array.isArray( expression ))
    {
        return expression.map(( value ) => evalExpr( doc, value, vars ));
    }

    const keys = Object.keys( expression );

    if( keys.length === 0 )
    {
        return {};
    }

    const operator = keys[0]!;

    if( operator.startsWith( '$' ))
    {
        return evalOperator( doc, operator, expression[operator], vars );
    }

    const result: Record<string, any> = {};

    for( const [ key, value ] of Object.entries( expression ))
    {
        result[key] = evalExpr( doc, value, vars );
    }

    return result;
}

function matchSingleValue(value: any, queryValue: any): boolean
{
    if (queryValue instanceof RegExp)
    {
        return typeof value === "string" && queryValue.test(value);
    }

    if (
        queryValue
        && typeof queryValue === "object"
        && !Array.isArray(queryValue)
        && !(queryValue instanceof Date)
    )
    {
        for (const [operator, operand] of Object.entries(queryValue))
        {
            if (operator === "$eq")
            {
                if (operand === null)
                {
                    if (value !== null && value !== undefined)
                    {
                        return false;
                    }
                }
                else if (value !== operand)
                {
                    return false;
                }
            }
            if (operator === "$ne")
            {
                if (operand === null)
                {
                    if (value === null || value === undefined)
                    {
                        return false;
                    }
                }
                else if (value === operand)
                {
                    return false;
                }
            }
            if (operator === "$gt" && !(value > operand!))
            {
                return false;
            }
            if (operator === "$lt" && !(value < operand!))
            {
                return false;
            }
            if (operator === "$gte" && !(value >= operand!))
            {
                return false;
            }
            if (operator === "$lte" && !(value <= operand!))
            {
                return false;
            }
            if (operator === "$in")
            {
                if (!Array.isArray(operand))
                {
                    throw new Error("Mock engine rejects MongoDB invalid $in array");
                }
                if (!operand.includes(value))
                {
                    return false;
                }
            }
            if (operator === "$not")
            {
                if (operand instanceof RegExp)
                {
                    if (typeof value === "string" && operand.test(value))
                    {
                        return false;
                    }
                }
                else if (matchSingleValue(value, operand))
                {
                    return false;
                }
            }
            if (operator === "$regex")
            {
                const regex = operand instanceof RegExp
                    ? operand
                    : new RegExp(String(operand));
                if (typeof value !== "string" || !regex.test(value))
                {
                    return false;
                }
            }
            if (operator === "$exists")
            {
                const exists = value !== undefined;
                if (Boolean(operand) !== exists)
                {
                    return false;
                }
            }
            if (operator === "$elemMatch")
            {
                if (!Array.isArray(value))
                {
                    return false;
                }
                if (!value.some((entry) => matchDoc(entry, operand)))
                {
                    return false;
                }
            }
            if (operator === "$nin")
            {
                if (!Array.isArray(operand))
                {
                    throw new Error("Mock engine rejects MongoDB invalid $nin array");
                }
                if (operand.includes(value))
                {
                    return false;
                }
            }
            if (operator === "$size")
            {
                if (!Array.isArray(value) || value.length !== operand)
                {
                    return false;
                }
            }
        }
        return true;
    }

    if (queryValue === null)
    {
        return value === null || value === undefined;
    }

    return value === queryValue;
}

function matchValueOrArray(value: any, queryValue: any): boolean
{
    if (matchSingleValue(value, queryValue))
    {
        return true;
    }
    if (Array.isArray(value))
    {
        if (
            queryValue
            && typeof queryValue === "object"
            && ("$size" in queryValue || "$elemMatch" in queryValue || "$exists" in queryValue)
        )
        {
            return false;
        }
        return value.some((entry) => matchValueOrArray(entry, queryValue));
    }
    return false;
}

function matchDoc(doc: any, filter: any): boolean
{
    if (!filter || typeof filter !== "object")
    {
        return true;
    }

    for (const [key, value] of Object.entries(filter))
    {
        if (key === "$and" || key === "$or")
        {
            if (!Array.isArray(value) || value.length === 0)
            {
                throw new Error(
                    `Mock engine rejects MongoDB invalid ${key} array`,
                );
            }

            const matches = value.map((condition) => matchDoc(doc, condition));
            if (key === "$and" ? !matches.every(Boolean) : !matches.some(Boolean))
            {
                return false;
            }
            continue;
        }

        if (key === "$nor")
        {
            if (!Array.isArray(value) || value.length === 0)
            {
                throw new Error("Mock engine rejects MongoDB invalid $nor array");
            }

            const matches = value.map((condition) => matchDoc(doc, condition));
            if (matches.some(Boolean))
            {
                return false;
            }
            continue;
        }

        if (key === "$expr")
        {
            if (!evalExpr(doc, value))
            {
                return false;
            }
            continue;
        }

        const documentValue = getNestedVal(doc, key);
        if (!matchValueOrArray(documentValue, value))
        {
            return false;
        }
    }

    return true;
}
