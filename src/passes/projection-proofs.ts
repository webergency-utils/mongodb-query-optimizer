import { analyzeExpression } from '../analyzer/expressions';
import { isExactPath, isExactTopLevelPath, relatePaths } from '../analyzer/paths';
import {
    analyzeProjection,
    projectionVisibility,
} from '../analyzer/projections';
import { analyzeStage } from '../analyzer/semantics';
import {
    ExpressionSummary,
    ProjectionSummary,
    StageSemantics,
} from '../analyzer/types';
import { isPlainObject } from '../utils.js';
import { getSingleStageEntry } from './helpers.js';

const ADD_FIELD_OPERATORS = new Set(['$addFields', '$set']);

export interface AddFieldStage
{
    readonly operator: '$addFields' | '$set';
    readonly specification: Record<string, unknown>;
    readonly semantics: StageSemantics;
}

export interface SimpleProject
{
    readonly specification: Record<string, unknown>;
    readonly projection: ProjectionSummary;
    readonly mode: 'inclusion' | 'exclusion';
}

export interface AdjacentAddFieldMergeProof
{
    readonly mergedStage: Record<string, Record<string, unknown>>;
}

export interface AdjacentProjectMergeProof
{
    readonly mergedStage: {
        readonly $project: Record<string, unknown>;
    };
}

export interface UnusedFieldPruningProof
{
    readonly replacementStage: Record<string, Record<string, unknown>> | null;
    readonly removedFields: readonly string[];
}

function hasOnlyKnownDependencyPaths(semantics: StageSemantics): boolean
{
    if (
        semantics.dependencies.unknown
        || semantics.dependencies.variables.size > 0
        || semantics.dependencies.foreign.size > 0
        || semantics.dependencies.element.size > 0
    )
    {
        return false;
    }

    for (const path of semantics.dependencies.local)
    {
        if (path !== '*' && !isExactPath(path))
        {
            return false;
        }
    }

    return true;
}

function hasDeterministicErrorFreeEvaluation(
    semantics: StageSemantics,
): boolean
{
    return (
        !semantics.unknown
        && !semantics.malformed
        && !semantics.observable.unknown
        && semantics.determinism === 'deterministic'
        && semantics.observable.determinism === 'deterministic'
    );
}

export function parseAddFieldStage(
    stage: unknown,
    requireSafeEvaluation: boolean,
): AddFieldStage | null
{
    const entry = getSingleStageEntry(stage);
    if (
        !entry
        || !ADD_FIELD_OPERATORS.has(entry[0])
        || !isPlainObject(entry[1])
    )
    {
        return null;
    }

    const projection = analyzeProjection(entry[1], 'add-fields');
    if (
        projection.unknown
        || projection.hasPathCollisions
        || projection.mode !== 'add-fields'
        || Object.keys(entry[1]).length === 0
        || Array.from(projection.computedPaths).some((path) => !isExactPath(path))
    )
    {
        return null;
    }

    const semantics = analyzeStage(stage);
    if (
        semantics.operator !== entry[0]
        || semantics.projection?.mode !== 'add-fields'
        || semantics.children.length > 0
        || !hasOnlyKnownDependencyPaths(semantics)
        || (
            requireSafeEvaluation
            && !hasDeterministicErrorFreeEvaluation(semantics)
        )
    )
    {
        return null;
    }

    return {
        operator: entry[0] as '$addFields' | '$set',
        specification: entry[1],
        semantics,
    };
}

function pathsArePairwiseDisjoint(
    left: Iterable<string>,
    right: Iterable<string>,
): boolean
{
    for (const leftPath of left)
    {
        for (const rightPath of right)
        {
            if (relatePaths(leftPath, rightPath) !== 'disjoint')
            {
                return false;
            }
        }
    }

    return true;
}

export function dependenciesReadAnyPath(
    semantics: StageSemantics,
    paths: Iterable<string>,
): boolean
{
    for (const dependency of semantics.dependencies.local)
    {
        for (const path of paths)
        {
            if (relatePaths(dependency, path) !== 'disjoint')
            {
                return true;
            }
        }
    }

    return false;
}

function writesCanSafelyMerge(
    firstWrites: Iterable<string>,
    secondWrites: Iterable<string>,
): boolean
{
    for (const firstPath of firstWrites)
    {
        for (const secondPath of secondWrites)
        {
            const relation = relatePaths(firstPath, secondPath);
            if (relation === 'ancestor' || relation === 'descendant')
            {
                return false;
            }
        }
    }

    return true;
}

/**
 * Proves that two adjacent add/set stages can share one input document.
 * The proof rejects hierarchical collisions and second-stage reads of first writes.
 */
export function proveAdjacentAddFieldMerge(
    firstStage: unknown,
    secondStage: unknown,
): AdjacentAddFieldMergeProof | null
{
    const first = parseAddFieldStage(firstStage, true);
    const second = parseAddFieldStage(secondStage, true);
    if (!first || !second)
    {
        return null;
    }

    if (
        !writesCanSafelyMerge(
            first.semantics.writes,
            second.semantics.writes,
        )
        || dependenciesReadAnyPath(
            second.semantics,
            first.semantics.writes,
        )
    )
    {
        return null;
    }

    return {
        mergedStage: {
            [first.operator]: {
                ...first.specification,
                ...second.specification,
            },
        },
    };
}

function isProjectionFlag(value: unknown): boolean
{
    return value === 0 || value === 1 || value === false || value === true;
}

function isIncluded(value: unknown): boolean
{
    return value === 1 || value === true;
}

function isExcluded(value: unknown): boolean
{
    return value === 0 || value === false;
}

export function parseSimpleProject(stage: unknown): SimpleProject | null
{
    const entry = getSingleStageEntry(stage);
    if (
        !entry
        || entry[0] !== '$project'
        || !isPlainObject(entry[1])
        || Object.keys(entry[1]).length === 0
    )
    {
        return null;
    }

    if (
        Object.entries(entry[1]).some(([path, value]) =>
            !isExactTopLevelPath(path) || !isProjectionFlag(value),
        )
    )
    {
        return null;
    }

    const semantics = analyzeStage(stage);
    const projection = semantics.projection;
    if (
        semantics.operator !== '$project'
        || semantics.unknown
        || semantics.malformed
        || !projection
        || projection.unknown
        || projection.hasPathCollisions
        || (
            projection.mode !== 'inclusion'
            && projection.mode !== 'exclusion'
        )
    )
    {
        return null;
    }

    return {
        specification: entry[1],
        projection,
        mode: projection.mode,
    };
}

function nonIdEntries(
    projection: SimpleProject,
    included: boolean,
): Array<readonly [string, unknown]>
{
    return Object.entries(projection.specification).filter(([path, value]) =>
    {
        return (
            path !== '_id'
            && (included ? isIncluded(value) : isExcluded(value))
        );
    });
}

function explicitlyIncludesId(projection: SimpleProject): boolean
{
    return isIncluded(projection.specification._id);
}

function excludesId(projection: SimpleProject): boolean
{
    return projection.projection.id === 'excluded';
}

function includedIdValue(
    first: SimpleProject,
    second: SimpleProject,
): unknown
{
    if (explicitlyIncludesId(second))
    {
        return second.specification._id;
    }

    if (explicitlyIncludesId(first))
    {
        return first.specification._id;
    }

    return undefined;
}

function excludedIdValue(
    first: SimpleProject,
    second: SimpleProject,
): unknown
{
    if (excludesId(second))
    {
        return second.specification._id;
    }

    return first.specification._id;
}

/**
 * Proves composition for pure top-level flag projections. A later explicit
 * include may not request a field already hidden by the first projection.
 */
export function proveAdjacentProjectMerge(
    firstStage: unknown,
    secondStage: unknown,
): AdjacentProjectMergeProof | null
{
    const first = parseSimpleProject(firstStage);
    const second = parseSimpleProject(secondStage);
    if (!first || !second)
    {
        return null;
    }

    if (second.mode === 'inclusion')
    {
        for (const [path] of nonIdEntries(second, true))
        {
            if (projectionVisibility(first.projection, path) !== 'visible')
            {
                return null;
            }
        }
    }

    if (
        explicitlyIncludesId(second)
        && projectionVisibility(first.projection, '_id') !== 'visible'
    )
    {
        return null;
    }

    const finalIdExcluded = excludesId(first) || excludesId(second);
    const merged: Record<string, unknown> = {};
    let finalMode: 'inclusion' | 'exclusion';
    let finalEntries: Array<readonly [string, unknown]>;

    if (second.mode === 'inclusion')
    {
        finalMode = 'inclusion';
        finalEntries = nonIdEntries(second, true);
    }
    else if (first.mode === 'inclusion')
    {
        finalMode = 'inclusion';
        const excludedBySecond = new Set(
            nonIdEntries(second, false).map(([path]) => path),
        );
        finalEntries = nonIdEntries(first, true).filter(
            ([path]) => !excludedBySecond.has(path),
        );
    }
    else
    {
        finalMode = 'exclusion';
        const exclusions = new Map<string, unknown>();
        for (const [path, value] of nonIdEntries(first, false))
        {
            exclusions.set(path, value);
        }
        for (const [path, value] of nonIdEntries(second, false))
        {
            exclusions.set(path, value);
        }
        finalEntries = Array.from(exclusions);
    }

    for (const [path, value] of finalEntries)
    {
        merged[path] = value;
    }

    if (finalIdExcluded)
    {
        merged._id = excludedIdValue(first, second);
    }
    else
    {
        const explicitId = includedIdValue(first, second);
        if (explicitId !== undefined)
        {
            merged._id = explicitId;
        }
        else if (finalMode === 'inclusion' && finalEntries.length === 0)
        {
            merged._id = 1;
        }
    }

    if (
        finalMode === 'inclusion'
        && finalEntries.length === 0
        && finalIdExcluded
    )
    {
        return null;
    }

    return {
        mergedStage: {
            $project: merged,
        },
    };
}

function containsGetField(value: unknown): boolean
{
    if (Array.isArray(value))
    {
        return value.some(containsGetField);
    }

    if (!isPlainObject(value))
    {
        return false;
    }

    for (const [key, child] of Object.entries(value))
    {
        if (key === '$getField' || containsGetField(child))
        {
            return true;
        }
    }

    return false;
}

function hasOnlyExactLocalDependencies(summary: ExpressionSummary): boolean
{
    for (const path of summary.dependencies.local)
    {
        if (path === '*' || !isExactPath(path))
        {
            return false;
        }
    }

    return true;
}

function isSyntacticallyErrorFreeExpression(expression: unknown): boolean
{
    if (Array.isArray(expression))
    {
        return expression.every(isSyntacticallyErrorFreeExpression);
    }

    if (!isPlainObject(expression))
    {
        return true;
    }

    const entries = Object.entries(expression);
    if (entries.length === 1 && entries[0]![0] === '$literal')
    {
        return true;
    }

    return entries.every(([key, value]) =>
        !key.startsWith('$') && isSyntacticallyErrorFreeExpression(value),
    );
}

export function isSafePrunableAssignment(expression: unknown): boolean
{
    const summary = analyzeExpression(expression, {
        documentScope: 'local',
    });
    return (
        !containsGetField(expression)
        && isSyntacticallyErrorFreeExpression(expression)
        && !summary.unknown
        && summary.determinism === 'deterministic'
        && hasOnlyExactLocalDependencies(summary)
    );
}

export function exactUnsetFields(stage: unknown): Set<string> | null
{
    const entry = getSingleStageEntry(stage);
    if (!entry || entry[0] !== '$unset')
    {
        return null;
    }

    const values = Array.isArray(entry[1]) ? entry[1] : [entry[1]];
    if (
        values.length === 0
        || values.some(
            (value) => typeof value !== 'string' || !isExactTopLevelPath(value),
        )
    )
    {
        return null;
    }

    return new Set(values as string[]);
}

function orderPreservingOverwriteRemovals(
    sourceSpecification: Record<string, unknown>,
    overwriteSpecification: Record<string, unknown>,
    eligibleFields: Set<string>,
): string[]
{
    const sourceFields = Object.keys(sourceSpecification);
    const overwriteFields = Object.keys(overwriteSpecification);
    const maximum = Math.min(sourceFields.length, overwriteFields.length);

    for (let count = maximum; count > 0; count--)
    {
        const sourceSuffix = sourceFields.slice(sourceFields.length - count);
        const overwritePrefix = overwriteFields.slice(0, count);
        if (
            sourceSuffix.every((path, index) =>
                eligibleFields.has(path) && path === overwritePrefix[index],
            )
        )
        {
            return sourceSuffix;
        }
    }

    return [];
}

function projectDiscardedSourceFields(
    source: AddFieldStage,
    project: SimpleProject,
): Set<string>
{
    const discarded = new Set<string>();
    for (const path of Object.keys(source.specification))
    {
        if (!isExactTopLevelPath(path))
        {
            continue;
        }

        const visibility = projectionVisibility(project.projection, path);
        if (visibility === 'hidden' || visibility === 'removed')
        {
            discarded.add(path);
        }
    }

    return discarded;
}

/**
 * True when the follower is a simple unset or flag project that drops path
 * from the successful output document.
 */
export function isExactPathDiscardedByFollower(
    path: string,
    followingStage: unknown,
): boolean
{
    const unsetFields = exactUnsetFields(followingStage);
    if (unsetFields)
    {
        return unsetFields.has(path);
    }

    const project = parseSimpleProject(followingStage);
    if (!project)
    {
        return false;
    }

    const visibility = projectionVisibility(project.projection, path);
    return visibility === 'hidden' || visibility === 'removed';
}

function parseSafeSortKeys(sortStage: unknown): string[] | null
{
    const entry = getSingleStageEntry(sortStage);
    if (
        !entry
        || entry[0] !== '$sort'
        || !isPlainObject(entry[1])
    )
    {
        return null;
    }

    const keys = Object.keys(entry[1]);
    if (
        keys.length === 0
        || Object.values(entry[1]).some(
            (direction) => direction !== 1 && direction !== -1,
        )
    )
    {
        return null;
    }

    const sort = analyzeStage(sortStage);
    if (
        sort.operator !== '$sort'
        || sort.children.length > 0
        || sort.cardinality !== 'preserves'
        || sort.order !== 'establishes'
        || sort.observable.cardinality !== 'preserves'
        || sort.observable.order !== 'establishes'
        || !hasDeterministicErrorFreeEvaluation(sort)
        || !hasOnlyKnownDependencyPaths(sort)
    )
    {
        return null;
    }

    return keys;
}

/**
 * Proves that a simple flag project keeps every sort key visible, so the
 * project may move before the sort without changing successful order.
 */
export function proveSimpleProjectAdvanceAcrossSort(
    sortStage: unknown,
    projectStage: unknown,
): boolean
{
    const keys = parseSafeSortKeys(sortStage);
    if (!keys)
    {
        return false;
    }

    const project = parseSimpleProject(projectStage);
    if (!project)
    {
        return false;
    }

    return keys.every((path) =>
        projectionVisibility(project.projection, path) === 'visible',
    );
}

/**
 * Delays a deterministic, error-free add/set past an adjacent sort when the
 * sort does not read the written fields.
 */
export function proveAddFieldDeferralAcrossSort(
    addStage: unknown,
    sortStage: unknown,
): boolean
{
    const source = parseAddFieldStage(addStage, true);
    const keys = parseSafeSortKeys(sortStage);
    if (!source || !keys)
    {
        return false;
    }

    if (containsGetField(source.specification))
    {
        return false;
    }

    return pathsArePairwiseDisjoint(source.semantics.writes, keys);
}

function prunableSourceFields(source: AddFieldStage): Set<string>
{
    const fields = new Set<string>();
    for (const [path, expression] of Object.entries(source.specification))
    {
        if (isExactTopLevelPath(path) && isSafePrunableAssignment(expression))
        {
            fields.add(path);
        }
    }

    return fields;
}

function buildPruningProof(
    source: AddFieldStage,
    removedFields: string[],
): UnusedFieldPruningProof | null
{
    if (removedFields.length === 0)
    {
        return null;
    }

    const removed = new Set(removedFields);
    const remainingEntries = Object.entries(source.specification).filter(
        ([path]) => !removed.has(path),
    );
    const replacementStage = remainingEntries.length === 0
        ? null
        : {
            [source.operator]: Object.fromEntries(remainingEntries),
        };

    return {
        replacementStage,
        removedFields,
    };
}

function proveKillOnStage(
    source: AddFieldStage,
    live: Set<string>,
    stage: unknown,
): UnusedFieldPruningProof | null
{
    const unsetFields = exactUnsetFields(stage);
    const overwrite = unsetFields
        ? null
        : parseAddFieldStage(stage, false);
    const followingProject = unsetFields || overwrite
        ? null
        : parseSimpleProject(stage);
    if (!unsetFields && !overwrite && !followingProject)
    {
        return null;
    }

    const killedFields = unsetFields
        ?? (overwrite
            ? new Set(
                Object.keys(overwrite.specification).filter(isExactTopLevelPath),
            )
            : projectDiscardedSourceFields(source, followingProject!));
    const eligibleFields = new Set<string>();

    for (const path of live)
    {
        if (!killedFields.has(path))
        {
            continue;
        }

        if (
            overwrite
            && dependenciesReadAnyPath(overwrite.semantics, [path])
        )
        {
            continue;
        }

        eligibleFields.add(path);
    }

    const removedFields = overwrite
        ? orderPreservingOverwriteRemovals(
            source.specification,
            overwrite.specification,
            eligibleFields,
        )
        : Array.from(eligibleFields);

    return buildPruningProof(source, removedFields);
}

function observedLiveFields(
    semantics: StageSemantics,
    live: Set<string>,
): Set<string>
{
    const observed = new Set<string>();
    for (const path of live)
    {
        if (dependenciesReadAnyPath(semantics, [path]))
        {
            observed.add(path);
        }
    }

    return observed;
}

export function canContinuePastStage(
    semantics: StageSemantics,
    live: Set<string>,
): boolean
{
    if (
        semantics.unknown
        || semantics.malformed
        || semantics.observable.unknown
        || semantics.children.length > 0
        || !hasOnlyKnownDependencyPaths(semantics)
    )
    {
        return false;
    }

    return (
        !dependenciesReadAnyPath(semantics, live)
        && pathsArePairwiseDisjoint(semantics.writes, live)
        && pathsArePairwiseDisjoint(semantics.modifies, live)
        && pathsArePairwiseDisjoint(semantics.removes, live)
    );
}

/**
 * Proves removal of exact top-level add/set assignments killed by an
 * immediately following unset, overwrite, or simple project.
 */
export function proveUnusedFieldPruning(
    sourceStage: unknown,
    nextStage: unknown,
): UnusedFieldPruningProof | null
{
    return proveUnusedFieldPruningThroughSuffix(sourceStage, [nextStage]);
}

/**
 * Same kill as adjacent pruning, but the killer may sit after a suffix that
 * does not observe the dead writes. Exclusion projects, unknown stages,
 * whole-document reads, and any read of the write still block.
 */
export function proveUnusedFieldPruningThroughSuffix(
    sourceStage: unknown,
    suffix: readonly unknown[],
): UnusedFieldPruningProof | null
{
    const source = parseAddFieldStage(sourceStage, false);
    if (!source || suffix.length === 0)
    {
        return null;
    }

    const live = prunableSourceFields(source);
    if (live.size === 0)
    {
        return null;
    }

    for (const stage of suffix)
    {
        const proof = proveKillOnStage(source, live, stage);
        if (proof)
        {
            return proof;
        }

        const semantics = analyzeStage(stage);
        for (const path of observedLiveFields(semantics, live))
        {
            live.delete(path);
        }

        if (live.size === 0 || !canContinuePastStage(semantics, live))
        {
            return null;
        }
    }

    return null;
}
