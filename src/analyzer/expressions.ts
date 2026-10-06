import {
    DocumentBinding,
    ExpressionSummary,
    ScopedDependencies,
    SemanticAnalysisContext,
    SemanticScope,
} from './types';
import {
    joinDeterminism,
    joinErrors,
} from './semantics';
import { isPlainObject } from '../utils.js';

const BUILTIN_NON_DOCUMENT_VARIABLES = new Set([
    'CLUSTER_TIME',
    'DESCEND',
    'KEEP',
    'NOW',
    'PRUNE',
    'REMOVE',
    'SEARCH_META',
]);

const KNOWN_EXPRESSION_OPERATORS = new Set([
    '$abs',
    '$acos',
    '$acosh',
    '$add',
    '$allElementsTrue',
    '$and',
    '$anyElementTrue',
    '$arrayElemAt',
    '$arrayToObject',
    '$asin',
    '$asinh',
    '$atan',
    '$atan2',
    '$atanh',
    '$avg',
    '$binarySize',
    '$bitAnd',
    '$bitNot',
    '$bitOr',
    '$bitXor',
    '$bsonSize',
    '$ceil',
    '$cmp',
    '$concat',
    '$concatArrays',
    '$cond',
    '$convert',
    '$cos',
    '$cosh',
    '$dateAdd',
    '$dateDiff',
    '$dateFromParts',
    '$dateFromString',
    '$dateSubtract',
    '$dateToParts',
    '$dateToString',
    '$dateTrunc',
    '$dayOfMonth',
    '$dayOfWeek',
    '$dayOfYear',
    '$degreesToRadians',
    '$denseRank',
    '$derivative',
    '$documentNumber',
    '$eq',
    '$exp',
    '$first',
    '$firstN',
    '$floor',
    '$gt',
    '$gte',
    '$hour',
    '$ifNull',
    '$in',
    '$indexOfArray',
    '$indexOfBytes',
    '$indexOfCP',
    '$integral',
    '$isArray',
    '$isNumber',
    '$isoDayOfWeek',
    '$isoWeek',
    '$isoWeekYear',
    '$last',
    '$lastN',
    '$linearFill',
    '$ln',
    '$locf',
    '$log',
    '$log10',
    '$lt',
    '$lte',
    '$max',
    '$maxN',
    '$median',
    '$mergeObjects',
    '$meta',
    '$millisecond',
    '$min',
    '$minN',
    '$minute',
    '$month',
    '$multiply',
    '$ne',
    '$not',
    '$objectToArray',
    '$or',
    '$percentile',
    '$pow',
    '$push',
    '$radiansToDegrees',
    '$range',
    '$rank',
    '$regexFind',
    '$regexFindAll',
    '$regexMatch',
    '$replaceAll',
    '$replaceOne',
    '$reverseArray',
    '$round',
    '$second',
    '$setDifference',
    '$setEquals',
    '$setIntersection',
    '$setIsSubset',
    '$setUnion',
    '$shift',
    '$sin',
    '$sinh',
    '$size',
    '$slice',
    '$sortArray',
    '$split',
    '$sqrt',
    '$stdDevPop',
    '$stdDevSamp',
    '$strcasecmp',
    '$strLenBytes',
    '$strLenCP',
    '$substr',
    '$substrBytes',
    '$substrCP',
    '$subtract',
    '$sum',
    '$switch',
    '$tan',
    '$tanh',
    '$toBool',
    '$toDate',
    '$toDecimal',
    '$toDouble',
    '$toInt',
    '$toLong',
    '$toLower',
    '$toObjectId',
    '$toString',
    '$toUpper',
    '$trim',
    '$trunc',
    '$type',
    '$week',
    '$year',
    '$zip',
]);

KNOWN_EXPRESSION_OPERATORS.add('$divide');
KNOWN_EXPRESSION_OPERATORS.add('$mod');

type ExpressionOperandValidator = (operand: unknown) => boolean;

const VALIDATED_TOTAL_EXPRESSION_OPERATORS = new Map<
    string,
    ExpressionOperandValidator
>([
    ['$eq', isBinaryOperand],
    ['$ne', isBinaryOperand],
    ['$gt', isBinaryOperand],
    ['$gte', isBinaryOperand],
    ['$lt', isBinaryOperand],
    ['$lte', isBinaryOperand],
    ['$cmp', isBinaryOperand],
    ['$and', isLogicalOperand],
    ['$or', isLogicalOperand],
    ['$not', isUnaryOperand],
    ['$ifNull', isIfNullOperand],
]);

export function createDependencies(): ScopedDependencies
{
    return {
        local: new Set(),
        foreign: new Set(),
        element: new Set(),
        variables: new Map(),
        unknown: false,
    };
}

export function cloneDependencies(
    dependencies: ScopedDependencies,
): ScopedDependencies
{
    return {
        local: new Set(dependencies.local),
        foreign: new Set(dependencies.foreign),
        element: new Set(dependencies.element),
        variables: new Map(
            Array.from(dependencies.variables, ([name, paths]) => [
                name,
                new Set(paths),
            ]),
        ),
        unknown: dependencies.unknown,
    };
}

export function mergeDependencies(
    target: ScopedDependencies,
    source: ScopedDependencies,
): void
{
    for (const path of source.local)
    {
        target.local.add(path);
    }
    for (const path of source.foreign)
    {
        target.foreign.add(path);
    }
    for (const path of source.element)
    {
        target.element.add(path);
    }
    for (const [name, paths] of source.variables)
    {
        let targetPaths = target.variables.get(name);
        if (!targetPaths)
        {
            targetPaths = new Set();
            target.variables.set(name, targetPaths);
        }
        for (const path of paths)
        {
            targetPaths.add(path);
        }
    }
    target.unknown ||= source.unknown;
}

function addScopedPath(
    dependencies: ScopedDependencies,
    scope: SemanticScope,
    path: string,
): void
{
    dependencies[scope].add(path);
}

function addVariablePath(
    dependencies: ScopedDependencies,
    variable: string,
    path: string,
): void
{
    dependencies.variables.set(variable, new Set([path]));
}

function emptyExpressionSummary(): ExpressionSummary
{
    return {
        dependencies: createDependencies(),
        determinism: 'deterministic',
        errors: 'none-known',
        unknown: false,
    };
}

function unknownExpressionSummary(
    context: SemanticAnalysisContext,
): ExpressionSummary
{
    const summary = emptyExpressionSummary();
    addScopedPath(summary.dependencies, context.documentScope, '*');
    summary.dependencies.unknown = true;
    summary.determinism = 'unknown';
    summary.errors = 'unknown';
    summary.unknown = true;
    return summary;
}

function mergeExpressionSummary(
    target: ExpressionSummary,
    source: ExpressionSummary,
): void
{
    mergeDependencies(target.dependencies, source.dependencies);
    target.determinism = joinDeterminism(
        target.determinism,
        source.determinism,
    );
    target.errors = joinErrors(target.errors, source.errors);
    target.unknown ||= source.unknown;
}

function hasExactArrayArity(operand: unknown, arity: number): boolean
{
    return Array.isArray(operand) && operand.length === arity;
}

function isBinaryOperand(operand: unknown): boolean
{
    return hasExactArrayArity(operand, 2);
}

function isLogicalOperand(operand: unknown): boolean
{
    return Array.isArray(operand);
}

function isUnaryOperand(operand: unknown): boolean
{
    return hasExactArrayArity(operand, 1);
}

function isIfNullOperand(operand: unknown): boolean
{
    return Array.isArray(operand) && operand.length >= 2;
}

function isRandOperand(operand: unknown): boolean
{
    return isPlainObject(operand) && Object.keys(operand).length === 0;
}

function parseVariableReference(reference: string): {
    readonly name: string;
    readonly path: string;
}
{
    const withoutPrefix = reference.slice(2);
    const separator = withoutPrefix.indexOf('.');
    if (separator === -1)
    {
        return { name: withoutPrefix, path: '*' };
    }

    return {
        name: withoutPrefix.slice(0, separator),
        path: withoutPrefix.slice(separator + 1) || '*',
    };
}

function resolveBinding(
    binding: DocumentBinding,
    path: string,
    dependencies: ScopedDependencies,
): void
{
    if (binding.unknown)
    {
        addScopedPath(dependencies, binding.scope, '*');
        dependencies.unknown = true;
        return;
    }

    if (binding.wholeDocument)
    {
        addScopedPath(dependencies, binding.scope, path);
        return;
    }

    if (binding.path)
    {
        addScopedPath(
            dependencies,
            binding.scope,
            path === '*' ? binding.path : `${binding.path}.${path}`,
        );
        return;
    }

    addScopedPath(dependencies, binding.scope, "*");
    dependencies.unknown = true;
}

function analyzeString(
    value: string,
    context: SemanticAnalysisContext,
): ExpressionSummary
{
    const summary = emptyExpressionSummary();
    if (!value.startsWith("$"))
    {
        return summary;
    }

    if (!value.startsWith("$$"))
    {
        const path = value.slice(1);
        if (path.length === 0)
        {
            return unknownExpressionSummary(context);
        }
        addScopedPath(summary.dependencies, context.documentScope, path);
        return summary;
    }

    const { name, path } = parseVariableReference(value);
    if (name === "ROOT" || name === "CURRENT")
    {
        addScopedPath(summary.dependencies, context.documentScope, path);
        return summary;
    }

    if (BUILTIN_NON_DOCUMENT_VARIABLES.has(name))
    {
        return summary;
    }

    addVariablePath(summary.dependencies, name, path);
    const binding = context.variables?.get(name);
    if (binding)
    {
        resolveBinding(binding, path, summary.dependencies);
    }
    else
    {
        addScopedPath(summary.dependencies, context.documentScope, "*");
        summary.dependencies.unknown = true;
        summary.unknown = true;
        summary.determinism = "unknown";
        summary.errors = "unknown";
    }

    return summary;
}

function inferBinding(
    expression: unknown,
    context: SemanticAnalysisContext,
): DocumentBinding
{
    if (typeof expression === "string" && expression.startsWith("$"))
    {
        if (!expression.startsWith("$$"))
        {
            return {
                scope: context.documentScope,
                path: expression.slice(1),
            };
        }

        const { name, path } = parseVariableReference(expression);
        if (name === "ROOT" || name === "CURRENT")
        {
            return path === "*"
                ? { scope: context.documentScope, wholeDocument: true }
                : { scope: context.documentScope, path };
        }

        const binding = context.variables?.get(name);
        if (binding)
        {
            if (path === "*")
            {
                return binding;
            }
            if (binding.path)
            {
                return {
                    scope: binding.scope,
                    path: `${binding.path}.${path}`,
                };
            }
            if (binding.wholeDocument)
            {
                return { scope: binding.scope, path };
            }
        }
    }

    return {
        scope: context.documentScope,
        unknown: true,
    };
}

function analyzeGetField(
    operand: unknown,
    context: SemanticAnalysisContext,
): ExpressionSummary
{
    const summary = emptyExpressionSummary();
    summary.errors = "may-error";
    let field: unknown = operand;
    let input: unknown = "$$CURRENT";

    if (isPlainObject(operand))
    {
        field = operand.field;
        input = "input" in operand ? operand.input : "$$CURRENT";
    }

    const narrowsCurrentDocument = input === "$$CURRENT" || input === "$$ROOT";
    if (!narrowsCurrentDocument)
    {
        const inputSummary = analyzeExpression(input, context);
        mergeExpressionSummary(summary, inputSummary);
    }
    const inputBinding = inferBinding(input, context);

    if (typeof field === "string" && !field.startsWith("$"))
    {
        resolveBinding(inputBinding, field, summary.dependencies);
        return summary;
    }

    if (field === undefined)
    {
        return unknownExpressionSummary(context);
    }

    mergeExpressionSummary(summary, analyzeExpression(field, context));
    resolveBinding(inputBinding, "*", summary.dependencies);
    return summary;
}

function withVariables(
    context: SemanticAnalysisContext,
    variables: ReadonlyMap<string, DocumentBinding>,
): SemanticAnalysisContext
{
    return {
        ...context,
        variables,
    };
}

function analyzeLet(
    operand: unknown,
    context: SemanticAnalysisContext,
): ExpressionSummary
{
    if (!isPlainObject(operand) || !isPlainObject(operand.vars) || !("in" in operand))
    {
        return unknownExpressionSummary(context);
    }

    const summary = emptyExpressionSummary();
    const bindings = new Map(context.variables ?? []);
    for (const [name, expression] of Object.entries(operand.vars))
    {
        mergeExpressionSummary(summary, analyzeExpression(expression, context));
        bindings.set(name, inferBinding(expression, context));
    }
    mergeExpressionSummary(
        summary,
        analyzeExpression(operand.in, withVariables(context, bindings)),
    );
    summary.errors = joinErrors(summary.errors, "may-error");
    return summary;
}

function analyzeElementOperator(
    operator: "$map" | "$filter",
    operand: unknown,
    context: SemanticAnalysisContext,
): ExpressionSummary
{
    if (!isPlainObject(operand) || !("input" in operand))
    {
        return unknownExpressionSummary(context);
    }

    const summary = analyzeExpression(operand.input, context);
    const variableName = typeof operand.as === "string"
        ? operand.as
        : "this";
    const bindings = new Map(context.variables ?? []);
    bindings.set(variableName, inferBinding(operand.input, context));

    if (operator === "$map")
    {
        if (!("in" in operand))
        {
            mergeExpressionSummary(summary, unknownExpressionSummary(context));
        }
        else
        {
            mergeExpressionSummary(
                summary,
                analyzeExpression(operand.in, withVariables(context, bindings)),
            );
        }
    }
    else if ("cond" in operand)
    {
        mergeExpressionSummary(
            summary,
            analyzeExpression(operand.cond, withVariables(context, bindings)),
        );
    }
    else
    {
        mergeExpressionSummary(summary, unknownExpressionSummary(context));
    }

    if ("limit" in operand)
    {
        mergeExpressionSummary(summary, analyzeExpression(operand.limit, context));
    }

    summary.errors = joinErrors(summary.errors, "may-error");
    return summary;
}

function analyzeReduce(
    operand: unknown,
    context: SemanticAnalysisContext,
): ExpressionSummary
{
    if (
        !isPlainObject(operand)
        || !("input" in operand)
        || !("initialValue" in operand)
        || !("in" in operand)
    )
    {
        return unknownExpressionSummary(context);
    }

    const summary = analyzeExpression(operand.input, context);
    mergeExpressionSummary(
        summary,
        analyzeExpression(operand.initialValue, context),
    );

    const bindings = new Map(context.variables ?? []);
    bindings.set("this", inferBinding(operand.input, context));
    bindings.set("value", {
        scope: context.documentScope,
        unknown: true,
    });
    mergeExpressionSummary(
        summary,
        analyzeExpression(operand.in, withVariables(context, bindings)),
    );
    summary.errors = joinErrors(summary.errors, "may-error");
    return summary;
}

function analyzeUserCode(
    operator: "$function" | "$accumulator",
    operand: unknown,
    context: SemanticAnalysisContext,
): ExpressionSummary
{
    const summary = emptyExpressionSummary();
    if (!isPlainObject(operand))
    {
        mergeExpressionSummary(summary, unknownExpressionSummary(context));
    }
    else if (operator === "$function" && Array.isArray(operand.args))
    {
        mergeExpressionSummary(summary, analyzeExpression(operand.args, context));
    }
    else if (
        operator === "$accumulator"
        && Array.isArray(operand.initArgs)
        && Array.isArray(operand.accumulateArgs)
    )
    {
        mergeExpressionSummary(
            summary,
            analyzeExpression(operand.initArgs, context),
        );
        mergeExpressionSummary(
            summary,
            analyzeExpression(operand.accumulateArgs, context),
        );
    }
    else
    {
        mergeExpressionSummary(summary, unknownExpressionSummary(context));
    }

    summary.determinism = summary.determinism === "unknown"
        ? "unknown"
        : "volatile";
    summary.errors = summary.errors === "unknown"
        ? "unknown"
        : "may-error";
    return summary;
}

function analyzeOperator(
    operator: string,
    operand: unknown,
    context: SemanticAnalysisContext,
): ExpressionSummary
{
    if (operator === "$literal")
    {
        return emptyExpressionSummary();
    }

    if (operator === "$getField")
    {
        return analyzeGetField(operand, context);
    }

    if (operator === "$let")
    {
        return analyzeLet(operand, context);
    }

    if (operator === "$map" || operator === "$filter")
    {
        return analyzeElementOperator(operator, operand, context);
    }

    if (operator === "$reduce")
    {
        return analyzeReduce(operand, context);
    }

    if (operator === "$rand")
    {
        const summary = analyzeExpression(operand, context);
        summary.determinism = joinDeterminism(
            summary.determinism,
            "volatile",
        );
        if (!isRandOperand(operand))
        {
            summary.errors = joinErrors(summary.errors, "may-error");
        }
        return summary;
    }

    if (operator === "$function" || operator === "$accumulator")
    {
        return analyzeUserCode(operator, operand, context);
    }

    const summary = analyzeExpression(operand, context);
    if (!KNOWN_EXPRESSION_OPERATORS.has(operator))
    {
        addScopedPath(summary.dependencies, context.documentScope, "*");
        summary.dependencies.unknown = true;
        summary.determinism = "unknown";
        summary.errors = "unknown";
        summary.unknown = true;
        return summary;
    }

    const validator = VALIDATED_TOTAL_EXPRESSION_OPERATORS.get(operator);
    if (!validator || !validator(operand))
    {
        summary.errors = joinErrors(summary.errors, "may-error");
    }

    return summary;
}

export function analyzeExpression(
    expression: unknown,
    context: SemanticAnalysisContext = { documentScope: "local" },
): ExpressionSummary
{
    if (typeof expression === "string")
    {
        return analyzeString(expression, context);
    }

    if (
        expression === null
        || expression === undefined
        || typeof expression !== "object"
    )
    {
        return emptyExpressionSummary();
    }

    if (Array.isArray(expression))
    {
        const summary = emptyExpressionSummary();
        for (const item of expression)
        {
            mergeExpressionSummary(summary, analyzeExpression(item, context));
        }
        return summary;
    }

    if (!isPlainObject(expression))
    {
        return emptyExpressionSummary();
    }

    const entries = Object.entries(expression);
    const operatorEntries = entries.filter(([key]) => key.startsWith("$"));
    if (operatorEntries.length === 0)
    {
        const summary = emptyExpressionSummary();
        for (const [, value] of entries)
        {
            mergeExpressionSummary(summary, analyzeExpression(value, context));
        }
        return summary;
    }

    if (entries.length !== 1 || operatorEntries.length !== 1)
    {
        const summary = emptyExpressionSummary();
        for (const [, value] of entries)
        {
            mergeExpressionSummary(summary, analyzeExpression(value, context));
        }
        mergeExpressionSummary(summary, unknownExpressionSummary(context));
        return summary;
    }

    return analyzeOperator(
        operatorEntries[0]![0],
        operatorEntries[0]![1],
        context,
    );
}
