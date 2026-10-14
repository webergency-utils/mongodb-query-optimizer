import { isPlainObject } from '../utils.js';

function isFieldPath(value: unknown): value is string
{
    return (
        typeof value === 'string'
        && value.startsWith('$')
        && !value.startsWith('$$')
        && value.length > 1
    );
}

function unwrapLiteral( value: unknown ): unknown
{
    if( isPlainObject( value ) && Object.keys( value ).length === 1 && '$literal' in value )
    {
        return value.$literal;
    }

    return value;
}

function isLiteral(value: unknown): boolean
{
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol')
    {
        return false;
    }

    if (isPlainObject(value) && Object.keys(value).length === 1 && '$literal' in value)
    {
        const lit = value.$literal;
        return lit !== undefined && typeof lit !== 'function' && typeof lit !== 'symbol';
    }

    if (typeof value === 'string')
    {
        return !value.startsWith('$');
    }

    if (Array.isArray(value))
    {
        return value.every(isLiteral);
    }

    if (isPlainObject(value))
    {
        for (const [k, v] of Object.entries(value))
        {
            if (k.startsWith('$') || !isLiteral(v))
            {
                return false;
            }
        }
        return true;
    }

    return true;
}

function normalizeBinaryComparison(
    operator: string,
    args: unknown[],
): Record<string, any> | null
{
    if (!Array.isArray(args) || args.length !== 2)
    {
        return null;
    }

    const [arg0, arg1] = args;
    const arg0IsPath = isFieldPath(arg0);
    const arg1IsPath = isFieldPath(arg1);

    if (arg0IsPath === arg1IsPath)
    {
        // Either both are paths or neither is a path
        return null;
    }

    if (arg0IsPath && isLiteral(arg1))
    {
        const field = arg0.slice(1);
        const lit1 = unwrapLiteral(arg1);
        switch (operator)
        {
            case '$eq':
                return isPlainObject(lit1) && Object.keys(lit1).some((k) => k.startsWith('$'))
                    ? { [field]: { $eq: lit1 } }
                    : { [field]: lit1 };
            case '$ne':
                return { [field]: { $ne: lit1 } };
            case '$gt':
                return { [field]: { $gt: lit1 } };
            case '$gte':
                return { [field]: { $gte: lit1 } };
            case '$lt':
                return { [field]: { $lt: lit1 } };
            case '$lte':
                return { [field]: { $lte: lit1 } };
            case '$in':
                return Array.isArray(lit1)
                    ? { [field]: { $in: lit1.map(unwrapLiteral) } }
                    : null;
            default:
                return null;
        }
    }

    if (arg1IsPath && isLiteral(arg0))
    {
        const field = arg1.slice(1);
        const lit0 = unwrapLiteral(arg0);
        switch (operator)
        {
            case '$eq':
                return isPlainObject(lit0) && Object.keys(lit0).some((k) => k.startsWith('$'))
                    ? { [field]: { $eq: lit0 } }
                    : { [field]: lit0 };
            case '$ne':
                return { [field]: { $ne: lit0 } };
            case '$gt':
                // arg0 > field <=> field < arg0
                return { [field]: { $lt: lit0 } };
            case '$gte':
                // arg0 >= field <=> field <= arg0
                return { [field]: { $lte: lit0 } };
            case '$lt':
                // arg0 < field <=> field > arg0
                return { [field]: { $gt: lit0 } };
            case '$lte':
                // arg0 <= field <=> field >= arg0
                return { [field]: { $gte: lit0 } };
            default:
                return null;
        }
    }

    return null;
}

export function proveExprToNativeMatch(
    exprObject: unknown,
): Record<string, any> | null
{
    if (!isPlainObject(exprObject))
    {
        return null;
    }

    const keys = Object.keys(exprObject);
    if (keys.length !== 1)
    {
        return null;
    }

    const operator = keys[0]!;
    const value = exprObject[operator];

    if (operator === '$and')
    {
        if (!Array.isArray(value) || value.length === 0)
        {
            return null;
        }

        const merged: Record<string, any> = {};

        for (const item of value)
        {
            const normalizedItem = proveExprToNativeMatch(item);
            if (!normalizedItem)
            {
                return null;
            }

            for (const [field, condition] of Object.entries(normalizedItem))
            {
                if (!(field in merged))
                {
                    merged[field] = condition;
                }
                else
                {
                    const existing = merged[field];
                    if (
                        !field.startsWith('$')
                        && isPlainObject(existing)
                        && isPlainObject(condition)
                        && Object.keys(existing).every((k) => k.startsWith('$'))
                        && Object.keys(condition).every((k) => k.startsWith('$'))
                    )
                    {
                        merged[field] = { ...existing, ...condition };
                    }
                    else
                    {
                        return null;
                    }
                }
            }
        }

        return merged;
    }

    if (operator === '$or' || operator === '$nor')
    {
        if (!Array.isArray(value) || value.length === 0)
        {
            return null;
        }

        const branches: Record<string, any>[] = [];
        for (const item of value)
        {
            const normalizedBranch = proveExprToNativeMatch(item);
            if (!normalizedBranch)
            {
                return null;
            }

            branches.push(normalizedBranch);
        }

        return { [operator]: branches };
    }

    if (operator === '$regexMatch')
    {
        if (!isPlainObject(value))
        {
            return null;
        }

        const specKeys = Object.keys(value);
        if (
            !isFieldPath(value.input)
            || !('regex' in value)
            || specKeys.some((k) => k !== 'input' && k !== 'regex' && k !== 'options')
        )
        {
            return null;
        }

        const rawRegex = unwrapLiteral(value.regex);
        if (typeof rawRegex !== 'string' && !(rawRegex instanceof RegExp))
        {
            return null;
        }

        if ('options' in value)
        {
            const rawOptions = unwrapLiteral(value.options);
            if (typeof rawOptions !== 'string')
            {
                return null;
            }

            return {
                [value.input.slice(1)]: {
                    $regex: rawRegex,
                    $options: rawOptions,
                },
            };
        }

        return {
            [value.input.slice(1)]: {
                $regex: rawRegex,
            },
        };
    }

    if (operator === '$not')
    {
        const inner = Array.isArray(value) && value.length === 1 ? value[0] : value;
        if (!isPlainObject(inner))
        {
            return null;
        }

        const innerKeys = Object.keys(inner);
        if (innerKeys.length !== 1)
        {
            return null;
        }

        const innerOp = innerKeys[0]!;
        const innerArgs = inner[innerOp];

        if (innerOp === '$not')
        {
            const nestedOperand = Array.isArray(innerArgs) && innerArgs.length === 1
                ? innerArgs[0]
                : innerArgs;

            if (isPlainObject(nestedOperand))
            {
                return proveExprToNativeMatch(nestedOperand);
            }

            return null;
        }

        if (!Array.isArray(innerArgs) || innerArgs.length !== 2)
        {
            return null;
        }

        if (innerOp === '$eq')
        {
            return normalizeBinaryComparison('$ne', innerArgs);
        }

        if (innerOp === '$ne')
        {
            return normalizeBinaryComparison('$eq', innerArgs);
        }

        if (innerOp === '$in')
        {
            const [arg0, arg1] = innerArgs;
            const lit1 = unwrapLiteral(arg1);
            if (isFieldPath(arg0) && isLiteral(arg1) && Array.isArray(lit1))
            {
                return {
                    [arg0.slice(1)]: {
                        $nin: lit1.map(unwrapLiteral),
                    },
                };
            }
        }

        return null;
    }

    return normalizeBinaryComparison(operator, value);
}

function containsVariableReference( value: unknown, varToken: string ): boolean
{
    if( typeof value === 'string' )
    {
        return value === varToken || value.startsWith( `${ varToken }.` );
    }

    if( Array.isArray( value ))
    {
        return value.some(( item ) => containsVariableReference( item, varToken ));
    }

    if( isPlainObject( value ))
    {
        return Object.values( value ).some(( item ) => containsVariableReference( item, varToken ));
    }

    return false;
}

export function proveCorrelatedLookupEqualityNormalization(
    stage: unknown
): Record<string, any> | null
{
    if(
        !isPlainObject( stage )
        || Object.keys( stage ).length !== 1
        || !isPlainObject( stage.$lookup )
    )
    {
        return null;
    }

    const spec = stage.$lookup as Record<string, any>;
    if(
        typeof spec.from !== 'string'
        || spec.from.length === 0
        || typeof spec.as !== 'string'
        || spec.as.length === 0
        || 'localField' in spec
        || 'foreignField' in spec
        || !isPlainObject( spec.let )
        || !Array.isArray( spec.pipeline )
        || spec.pipeline.length === 0
    )
    {
        return null;
    }

    const firstStage = spec.pipeline[ 0 ];
    if(
        !isPlainObject( firstStage )
        || Object.keys( firstStage ).length !== 1
        || !isPlainObject( firstStage.$match )
        || Object.keys( firstStage.$match ).length !== 1
        || !isPlainObject( firstStage.$match.$expr )
    )
    {
        return null;
    }

    const exprObj = firstStage.$match.$expr as Record<string, any>;
    if(
        Object.keys( exprObj ).length !== 1
        || !Array.isArray( exprObj.$eq )
        || exprObj.$eq.length !== 2
    )
    {
        return null;
    }

    const [ left, right ] = exprObj.$eq;
    const leftIsField = isFieldPath( left );
    const rightIsField = isFieldPath( right );

    if( leftIsField === rightIsField )
    {
        return null;
    }

    const foreignOperand = ( leftIsField ? left : right ) as string;
    const varOperand = leftIsField ? right : left;

    if( typeof varOperand !== 'string' || !varOperand.startsWith( '$$' ) || varOperand.length <= 2 )
    {
        return null;
    }

    const varName = varOperand.slice( 2 );
    const letBinding = ( spec.let as Record<string, unknown> )[ varName ];

    if( !isFieldPath( letBinding ))
    {
        return null;
    }

    const localField = letBinding.slice( 1 );
    const foreignField = foreignOperand.slice( 1 );
    const remainingPipeline = spec.pipeline.slice( 1 );
    const varStillUsed = containsVariableReference( remainingPipeline, varOperand );

    const nextLet: Record<string, unknown> = {};
    for( const [ k, v ] of Object.entries( spec.let ))
    {
        if( k !== varName || varStillUsed )
        {
            nextLet[ k ] = v;
        }
    }

    const hasRemainingLet = Object.keys( nextLet ).length > 0;
    const nextLookup: Record<string, any> = {
        from: spec.from,
        localField,
        foreignField,
        ...( hasRemainingLet ? { let: nextLet } : {} ),
        ...( remainingPipeline.length > 0 || hasRemainingLet ? { pipeline: remainingPipeline } : {} ),
        as: spec.as
    };

    return { $lookup: nextLookup };
}
