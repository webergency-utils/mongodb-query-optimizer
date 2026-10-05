import {
    CardinalityEffect,
    ChildPipelineKind,
    ChildPipelineSummary,
    Determinism,
    DocumentBinding,
    ErrorPossibility,
    ObservableSemantics,
    OrderEffect,
    PipelineSemantics,
    ScopedDependencies,
    SemanticAnalysisContext,
    StageSemantics,
    StreamProvenance,
} from './types';
import {
    analyzeExpression,
    createDependencies,
    mergeDependencies,
} from './expressions';
import { analyzeFilter } from './filters';
import { analyzeProjection } from './projections';

export function joinCardinality(
    left: CardinalityEffect,
    right: CardinalityEffect,
): CardinalityEffect
{
    if (left === right)
    {
        return left;
    }

    if (left === 'unknown' || right === 'unknown')
    {
        return 'unknown';
    }

    if (left === 'preserves')
    {
        return right;
    }

    if (right === 'preserves')
    {
        return left;
    }

    const pair = new Set([left, right]);
    if (
        pair.has('filters-and-expands')
        && (pair.has('filters') || pair.has('expands'))
    )
    {
        return 'filters-and-expands';
    }

    if (pair.has('filters') && pair.has('expands'))
    {
        return 'filters-and-expands';
    }

    return 'unknown';
}

export function joinOrder(left: OrderEffect, right: OrderEffect): OrderEffect
{
    if (left === right)
    {
        return left;
    }

    if (left === 'unknown' || right === 'unknown')
    {
        return 'unknown';
    }

    if (left === 'preserves')
    {
        return right;
    }

    if (right === 'preserves')
    {
        return left;
    }

    if (left === 'destroys' || right === 'destroys')
    {
        return 'destroys';
    }

    return 'unknown';
}

export function joinProvenance(
    left: StreamProvenance,
    right: StreamProvenance,
): StreamProvenance
{
    if (left === right)
    {
        return left;
    }

    if (left === 'unknown' || right === 'unknown')
    {
        return 'unknown';
    }

    if (left === 'mixed' || right === 'mixed')
    {
        return 'mixed';
    }

    const pair = new Set([left, right]);
    if (
        pair.has('local-and-foreign')
        && (pair.has('local') || pair.has('foreign'))
    )
    {
        return 'local-and-foreign';
    }

    return 'mixed';
}

export function joinDeterminism(
    left: Determinism,
    right: Determinism,
): Determinism
{
    if (left === 'unknown' || right === 'unknown')
    {
        return 'unknown';
    }

    if (left === 'volatile' || right === 'volatile')
    {
        return 'volatile';
    }

    return 'deterministic';
}

export function joinErrors(
    left: ErrorPossibility,
    right: ErrorPossibility,
): ErrorPossibility
{
    if (left === 'unknown' || right === 'unknown')
    {
        return 'unknown';
    }

    if (left === 'may-error' || right === 'may-error')
    {
        return 'may-error';
    }

    return 'none-known';
}

function isPlainObject(value: unknown): value is Record<string, unknown>
{
    if (value === null || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function scopeProvenance(scope: 'local' | 'foreign'): StreamProvenance
{
    return scope;
}

function normalizeContext(
    context?: Partial<SemanticAnalysisContext>,
): SemanticAnalysisContext
{
    const documentScope = context?.documentScope ?? 'local';
    return {
        documentScope,
        variables: context?.variables,
        elementPath: context?.elementPath,
        inputProvenance: context?.inputProvenance
            ?? scopeProvenance(documentScope),
    };
}

function observableFromStage(stage: StageSemantics): ObservableSemantics
{
    let cardinality = stage.cardinality;
    let order = stage.order;
    let provenance = stage.provenance;
    let determinism = stage.determinism;
    let errors = stage.errors;
    let unknown = stage.unknown;

    for (const child of stage.children)
    {
        cardinality = joinCardinality(
            cardinality,
            child.summary.observable.cardinality,
        );
        order = joinOrder(order, child.summary.observable.order);
        provenance = joinProvenance(
            provenance,
            child.summary.observable.provenance,
        );
        determinism = joinDeterminism(
            determinism,
            child.summary.observable.determinism,
        );
        errors = joinErrors(errors, child.summary.observable.errors);
        unknown ||= child.summary.observable.unknown;
    }

    return {
        cardinality,
        order,
        provenance,
        determinism,
        errors,
        unknown,
    };
}

function createStageSemantics(
    stage: unknown,
    index: number,
    operator: string,
    context: SemanticAnalysisContext,
): StageSemantics
{
    const provenance = context.inputProvenance!;
    const summary: StageSemantics = {
        index,
        stage,
        operator,
        dependencies: createDependencies(),
        writes: new Set(),
        modifies: new Set(),
        removes: new Set(),
        cardinality: 'preserves',
        order: 'preserves',
        provenance,
        determinism: 'deterministic',
        errors: 'none-known',
        unknown: false,
        malformed: false,
        children: [],
        observable: {
            cardinality: 'preserves',
            order: 'preserves',
            provenance,
            determinism: 'deterministic',
            errors: 'none-known',
            unknown: false,
        },
    };
    return summary;
}

function conservativeTop(
    stage: unknown,
    index: number,
    operator: string,
    context: SemanticAnalysisContext,
    malformed: boolean,
): StageSemantics
{
    const dependencies = createDependencies();
    dependencies[context.documentScope].add('*');
    dependencies.unknown = true;
    return {
        index,
        stage,
        operator,
        dependencies,
        writes: new Set(['?']),
        modifies: new Set(['?']),
        removes: new Set(['?']),
        cardinality: 'unknown',
        order: 'unknown',
        provenance: 'unknown',
        determinism: 'unknown',
        errors: 'unknown',
        unknown: true,
        malformed,
        children: [],
        observable: {
            cardinality: 'unknown',
            order: 'unknown',
            provenance: 'unknown',
            determinism: 'unknown',
            errors: 'unknown',
            unknown: true,
        },
    };
}

function applyExpression(
    stage: StageSemantics,
    expression: unknown,
    context: SemanticAnalysisContext,
): void
{
    const expressionSummary = analyzeExpression(expression, context);
    mergeDependencies(stage.dependencies, expressionSummary.dependencies);
    stage.determinism = joinDeterminism(
        stage.determinism,
        expressionSummary.determinism,
    );
    stage.errors = joinErrors(stage.errors, expressionSummary.errors);
    stage.unknown ||= expressionSummary.unknown;
}

function inferDocumentBinding(
    expression: unknown,
    context: SemanticAnalysisContext,
): DocumentBinding
{
    if (typeof expression !== 'string' || !expression.startsWith('$'))
    {
        return {
            scope: context.documentScope,
            unknown: true,
        };
    }

    if (!expression.startsWith('$$'))
    {
        return {
            scope: context.documentScope,
            path: expression.slice(1),
        };
    }

    const reference = expression.slice(2);
    const separator = reference.indexOf('.');
    const name = separator === -1
        ? reference
        : reference.slice(0, separator);
    const path = separator === -1
        ? undefined
        : reference.slice(separator + 1);

    if (name === 'ROOT' || name === 'CURRENT')
    {
        return path
            ? { scope: context.documentScope, path }
            : { scope: context.documentScope, wholeDocument: true };
    }

    const parent = context.variables?.get(name);
    if (!parent)
    {
        return {
            scope: context.documentScope,
            unknown: true,
        };
    }

    if (!path)
    {
        return parent;
    }

    if (parent.path)
    {
        return {
            scope: parent.scope,
            path: `${parent.path}.${path}`,
        };
    }

    if (parent.wholeDocument)
    {
        return {
            scope: parent.scope,
            path,
        };
    }

    return {
        scope: parent.scope,
        unknown: true,
    };
}

function resolveVariableDependencies(
    dependencies: ScopedDependencies,
    bindings: ReadonlyMap<string, DocumentBinding>,
): Set<string>
{
    const resolved = new Set<string>();
    for (const [name, paths] of dependencies.variables)
    {
        const binding = bindings.get(name);
        if (!binding)
        {
            resolved.add("*");
            continue;
        }

        for (const path of paths)
        {
            if (binding.unknown)
            {
                resolved.add("*");
            }
            else if (binding.path)
            {
                resolved.add(path === "*" ? binding.path : `${binding.path}.${path}`);
            }
            else if (binding.wholeDocument)
            {
                resolved.add(path);
            }
            else
            {
                resolved.add("*");
            }
        }
    }
    return resolved;
}

function addChild(
    stage: StageSemantics,
    kind: ChildPipelineKind,
    scope: "local" | "foreign",
    summary: PipelineSemantics,
    outerDependencies: Set<string>,
    foreignDependencies: Set<string>,
    name?: string,
): void
{
    const child: ChildPipelineSummary = {
        kind,
        scope,
        summary,
        outerDependencies,
        foreignDependencies,
        ...(name === undefined ? {} : { name }),
    };
    stage.children.push(child);
    mergeDependencies(stage.dependencies, summary.dependencies);
    stage.determinism = joinDeterminism(
        stage.determinism,
        summary.determinism,
    );
    stage.errors = joinErrors(stage.errors, summary.errors);
    stage.unknown ||= summary.unknown;
    stage.malformed ||= summary.malformed;
}

function analyzeMatchStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    if (!isPlainObject(value))
    {
        stage.malformed = true;
        return;
    }

    const filter = analyzeFilter(value, context);
    mergeDependencies(stage.dependencies, filter.dependencies);
    stage.cardinality = "filters";
    stage.determinism = filter.determinism;
    stage.errors = filter.errors;
    stage.unknown = filter.unknown;
    stage.malformed = filter.malformed;
}

function analyzeProjectStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    const projection = analyzeProjection(value);
    stage.projection = projection;
    if (!isPlainObject(value) || projection.unknown)
    {
        stage.malformed = true;
        return;
    }

    if (projection.mode === "exclusion")
    {
        stage.dependencies[context.documentScope].add("*");
    }
    else if (
        projection.mode === "inclusion"
        && projection.id === "default-included"
    )
    {
        stage.dependencies[context.documentScope].add("_id");
        stage.writes.add("_id");
    }

    for (const [path, expression] of Object.entries(value))
    {
        if (projection.includedPaths.has(path))
        {
            stage.dependencies[context.documentScope].add(path);
            stage.writes.add(path);
        }
        else if (projection.excludedPaths.has(path))
        {
            stage.removes.add(path);
        }
        else
        {
            stage.writes.add(path);
            stage.modifies.add(path);
            applyExpression(stage, expression, context);
        }
    }
}

function analyzeAddFieldsStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    const projection = analyzeProjection(value, "add-fields");
    stage.projection = projection;
    if (!isPlainObject(value) || projection.unknown)
    {
        stage.malformed = true;
        return;
    }

    for (const [path, expression] of Object.entries(value))
    {
        stage.writes.add(path);
        stage.modifies.add(path);
        applyExpression(stage, expression, context);
    }
}

function analyzeUnsetStage(
    value: unknown,
    stage: StageSemantics,
): void
{
    const fields = Array.isArray(value) ? value : [value];
    if (
        fields.length === 0
        || fields.some((field) => typeof field !== "string" || field.length === 0)
    )
    {
        stage.malformed = true;
        return;
    }

    for (const field of fields)
    {
        stage.removes.add(field as string);
    }
}

function analyzeSortStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    if (!isPlainObject(value) || Object.keys(value).length === 0)
    {
        stage.malformed = true;
        return;
    }

    for (const path of Object.keys(value))
    {
        stage.dependencies[context.documentScope].add(path);
    }
    stage.order = "establishes";
}

function analyzeLimitLikeStage(
    value: unknown,
    stage: StageSemantics,
    allowZero: boolean,
): void
{
    if (
        typeof value !== "number"
        || !Number.isSafeInteger(value)
        || (allowZero ? value < 0 : value <= 0)
    )
    {
        stage.malformed = true;
        return;
    }
    stage.cardinality = "filters";
}

function analyzeSampleStage(
    value: unknown,
    stage: StageSemantics,
): void
{
    if (
        !isPlainObject(value)
        || typeof value.size !== "number"
        || !Number.isSafeInteger(value.size)
        || value.size < 0
    )
    {
        stage.malformed = true;
        return;
    }
    stage.cardinality = "filters";
    stage.order = "reorders";
    stage.determinism = "volatile";
}

function analyzeUnwindStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    const pathValue = typeof value === "string"
        ? value
        : isPlainObject(value)
            ? value.path
            : undefined;
    if (
        typeof pathValue !== "string"
        || !pathValue.startsWith("$")
        || pathValue.startsWith("$$")
        || pathValue.length <= 1
    )
    {
        stage.malformed = true;
        return;
    }

    const path = pathValue.slice(1);
    stage.dependencies[context.documentScope].add(path);
    stage.writes.add(path);
    stage.modifies.add(path);
    stage.cardinality = "filters-and-expands";

    if (
        isPlainObject(value)
        && "includeArrayIndex" in value
        && typeof value.includeArrayIndex === "string"
    )
    {
        stage.writes.add(value.includeArrayIndex);
        stage.modifies.add(value.includeArrayIndex);
    }
}

function analyzeGroupStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    if (!isPlainObject(value) || !("_id" in value))
    {
        stage.malformed = true;
        return;
    }

    for (const [path, expression] of Object.entries(value))
    {
        stage.writes.add(path);
        stage.modifies.add(path);
        applyExpression(stage, expression, context);
    }
    stage.cardinality = "collapses";
    stage.order = "destroys";
    stage.provenance = "generated";
}

function analyzeCountStage(
    value: unknown,
    stage: StageSemantics,
): void
{
    if (
        typeof value !== "string"
        || value.length === 0
        || value.startsWith("$")
        || value.includes(".")
    )
    {
        stage.malformed = true;
        return;
    }
    stage.writes.add(value);
    stage.modifies.add(value);
    stage.cardinality = "collapses";
    stage.order = "destroys";
    stage.provenance = "generated";
}

function analyzeSortByCountStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    applyExpression(stage, value, context);
    stage.writes.add("_id");
    stage.writes.add("count");
    stage.modifies.add("_id");
    stage.modifies.add("count");
    stage.cardinality = "collapses";
    stage.order = "establishes";
    stage.provenance = "generated";
}

function analyzeReplacementStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
    isReplaceRoot: boolean,
): void
{
    const expression = isReplaceRoot && isPlainObject(value)
        ? value.newRoot
        : value;
    if (expression === undefined)
    {
        stage.malformed = true;
        return;
    }
    applyExpression(stage, expression, context);
    stage.writes.add("*");
    stage.modifies.add("*");
    stage.removes.add("?");
    stage.errors = joinErrors(stage.errors, "may-error");
    stage.provenance = "generated";
}

function analyzeLookupStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    if (!isPlainObject(value) || typeof value.as !== "string" || value.as.length === 0)
    {
        stage.malformed = true;
        return;
    }

    stage.writes.add(value.as);
    stage.modifies.add(value.as);
    stage.provenance = "local-and-foreign";

    if ("localField" in value)
    {
        if (typeof value.localField !== "string")
        {
            stage.malformed = true;
            return;
        }
        stage.dependencies[context.documentScope].add(value.localField);
    }

    if ("foreignField" in value)
    {
        if (typeof value.foreignField !== "string")
        {
            stage.malformed = true;
            return;
        }
        stage.dependencies.foreign.add(value.foreignField);
    }

    const variables = new Map<string, DocumentBinding>();
    if ("let" in value)
    {
        if (!isPlainObject(value.let))
        {
            stage.malformed = true;
            return;
        }
        for (const [name, expression] of Object.entries(value.let))
        {
            applyExpression(stage, expression, context);
            variables.set(name, inferDocumentBinding(expression, context));
        }
    }

    if ("pipeline" in value)
    {
        if (!Array.isArray(value.pipeline))
        {
            stage.malformed = true;
            return;
        }
        const childSummary = analyzePipeline(value.pipeline, {
            documentScope: "foreign",
            variables,
            inputProvenance: "foreign",
        });
        addChild(
            stage,
            "lookup",
            "foreign",
            childSummary,
            resolveVariableDependencies(childSummary.dependencies, variables),
            new Set(childSummary.dependencies.foreign),
        );
    }
}

function analyzeGraphLookupStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    if (
        !isPlainObject(value)
        || typeof value.as !== "string"
        || typeof value.connectFromField !== "string"
        || typeof value.connectToField !== "string"
        || !("startWith" in value)
    )
    {
        stage.malformed = true;
        return;
    }

    applyExpression(stage, value.startWith, context);
    stage.dependencies.foreign.add(value.connectFromField);
    stage.dependencies.foreign.add(value.connectToField);
    stage.writes.add(value.as);
    stage.modifies.add(value.as);
    stage.provenance = "local-and-foreign";

    if ("depthField" in value)
    {
        if (typeof value.depthField !== "string")
        {
            stage.malformed = true;
            return;
        }
        const depthPath = `${value.as}.${value.depthField}`;
        stage.writes.add(depthPath);
        stage.modifies.add(depthPath);
    }

    if ("restrictSearchWithMatch" in value)
    {
        const filter = analyzeFilter(value.restrictSearchWithMatch, {
            documentScope: "foreign",
            inputProvenance: "foreign",
        });
        mergeDependencies(stage.dependencies, filter.dependencies);
        stage.determinism = joinDeterminism(
            stage.determinism,
            filter.determinism,
        );
        stage.errors = joinErrors(stage.errors, filter.errors);
        stage.unknown ||= filter.unknown;
        stage.malformed ||= filter.malformed;
    }
}

function analyzeFacetStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    if (!isPlainObject(value))
    {
        stage.malformed = true;
        return;
    }

    for (const [name, pipeline] of Object.entries(value))
    {
        if (!Array.isArray(pipeline))
        {
            stage.malformed = true;
            return;
        }
        const childSummary = analyzePipeline(pipeline, {
            ...context,
            inputProvenance: context.inputProvenance!,
        });
        stage.writes.add(name);
        stage.modifies.add(name);
        addChild(
            stage,
            "facet",
            context.documentScope,
            childSummary,
            new Set(childSummary.dependencies[context.documentScope]),
            new Set(childSummary.dependencies.foreign),
            name,
        );
    }

    stage.cardinality = "replaces";
    stage.order = "destroys";
    stage.provenance = "generated";
}

function analyzeUnionWithStage(
    value: unknown,
    stage: StageSemantics,
): void
{
    if (typeof value !== "string" && !isPlainObject(value))
    {
        stage.malformed = true;
        return;
    }

    stage.cardinality = "expands";
    stage.provenance = "mixed";

    if (isPlainObject(value) && "pipeline" in value)
    {
        if (!Array.isArray(value.pipeline))
        {
            stage.malformed = true;
            return;
        }
        const childSummary = analyzePipeline(value.pipeline, {
            documentScope: "foreign",
            inputProvenance: "foreign",
        });
        addChild(
            stage,
            "unionWith",
            "foreign",
            childSummary,
            new Set(),
            new Set(childSummary.dependencies.foreign),
        );
    }
}

function analyzeDensifyStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    if (
        !isPlainObject(value)
        || typeof value.field !== "string"
        || !isPlainObject(value.range)
    )
    {
        stage.malformed = true;
        return;
    }
    stage.dependencies[context.documentScope].add(value.field);
    stage.writes.add(value.field);
    stage.modifies.add(value.field);
    if ("partitionByFields" in value)
    {
        if (
            !Array.isArray(value.partitionByFields)
            || value.partitionByFields.some((path) => typeof path !== "string")
        )
        {
            stage.malformed = true;
            return;
        }
        for (const path of value.partitionByFields)
        {
            stage.dependencies[context.documentScope].add(path as string);
        }
    }
    stage.cardinality = "expands";
    stage.order = "unknown";
    stage.provenance = "mixed";
    stage.errors = "may-error";
}

function analyzeDocumentsStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    if (!Array.isArray(value))
    {
        stage.malformed = true;
        return;
    }
    applyExpression(stage, value, context);
    stage.writes.add("*");
    stage.modifies.add("*");
    stage.cardinality = "replaces";
    stage.order = "establishes";
    stage.provenance = "generated";
}

function analyzeBucketStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    if (!isPlainObject(value) || !("groupBy" in value))
    {
        stage.malformed = true;
        return;
    }
    applyExpression(stage, value.groupBy, context);
    stage.writes.add("_id");
    stage.modifies.add("_id");
    if ("output" in value)
    {
        if (!isPlainObject(value.output))
        {
            stage.malformed = true;
            return;
        }
        for (const [path, expression] of Object.entries(value.output))
        {
            stage.writes.add(path);
            stage.modifies.add(path);
            applyExpression(stage, expression, context);
        }
    }
    stage.cardinality = "collapses";
    stage.order = "destroys";
    stage.provenance = "generated";
}

function analyzeWindowStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    if (!isPlainObject(value))
    {
        stage.malformed = true;
        return;
    }
    if ("partitionBy" in value)
    {
        applyExpression(stage, value.partitionBy, context);
    }
    if ("sortBy" in value)
    {
        if (!isPlainObject(value.sortBy))
        {
            stage.malformed = true;
            return;
        }
        for (const path of Object.keys(value.sortBy))
        {
            stage.dependencies[context.documentScope].add(path);
        }
        stage.order = "establishes";
    }
    if ("output" in value)
    {
        if (!isPlainObject(value.output))
        {
            stage.malformed = true;
            return;
        }
        for (const [path, expression] of Object.entries(value.output))
        {
            stage.writes.add(path);
            stage.modifies.add(path);
            applyExpression(stage, expression, context);
        }
    }
}

function analyzeFillStage(
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    if (!isPlainObject(value) || !isPlainObject(value.output))
    {
        stage.malformed = true;
        return;
    }
    if ("partitionBy" in value)
    {
        applyExpression(stage, value.partitionBy, context);
    }
    if ("partitionByFields" in value)
    {
        if (
            !Array.isArray(value.partitionByFields)
            || value.partitionByFields.some((path) => typeof path !== "string")
        )
        {
            stage.malformed = true;
            return;
        }
        for (const path of value.partitionByFields)
        {
            stage.dependencies[context.documentScope].add(path as string);
        }
    }
    if ("sortBy" in value)
    {
        if (!isPlainObject(value.sortBy))
        {
            stage.malformed = true;
            return;
        }
        for (const path of Object.keys(value.sortBy))
        {
            stage.dependencies[context.documentScope].add(path);
        }
        stage.order = "establishes";
    }
    for (const [path, config] of Object.entries(value.output))
    {
        stage.writes.add(path);
        stage.modifies.add(path);
        if (isPlainObject(config) && "value" in config)
        {
            applyExpression(stage, config.value, context);
        }
    }
}

const KNOWN_STAGE_OPERATORS = new Set([
    "$addFields",
    "$bucket",
    "$bucketAuto",
    "$count",
    "$densify",
    "$documents",
    "$facet",
    "$fill",
    "$graphLookup",
    "$group",
    "$limit",
    "$lookup",
    "$match",
    "$project",
    "$replaceRoot",
    "$replaceWith",
    "$sample",
    "$set",
    "$setWindowFields",
    "$skip",
    "$sort",
    "$sortByCount",
    "$unionWith",
    "$unset",
    "$unwind",
]);

function analyzeKnownStage(
    operator: string,
    value: unknown,
    stage: StageSemantics,
    context: SemanticAnalysisContext,
): void
{
    switch (operator)
    {
        case "$match":
            analyzeMatchStage(value, stage, context);
            break;
        case "$project":
            analyzeProjectStage(value, stage, context);
            break;
        case "$addFields":
        case "$set":
            analyzeAddFieldsStage(value, stage, context);
            break;
        case "$unset":
            analyzeUnsetStage(value, stage);
            break;
        case "$sort":
            analyzeSortStage(value, stage, context);
            break;
        case "$limit":
            analyzeLimitLikeStage(value, stage, false);
            break;
        case "$skip":
            analyzeLimitLikeStage(value, stage, true);
            break;
        case "$sample":
            analyzeSampleStage(value, stage);
            break;
        case "$unwind":
            analyzeUnwindStage(value, stage, context);
            break;
        case "$group":
            analyzeGroupStage(value, stage, context);
            break;
        case "$count":
            analyzeCountStage(value, stage);
            break;
        case "$sortByCount":
            analyzeSortByCountStage(value, stage, context);
            break;
        case "$replaceRoot":
            analyzeReplacementStage(value, stage, context, true);
            break;
        case "$replaceWith":
            analyzeReplacementStage(value, stage, context, false);
            break;
        case "$lookup":
            analyzeLookupStage(value, stage, context);
            break;
        case "$graphLookup":
            analyzeGraphLookupStage(value, stage, context);
            break;
        case "$facet":
            analyzeFacetStage(value, stage, context);
            break;
        case "$unionWith":
            analyzeUnionWithStage(value, stage);
            break;
        case "$densify":
            analyzeDensifyStage(value, stage, context);
            break;
        case "$documents":
            analyzeDocumentsStage(value, stage, context);
            break;
        case "$bucket":
        case "$bucketAuto":
            analyzeBucketStage(value, stage, context);
            break;
        case "$setWindowFields":
            analyzeWindowStage(value, stage, context);
            break;
        case "$fill":
            analyzeFillStage(value, stage, context);
            break;
    }
}

export function analyzeStage(
    stage: unknown,
    index = 0,
    suppliedContext?: Partial<SemanticAnalysisContext>,
): StageSemantics
{
    const context = normalizeContext(suppliedContext);
    if (!isPlainObject(stage))
    {
        return conservativeTop(stage, index, "unknown", context, true);
    }

    const entries = Object.entries(stage);
    if (entries.length !== 1)
    {
        return conservativeTop(stage, index, "unknown", context, true);
    }

    const [operator, value] = entries[0]!;
    if (!KNOWN_STAGE_OPERATORS.has(operator))
    {
        return conservativeTop(stage, index, operator, context, false);
    }

    const summary = createStageSemantics(stage, index, operator, context);
    analyzeKnownStage(operator, value, summary, context);
    if (summary.malformed)
    {
        const top = conservativeTop(stage, index, operator, context, true);
        top.projection = summary.projection;
        top.children = summary.children;
        return top;
    }

    summary.observable = observableFromStage(summary);
    return summary;
}

export function analyzePipeline(
    pipeline: unknown,
    suppliedContext?: Partial<SemanticAnalysisContext>,
): PipelineSemantics
{
    const context = normalizeContext(suppliedContext);
    if (!Array.isArray(pipeline))
    {
        const dependencies = createDependencies();
        dependencies[context.documentScope].add("*");
        dependencies.unknown = true;
        return {
            stages: [],
            dependencies,
            writes: new Set(["?"]),
            modifies: new Set(["?"]),
            removes: new Set(["?"]),
            cardinality: "unknown",
            order: "unknown",
            provenance: "unknown",
            determinism: "unknown",
            errors: "unknown",
            unknown: true,
            malformed: true,
            observable: {
                cardinality: "unknown",
                order: "unknown",
                provenance: "unknown",
                determinism: "unknown",
                errors: "unknown",
                unknown: true,
            },
        };
    }

    const dependencies = createDependencies();
    const writes = new Set<string>();
    const modifies = new Set<string>();
    const removes = new Set<string>();
    const stages: StageSemantics[] = [];
    let cardinality: CardinalityEffect = "preserves";
    let order: OrderEffect = "preserves";
    let provenance = context.inputProvenance!;
    let determinism: Determinism = "deterministic";
    let errors: ErrorPossibility = "none-known";
    let unknown = false;
    let malformed = false;
    let observableCardinality: CardinalityEffect = "preserves";
    let observableOrder: OrderEffect = "preserves";
    let observableProvenance: StreamProvenance = provenance;
    let observableDeterminism: Determinism = "deterministic";
    let observableErrors: ErrorPossibility = "none-known";
    let observableUnknown = false;

    for (let index = 0; index < pipeline.length; index++)
    {
        const stage = analyzeStage(pipeline[index], index, {
            ...context,
            inputProvenance: provenance,
        });
        stages.push(stage);
        mergeDependencies(dependencies, stage.dependencies);
        for (const path of stage.writes)
        {
            writes.add(path);
        }
        for (const path of stage.modifies)
        {
            modifies.add(path);
        }
        for (const path of stage.removes)
        {
            removes.add(path);
        }
        cardinality = joinCardinality(cardinality, stage.cardinality);
        order = joinOrder(order, stage.order);
        provenance = stage.provenance;
        determinism = joinDeterminism(determinism, stage.determinism);
        errors = joinErrors(errors, stage.errors);
        unknown ||= stage.unknown;
        malformed ||= stage.malformed;

        observableCardinality = joinCardinality(
            observableCardinality,
            stage.observable.cardinality,
        );
        observableOrder = joinOrder(
            observableOrder,
            stage.observable.order,
        );
        observableProvenance = joinProvenance(
            observableProvenance,
            stage.observable.provenance,
        );
        observableDeterminism = joinDeterminism(
            observableDeterminism,
            stage.observable.determinism,
        );
        observableErrors = joinErrors(
            observableErrors,
            stage.observable.errors,
        );
        observableUnknown ||= stage.observable.unknown;
    }

    return {
        stages,
        dependencies,
        writes,
        modifies,
        removes,
        cardinality,
        order,
        provenance,
        determinism,
        errors,
        unknown,
        malformed,
        observable: {
            cardinality: observableCardinality,
            order: observableOrder,
            provenance: observableProvenance,
            determinism: observableDeterminism,
            errors: observableErrors,
            unknown: observableUnknown,
        },
    };
}
