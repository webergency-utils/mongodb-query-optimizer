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
                    const newDoc = { ...doc };
                    for (const [key, value] of Object.entries(val))
                    {
                        setNestedVal(newDoc, key, evalExpr(doc, value));
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
                        const leftValue = getNestedVal(left, key);
                        const rightValue = getNestedVal(right, key);
                        if (leftValue < rightValue)
                        {
                            return (direction as number) === -1 ? 1 : -1;
                        }
                        if (leftValue > rightValue)
                        {
                            return (direction as number) === -1 ? -1 : 1;
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
        if (!current[part])
        {
            current[part] = {};
        }
        current = current[part];
    }

    current[parts[parts.length - 1]!] = value;
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

function evalExpr(doc: any, expression: any): any
{
    if (typeof expression === "string")
    {
        if (expression.startsWith("$") && !expression.startsWith("$$"))
        {
            return getNestedVal(doc, expression.slice(1));
        }
        return expression;
    }
    if (!expression || typeof expression !== "object")
    {
        return expression;
    }
    if (Array.isArray(expression))
    {
        return expression.map((value) => evalExpr(doc, value));
    }

    const keys = Object.keys(expression);
    if (keys.length === 0)
    {
        return {};
    }

    const operator = keys[0]!;
    if (operator.startsWith("$"))
    {
        const value = expression[operator];
        if (operator === "$sum" || operator === "$add")
        {
            const values = Array.isArray(value)
                ? value.map((entry) => evalExpr(doc, entry))
                : [evalExpr(doc, value)];
            return values.reduce(
                (sum, entry) => sum + (typeof entry === "number" ? entry : 0),
                0,
            );
        }
        if (operator === "$gt")
        {
            const values = value.map((entry: any) => evalExpr(doc, entry));
            return values[0] > values[1];
        }
        if (operator === "$gte")
        {
            const values = value.map((entry: any) => evalExpr(doc, entry));
            return values[0] >= values[1];
        }
        if (operator === "$lt")
        {
            const values = value.map((entry: any) => evalExpr(doc, entry));
            return values[0] < values[1];
        }
        if (operator === "$lte")
        {
            const values = value.map((entry: any) => evalExpr(doc, entry));
            return values[0] <= values[1];
        }
        if (operator === "$eq")
        {
            const values = value.map((entry: any) => evalExpr(doc, entry));
            return values[0] === values[1];
        }
        if (operator === "$ne")
        {
            const values = value.map((entry: any) => evalExpr(doc, entry));
            return values[0] !== values[1];
        }
        if (operator === "$not")
        {
            const values = Array.isArray(value)
                ? value.map((entry) => evalExpr(doc, entry))
                : [evalExpr(doc, value)];
            return !values[0];
        }
        if (operator === "$and" || operator === "$or")
        {
            const values = value.map((entry: any) => evalExpr(doc, entry));
            return operator === "$and"
                ? values.every(Boolean)
                : values.some(Boolean);
        }
        if (operator === "$multiply")
        {
            const values = Array.isArray(value)
                ? value.map((entry) => evalExpr(doc, entry))
                : [evalExpr(doc, value)];
            return values.reduce(
                (product, entry) => product * (typeof entry === "number" ? entry : 0),
                1,
            );
        }
        if (operator === "$subtract")
        {
            const values = value.map((entry: any) => evalExpr(doc, entry));
            return (typeof values[0] === "number" ? values[0] : 0) - (typeof values[1] === "number" ? values[1] : 0);
        }
        if (operator === "$divide")
        {
            const values = value.map((entry: any) => evalExpr(doc, entry));
            return values[1] !== 0 ? (values[0] / values[1]) : null;
        }
        if (operator === "$toUpper")
        {
            const v = evalExpr(doc, value);
            return typeof v === "string" ? v.toUpperCase() : v;
        }
        if (operator === "$toLower")
        {
            const v = evalExpr(doc, value);
            return typeof v === "string" ? v.toLowerCase() : v;
        }
        if (operator === "$concat")
        {
            const values = Array.isArray(value)
                ? value.map((entry) => evalExpr(doc, entry))
                : [evalExpr(doc, value)];
            return values.join("");
        }
        if (operator === "$size")
        {
            const arrayVal = evalExpr(doc, value);
            return Array.isArray(arrayVal) ? arrayVal.length : 0;
        }
        if (operator === "$ifNull")
        {
            const values = Array.isArray(value)
                ? value.map((entry) => evalExpr(doc, entry))
                : [evalExpr(doc, value)];
            return values[0] !== null && values[0] !== undefined ? values[0] : values[1];
        }
        if (operator === "$function")
        {
            const { body, args } = value;
            const evaluatedArgs = Array.isArray(args)
                ? args.map((argument) => evalExpr(doc, argument))
                : [];
            const callable = typeof body === "function"
                ? body
                : eval(`(${body})`);
            return callable(...evaluatedArgs);
        }
    }

    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(expression))
    {
        result[key] = evalExpr(doc, value);
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
