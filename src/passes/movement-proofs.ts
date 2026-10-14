import { relatePaths } from '../analyzer/paths';
import {
    projectionVisibility,
} from '../analyzer/projections';
import { analyzeStage } from '../analyzer/semantics';
import {
    canContinuePastStage,
    dependenciesReadAnyPath,
    hasOnlyKnownDependencyPaths,
    isExactPathDiscardedByFollower,
} from './projection-proofs';
import {
    ScopedDependencies,
    StageSemantics,
} from '../analyzer/types';
import { deepClone, isPlainObject } from '../utils.js';
import {
    combineConjuncts,
    decomposeFilterIntoConjuncts,
    getSingleStageEntry,
    isMatchStage,
} from './helpers.js';
import { GuaranteeContext, DEFAULT_GUARANTEE_CONTEXT } from '../guarantees.js';
import { arePathsDisjoint } from './path-disjoint';
import
{
    canMoveStageAcrossStage,
    canRemoveStage,
    isStageProvenErrorFree,
    stageReadsFieldOrder,
}
from './guarantee-guards.js';

const LOGICAL_FILTER_OPERATORS = new Set(['$and', '$or', '$nor']);
const PASSIVE_LIMIT_OPERATORS = new Set([
    '$project',
    '$addFields',
    '$set',
    '$unset',
]);

interface RewriteResult<T>
{
    readonly value: T;
    readonly changed: boolean;
}

interface AliasResolution
{
    readonly path: string;
}

export interface MatchPushdownProof
{
    readonly matchStage: {
        readonly $match: Record<string, unknown>;
    };
    readonly residualStage?: {
        readonly $match: Record<string, unknown>;
    };
}

function hasAmbiguousPath(paths: Iterable<string>): boolean
{
    for (const path of paths)
    {
        if (
            path === '*'
            || path === '?'
            || relatePaths(path, path) !== 'exact'
        )
        {
            return true;
        }
    }

    return false;
}

function hasAmbiguousDependencies(
    dependencies: ScopedDependencies,
): boolean
{
    return (
        dependencies.unknown
        || dependencies.variables.size > 0
        || hasAmbiguousPath(dependencies.local)
        || hasAmbiguousPath(dependencies.foreign)
        || hasAmbiguousPath(dependencies.element)
    );
}

function hasAmbiguousStagePaths(stage: StageSemantics): boolean
{
    return (
        hasAmbiguousDependencies(stage.dependencies)
        || hasAmbiguousPath(stage.writes)
        || hasAmbiguousPath(stage.modifies)
        || hasAmbiguousPath(stage.removes)
    );
}

function hasKnownLocalProvenance(stage: StageSemantics): boolean
{
    return (
        stage.provenance === 'local'
        && stage.observable.provenance === 'local'
    );
}

function isDeterministicErrorFree(stage: StageSemantics): boolean
{
    return (
        !stage.unknown
        && !stage.malformed
        && !stage.observable.unknown
        && stage.determinism === 'deterministic'
        && stage.observable.determinism === 'deterministic'
    );
}

function hasNoChildUncertainty(stage: StageSemantics): boolean
{
    return stage.children.length === 0;
}

export function isSafeMatchSummary(stage: StageSemantics): boolean
{
    return (
        stage.operator === '$match'
        && stage.cardinality === 'filters'
        && stage.order === 'preserves'
        && stage.observable.cardinality === 'filters'
        && stage.observable.order === 'preserves'
        && stage.dependencies.foreign.size === 0
        && isDeterministicErrorFree(stage)
        && hasNoChildUncertainty(stage)
        && hasKnownLocalProvenance(stage)
        && !hasAmbiguousStagePaths(stage)
    );
}

function isSafePassiveSummary(stage: StageSemantics): boolean
{
    return (
        stage.cardinality === 'preserves'
        && stage.order === 'preserves'
        && stage.observable.cardinality === 'preserves'
        && stage.observable.order === 'preserves'
        && stage.dependencies.foreign.size === 0
        && isDeterministicErrorFree(stage)
        && hasNoChildUncertainty(stage)
        && hasKnownLocalProvenance(stage)
        && !hasAmbiguousStagePaths(stage)
        && (
            stage.projection === undefined
            || (
                !stage.projection.unknown
                && !stage.projection.hasPathCollisions
            )
        )
    );
}

function pathOverlaps(path: string, effects: Iterable<string>): boolean
{
    return !arePathsDisjoint([ path ], effects);
}

function extractDirectAliases(
    stage: StageSemantics,
): ReadonlyMap<string, string>
{
    const aliases = new Map<string, string>();
    const specification = (
        stage.stage as Record<string, unknown>
    )[stage.operator] as Record<string, unknown>;

    for (const [target, expression] of Object.entries(specification))
    {
        if (
            typeof expression !== 'string'
            || !expression.startsWith('$')
            || expression.startsWith('$$')
            || expression.length <= 1
        )
        {
            continue;
        }

        const source = expression.slice(1);
        aliases.set(target, source);
    }

    return aliases;
}

function resolveAlias(
    path: string,
    aliases: ReadonlyMap<string, string>,
): AliasResolution | null
{
    const sortedAliases = Array.from(aliases.entries()).sort(
        ([left], [right]) => right.length - left.length,
    );

    for (const [target, source] of sortedAliases)
    {
        if (path === target)
        {
            return { path: source };
        }

        if (path.startsWith(`${target}.`))
        {
            return {
                path: `${source}${path.slice(target.length)}`,
            };
        }
    }

    return null;
}

function rewriteExpressionString(
    value: string,
    aliases: ReadonlyMap<string, string>,
): RewriteResult<string>
{
    if (!value.startsWith("$"))
    {
        return { value, changed: false };
    }

    for (const variable of ["$$ROOT.", "$$CURRENT."])
    {
        if (value.startsWith(variable))
        {
            const path = value.slice(variable.length);
            const alias = resolveAlias(path, aliases);
            return alias
                ? {
                    value: `${variable}${alias.path}`,
                    changed: alias.path !== path,
                }
                : { value, changed: false };
        }
    }

    if (value.startsWith("$$"))
    {
        return { value, changed: false };
    }

    const path = value.slice(1);
    const alias = resolveAlias(path, aliases);
    return alias
        ? {
            value: `$${alias.path}`,
            changed: alias.path !== path,
        }
        : { value, changed: false };
}

function rewriteExpression(
    expression: unknown,
    aliases: ReadonlyMap<string, string>,
): RewriteResult<unknown>
{
    if (typeof expression === "string")
    {
        return rewriteExpressionString(expression, aliases);
    }

    if (
        expression === null
        || expression === undefined
        || typeof expression !== "object"
        || expression instanceof Date
        || expression instanceof RegExp
    )
    {
        return { value: expression, changed: false };
    }

    if (Array.isArray(expression))
    {
        const result: unknown[] = [];
        let changed = false;
        for (const item of expression)
        {
            const rewritten = rewriteExpression(item, aliases);
            result.push(rewritten.value);
            changed ||= rewritten.changed;
        }
        return { value: result, changed };
    }

    if (!isPlainObject(expression))
    {
        return { value: expression, changed: false };
    }

    const entries = Object.entries(expression);
    if (
        entries.length === 1
        && entries[0]![0] === "$literal"
    )
    {
        return { value: expression, changed: false };
    }

    const result: Record<string, unknown> = {};
    let changed = false;
    for (const [key, value] of entries)
    {
        const rewritten = rewriteExpression(value, aliases);
        result[key] = rewritten.value;
        changed ||= rewritten.changed;
    }

    return { value: result, changed };
}

function rewriteFieldCondition(
    condition: unknown,
    aliases: ReadonlyMap<string, string>,
): RewriteResult<unknown>
{
    if (!isPlainObject(condition))
    {
        return { value: condition, changed: false };
    }

    const entries = Object.entries(condition);
    const operatorEntries = entries.filter(([key]) => key.startsWith("$"));
    if (operatorEntries.length === 0)
    {
        return { value: condition, changed: false };
    }

    const result: Record<string, unknown> = {};
    let changed = false;
    for (const [operator, operand] of entries)
    {
        if (operator === "$elemMatch")
        {
            const rewritten = rewriteQueryDocument(
                operand as Record<string, unknown>,
                aliases,
                true,
            )!;
            result[operator] = rewritten.value;
            changed ||= rewritten.changed;
            continue;
        }

        if (operator === "$not")
        {
            const rewritten = rewriteFieldCondition(operand, aliases);
            result[operator] = rewritten.value;
            changed ||= rewritten.changed;
            continue;
        }

        if (operator === "$all" && Array.isArray(operand))
        {
            const rewrittenItems: unknown[] = [];
            for (const item of operand)
            {
                if (
                    isPlainObject(item)
                    && Object.keys(item).length === 1
                    && "$elemMatch" in item
                )
                {
                    const rewritten = rewriteQueryDocument(
                        item.$elemMatch as Record<string, unknown>,
                        aliases,
                        true,
                    )!;
                    rewrittenItems.push({ $elemMatch: rewritten.value });
                    changed ||= rewritten.changed;
                }
                else
                {
                    rewrittenItems.push(item);
                }
            }
            result[operator] = rewrittenItems;
            continue;
        }

        result[operator] = operand;
    }

    return { value: result, changed };
}

export function rewriteQueryDocument(
    filter: Record<string, unknown>,
    aliases: ReadonlyMap<string, string>,
    elementRelative: boolean,
): RewriteResult<Record<string, unknown>> | null
{
    const result: Record<string, unknown> = {};
    let changed = false;
    for (const [key, value] of Object.entries(filter))
    {
        if (key.startsWith("$"))
        {
            if (LOGICAL_FILTER_OPERATORS.has(key))
            {
                const branches: Record<string, unknown>[] = [];
                for (const branch of value as unknown[])
                {
                    const rewritten = rewriteQueryDocument(
                        branch as Record<string, unknown>,
                        aliases,
                        elementRelative,
                    );
                    if (!rewritten)
                    {
                        return null;
                    }
                    branches.push(rewritten.value);
                    changed ||= rewritten.changed;
                }
                result[key] = branches;
                continue;
            }

            if (key === "$expr" && !elementRelative)
            {
                const rewritten = rewriteExpression(value, aliases);
                result[key] = rewritten.value;
                changed ||= rewritten.changed;
                continue;
            }

            if (elementRelative)
            {
                result[key] = value;
                continue;
            }

            result[key] = value;
            continue;
        }

        const rewrittenCondition = rewriteFieldCondition(value, aliases);
        const alias = elementRelative ? null : resolveAlias(key, aliases);
        const rewrittenKey = alias?.path ?? key;
        if (Object.prototype.hasOwnProperty.call(result, rewrittenKey))
        {
            return null;
        }

        result[rewrittenKey] = rewrittenCondition.value;
        changed ||= rewrittenKey !== key || rewrittenCondition.changed;
    }

    return { value: result, changed };
}

function proveProjectDependencies(
    project: StageSemantics,
    match: StageSemantics,
    aliases: ReadonlyMap<string, string>,
): boolean
{
    for (const dependency of match.dependencies.local)
    {
        if (resolveAlias(dependency, aliases))
        {
            continue;
        }

        if (
            projectionVisibility(project.projection!, dependency) !== "visible"
            || pathOverlaps(dependency, project.modifies)
            || pathOverlaps(dependency, project.removes)
        )
        {
            return false;
        }
    }

    return true;
}

function proveAddFieldsDependencies(
    stage: StageSemantics,
    match: StageSemantics,
    aliases: ReadonlyMap<string, string>,
): boolean
{
    for (const dependency of match.dependencies.local)
    {
        if (
            pathOverlaps(dependency, stage.modifies)
            && !resolveAlias(dependency, aliases)
        )
        {
            return false;
        }
    }

    return true;
}

function conditionHasExists(condition: unknown): boolean
{
    if (!isPlainObject(condition))
    {
        return false;
    }
    return "$exists" in condition;
}

function filterHasExistsOnPath(
    filter: Record<string, unknown>,
    targetPath: string,
): boolean
{
    for (const [key, value] of Object.entries(filter))
    {
        if (key === "$and" || key === "$or")
        {
            if (
                Array.isArray(value)
                && value.some(
                    (branch) => isPlainObject(branch) && filterHasExistsOnPath(branch, targetPath),
                )
            )
            {
                return true;
            }
            continue;
        }

        if (key === targetPath || key.startsWith(`${targetPath}.`))
        {
            if (conditionHasExists(value))
            {
                return true;
            }
        }
    }

    return false;
}

export function isMovementSafeSort(stage: StageSemantics): boolean
{
    if (
        stage.operator !== "$sort"
        || stage.cardinality !== "preserves"
        || stage.order !== "establishes"
        || stage.observable.cardinality !== "preserves"
        || stage.observable.order !== "establishes"
        || !isDeterministicErrorFree(stage)
        || !hasNoChildUncertainty(stage)
        || !hasKnownLocalProvenance(stage)
        || hasAmbiguousStagePaths(stage)
    )
    {
        return false;
    }

    const specification = (
        stage.stage as Record<string, unknown>
    ).$sort;
    return (
        isPlainObject(specification)
        && Object.values(specification).every(
            (direction) => direction === 1 || direction === -1,
        )
    );
}

function isSafeUnwindStage( stage: StageSemantics ): boolean
{
    return (
        stage.operator === '$unwind'
        && stage.dependencies.foreign.size === 0
        && isDeterministicErrorFree( stage )
        && hasNoChildUncertainty( stage )
        && hasKnownLocalProvenance( stage )
        && !hasAmbiguousStagePaths( stage )
    );
}



function proveDisjointMatchPushdown(
    modifiedPaths : Iterable<string>,
    matchStage    : { readonly $match: Record<string, unknown> },
    match         : StageSemantics,
    projectStage? : StageSemantics,
    aliases       : ReadonlyMap<string, string> = new Map()
): MatchPushdownProof | null
{
    if( !projectStage && arePathsDisjoint( match.dependencies.local, modifiedPaths ))
    {
        return { matchStage };
    }

    const conjuncts = decomposeFilterIntoConjuncts( matchStage.$match );

    if( conjuncts.length <= 1 ){ return null }

    const pushable: Record<string, unknown>[] = [];
    const residual: Record<string, unknown>[] = [];

    for( const conjunct of conjuncts )
    {
        const conjunctSemantics = analyzeStage( { $match: conjunct } );
        const canPush = projectStage
            ? proveProjectDependencies( projectStage, conjunctSemantics, aliases )
            : aliases.size > 0
                ? proveAddFieldsDependencies(
                    { modifies: new Set( modifiedPaths ) } as unknown as StageSemantics,
                    conjunctSemantics,
                    aliases
                )
                : arePathsDisjoint( conjunctSemantics.dependencies.local, modifiedPaths );

        const usesAliases = !arePathsDisjoint( conjunctSemantics.dependencies.local, modifiedPaths );

        if(
            isSafeMatchSummary( conjunctSemantics )
            && canPush
            && ( !usesAliases || !containsGetField( conjunct ))
        )
        {
            const rewritten = rewriteQueryDocument( conjunct, aliases, false );

            if( rewritten )
            {
                pushable.push( rewritten.value );
            }
            else
            {
                residual.push( conjunct );
            }
        }
        else
        {
            residual.push( conjunct );
        }
    }

    if( pushable.length === 0 ){ return null }

    return {
        matchStage: { $match: combineConjuncts( pushable ) },
        residualStage: { $match: combineConjuncts( residual ) }
    };
}

export function containsGetField( value: unknown ): boolean
{
    if( Array.isArray( value ))
    {
        return value.some( containsGetField );
    }

    if( !isPlainObject( value ))
    {
        return false;
    }

    for( const [ key, child ] of Object.entries( value ))
    {
        if( key === '$getField' || containsGetField( child ))
        {
            return true;
        }
    }

    return false;
}

/**
 * Proves one adjacent backward movement of a match stage. A successful proof
 * carries the complete syntax-aware rewrite that must move with the stage.
 */
export function proveMatchPushdownAcrossStage(
    precedingStage     : unknown,
    matchStage         : unknown,
    context?           : GuaranteeContext,
    downstreamPipeline : readonly unknown[] = []
): MatchPushdownProof | null
{
    if( context && !canMoveStageAcrossStage( matchStage, precedingStage, 'earlier', context, downstreamPipeline ))
    {
        return null;
    }

    const match = analyzeStage( matchStage );

    if( !isSafeMatchSummary( match ) || !isMatchStage( matchStage ))
    {
        return null;
    }

    const preceding = analyzeStage(precedingStage);
    if (isMovementSafeSort(preceding))
    {
        return { matchStage };
    }

    if( isSafeUnwindStage( preceding ))
    {
        return proveDisjointMatchPushdown( preceding.modifies, matchStage, match );
    }

    if (!isSafePassiveSummary(preceding))
    {
        return null;
    }

    if( preceding.operator === '$unset' )
    {
        return proveDisjointMatchPushdown( preceding.removes, matchStage, match );
    }

    if (
        preceding.operator !== "$project"
        && preceding.operator !== "$addFields"
        && preceding.operator !== "$set"
    )
    {
        return null;
    }

    const aliases = extractDirectAliases(preceding);
    if (
        aliases.size > 0
        && (preceding.operator === "$addFields" || preceding.operator === "$set")
    )
    {
        for (const target of aliases.keys())
        {
            if (filterHasExistsOnPath(matchStage.$match, target))
            {
                return null;
            }
        }
    }

    const dependenciesProven = preceding.operator === "$project"
        ? proveProjectDependencies(preceding, match, aliases)
        : proveAddFieldsDependencies(preceding, match, aliases);
    if( !dependenciesProven )
    {
        return proveDisjointMatchPushdown(
            preceding.modifies,
            matchStage,
            match,
            preceding.operator === '$project' ? preceding : undefined,
            preceding.operator === '$project' ? undefined : aliases
        );
    }

    if(
        !arePathsDisjoint( match.dependencies.local, preceding.modifies )
        && containsGetField( matchStage.$match )
    )
    {
        return null;
    }

    const rewrittenFilter = rewriteQueryDocument(
        matchStage.$match,
        aliases,
        false,
    );
    if (!rewrittenFilter)
    {
        return null;
    }

    const rewrittenMatchStage = {
        $match: rewrittenFilter.value,
    };
    return { matchStage: rewrittenMatchStage };
}

function isObjectLiteralReplacementStage( preceding: StageSemantics ): boolean
{
    if(
        ( preceding.operator !== '$replaceRoot' && preceding.operator !== '$replaceWith' )
        || preceding.malformed
        || preceding.determinism !== 'deterministic'
        || preceding.observable.determinism !== 'deterministic'
        || !hasNoChildUncertainty( preceding )
    )
    {
        return false;
    }

    const rawSpec = ( preceding.stage as Record<string, any> )[ preceding.operator ];
    const replacementRoot = preceding.operator === '$replaceRoot'
        ? rawSpec.newRoot
        : rawSpec;

    return (
        isPlainObject( replacementRoot )
        && Object.keys( replacementRoot ).length > 0
        && Object.keys( replacementRoot ).every(( key ) => !key.startsWith( '$' ))
    );
}

/**
 * Proves one adjacent backward movement of a limit or skip stage.
 */
export function proveLimitAdvanceAcrossStage(
    precedingStage   : unknown,
    limitOrSkipStage : unknown,
    context?         : GuaranteeContext
): boolean
{
    if( context && !canMoveStageAcrossStage( limitOrSkipStage, precedingStage, 'earlier', context ))
    {
        return false;
    }

    const terminal = analyzeStage( limitOrSkipStage );

    if(
        ( terminal.operator !== '$limit' && terminal.operator !== '$skip' )
        || terminal.cardinality !== 'filters'
        || terminal.order !== 'preserves'
        || terminal.observable.cardinality !== 'filters'
        || terminal.observable.order !== 'preserves'
        || !isDeterministicErrorFree( terminal )
        || !hasNoChildUncertainty( terminal )
        || !hasKnownLocalProvenance( terminal )
        || hasAmbiguousStagePaths( terminal )
    )
    {
        return false;
    }

    const preceding = analyzeStage(precedingStage);
    if(
        PASSIVE_LIMIT_OPERATORS.has(preceding.operator)
        && isSafePassiveSummary(preceding)
    )
    {
        return true;
    }

    return !context?.strictErrors && isObjectLiteralReplacementStage( preceding );
}

const ALLOWED_LOOKUP_KEYS = new Set([
    'from',
    'localField',
    'foreignField',
    'let',
    'pipeline',
    'as'
]);

function isSupportedLookupStage( stage: unknown ): stage is {
    readonly $lookup: {
        readonly from          : string;
        readonly as            : string;
        readonly localField?   : string;
        readonly foreignField? : string;
        readonly let?          : Record<string, unknown>;
        readonly pipeline?     : readonly unknown[];
    };
}
{
    if(
        !isPlainObject( stage )
        || Object.keys( stage ).length !== 1
        || !isPlainObject( stage.$lookup )
    )
    {
        return false;
    }

    const specification = stage.$lookup;
    const keys = Object.keys( specification );

    if(
        keys.some(( key ) => !ALLOWED_LOOKUP_KEYS.has( key ))
        || typeof specification.from !== 'string'
        || specification.from.length === 0
        || typeof specification.as !== 'string'
        || relatePaths( specification.as, specification.as ) !== 'exact'
    )
    {
        return false;
    }

    const hasLocalField = 'localField' in specification;
    const hasForeignField = 'foreignField' in specification;

    if( hasLocalField !== hasForeignField )
    {
        return false;
    }

    if(
        hasLocalField
        && (
            typeof specification.localField !== 'string'
            || relatePaths( specification.localField, specification.localField ) !== 'exact'
            || typeof specification.foreignField !== 'string'
            || specification.foreignField.length === 0
        )
    )
    {
        return false;
    }

    const hasPipeline = 'pipeline' in specification;

    if( ( !hasLocalField && !hasPipeline ) || ( 'let' in specification && !hasPipeline ))
    {
        return false;
    }

    const semantics = analyzeStage( stage );

    return (
        !semantics.malformed
        && !semantics.unknown
        && !semantics.observable.unknown
        && semantics.observable.determinism === 'deterministic'
    );
}

/**
 * Delays a supported equality or pipeline lookup past an adjacent row-preserving
 * or row-reducing stage when the follower does not read the alias.
 */
export function proveLookupDelayAcrossStage(
    lookupStage        : unknown,
    followingStage     : unknown,
    context            : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT,
    downstreamPipeline : readonly unknown[] = []
): boolean
{
    if( !isSupportedLookupStage( lookupStage ))
    {
        return false;
    }

    const alias = lookupStage.$lookup.as;
    const following = analyzeStage( followingStage );
    if(
        !arePathsDisjoint( following.dependencies.local, [ alias ] )
        || !arePathsDisjoint( following.writes, [ alias ] )
        || !arePathsDisjoint( following.modifies, [ alias ] )
        || !arePathsDisjoint( following.removes, [ alias ] )
    )
    {
        return false;
    }

    if( following.operator === '$sort' )
    {
        if( !isMovementSafeSort( following ))
        {
            return false;
        }
    }
    else if( following.operator === '$match' )
    {
        if( !isSafeMatchSummary( following ))
        {
            return false;
        }
    }
    else if( following.operator !== '$limit' && following.operator !== '$skip' )
    {
        return false;
    }

    if( stageReadsFieldOrder( followingStage ))
    {
        return false;
    }

    if( !canMoveStageAcrossStage( lookupStage, followingStage, 'later', context, downstreamPipeline ))
    {
        return false;
    }

    return true;
}

const COLLAPSING_LOOKUP_KILLERS = new Set([
    '$sortByCount',
    '$bucket',
    '$bucketAuto'
]);

function isCollapsingStageIgnoringPath(
    stage   : unknown,
    alias   : string,
    context : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): boolean
{
    if( context.strictErrors )
    {
        return false;
    }

    const semantics = analyzeStage( stage );

    if(
        !COLLAPSING_LOOKUP_KILLERS.has( semantics.operator )
        || semantics.malformed
        || semantics.unknown
    )
    {
        return false;
    }

    return (
        hasOnlyKnownDependencyPaths( semantics )
        && !dependenciesReadAnyPath( semantics, [ alias ] )
    );
}

/**
 * Removes a supported equality or pipeline lookup when the next stage drops the
 * alias from the successful output.
 */
export function proveRedundantLookupElimination(
    lookupStage    : unknown,
    followingStage : unknown,
    context?       : GuaranteeContext
): boolean
{
    if( context && !canRemoveStage( lookupStage, context ))
    {
        return false;
    }

    if( !isSupportedLookupStage( lookupStage ))
    {
        return false;
    }

    return (
        isExactPathDiscardedByFollower( lookupStage.$lookup.as, followingStage )
        || isCollapsingStageIgnoringPath( followingStage, lookupStage.$lookup.as, context )
    );
}

/**
 * Removes a supported equality or pipeline lookup when a downstream suffix
 * drops the alias via `$unset`, simple `$project`, or collapsing stage without
 * any intermediate stage reading it.
 */
export function proveRedundantLookupEliminationAcrossSuffix(
    lookupStage : unknown,
    suffix      : readonly unknown[],
    context     : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): boolean
{
    if( suffix.length === 0 )
    {
        return false;
    }

    if( !canRemoveStage( lookupStage, context ) || !isSupportedLookupStage( lookupStage ))
    {
        return false;
    }

    const alias = lookupStage.$lookup.as;
    const live = new Set([ alias ]);

    for( const stage of suffix )
    {
        if(
            isExactPathDiscardedByFollower( alias, stage )
            || isCollapsingStageIgnoringPath( stage, alias, context )
        )
        {
            return true;
        }

        const semantics = analyzeStage( stage );
        if(
            dependenciesReadAnyPath( semantics, live )
            || !canContinuePastStage( semantics, live )
        )
        {
            return false;
        }
    }

    return false;
}

export interface LookupMatchSplitProof
{
    readonly pushableStage: {
        readonly $match: Record<string, unknown>;
    };
    readonly residualStage: {
        readonly $match: Record<string, unknown>;
    };
}

export interface SubpipelinePushdownProof
{
    readonly lookupStage: Record<string, unknown>;
    readonly residualStage?: {
        readonly $match: Record<string, unknown>;
    };
}

export interface LookupLimitPushdownProof
{
    readonly lookupStage: Record<string, unknown>;
}

export function proveLookupMatchSplit(
    lookupStage        : unknown,
    followingStage     : unknown,
    context            : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT,
    downstreamPipeline : readonly unknown[] = []
): LookupMatchSplitProof | null
{
    if( !isSupportedLookupStage( lookupStage ))
    {
        return null;
    }

    if( !isMatchStage( followingStage ))
    {
        return null;
    }

    const matchSemantics = analyzeStage( followingStage );

    if( !isSafeMatchSummary( matchSemantics ))
    {
        return null;
    }

    const alias = lookupStage.$lookup.as;

    if( arePathsDisjoint( matchSemantics.dependencies.local, [ alias ] ))
    {
        return null;
    }

    const conjuncts = decomposeFilterIntoConjuncts( followingStage.$match );

    if( conjuncts.length <= 1 )
    {
        return null;
    }

    const pushable: Record<string, unknown>[] = [];
    const residual: Record<string, unknown>[] = [];

    for( const conjunct of conjuncts )
    {
        const conjunctStage = { $match: conjunct };
        const conjunctSemantics = analyzeStage( conjunctStage );

        if(
            isSafeMatchSummary( conjunctSemantics )
            && arePathsDisjoint( conjunctSemantics.dependencies.local, [ alias ] )
            && !stageReadsFieldOrder( conjunctStage )
        )
        {
            pushable.push( conjunct );
        }
        else
        {
            residual.push( conjunct );
        }
    }

    if( pushable.length === 0 )
    {
        return null;
    }

    const pushableStage = { $match: combineConjuncts( pushable ) };

    if( !canMoveStageAcrossStage( pushableStage, lookupStage, 'earlier', context, downstreamPipeline ))
    {
        return null;
    }

    return {
        pushableStage,
        residualStage: { $match: combineConjuncts( residual ) }
    };
}

export function proveLookupSubpipelinePushdown(
    lookupStage : unknown,
    unwindStage : unknown,
    matchStage  : unknown,
    context     : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): SubpipelinePushdownProof | null
{
    if(
        !isPlainObject( lookupStage )
        || Object.keys( lookupStage ).length !== 1
        || !isPlainObject( lookupStage.$lookup )
    )
    {
        return null;
    }

    if( context.strictErrors && !isStageProvenErrorFree( lookupStage ))
    {
        return null;
    }

    const lookupSpec = lookupStage.$lookup as Record<string, unknown>;

    if(
        typeof lookupSpec.as !== 'string'
        || lookupSpec.as.length === 0
        || !Array.isArray( lookupSpec.pipeline )
    )
    {
        return null;
    }

    if( !isPlainObject( unwindStage ) || Object.keys( unwindStage ).length !== 1 )
    {
        return null;
    }

    const unwindSpec = ( unwindStage as Record<string, unknown> ).$unwind;
    let unwindPath: string;
    let indexField: string | undefined;

    if( typeof unwindSpec === 'string' )
    {
        if( !unwindSpec.startsWith( '$' ) || unwindSpec.length <= 1 )
        {
            return null;
        }

        unwindPath = unwindSpec.slice( 1 );
    }
    else if( isPlainObject( unwindSpec ) && typeof unwindSpec.path === 'string' )
    {
        if(
            !unwindSpec.path.startsWith( '$' )
            || unwindSpec.path.length <= 1
            || unwindSpec.preserveNullAndEmptyArrays === true
        )
        {
            return null;
        }

        unwindPath = unwindSpec.path.slice( 1 );

        if( typeof unwindSpec.includeArrayIndex === 'string' )
        {
            indexField = unwindSpec.includeArrayIndex;
        }
    }
    else
    {
        return null;
    }

    if( unwindPath !== lookupSpec.as )
    {
        return null;
    }

    if( !isMatchStage( matchStage ))
    {
        return null;
    }

    const matchSemantics = analyzeStage( matchStage );

    if( !isSafeMatchSummary( matchSemantics ))
    {
        return null;
    }

    const conjuncts = decomposeFilterIntoConjuncts( matchStage.$match );
    const prefix = lookupSpec.as + '.';
    const pushableToSub: Record<string, unknown>[] = [];
    const residual: Record<string, unknown>[] = [];

    for( const conjunct of conjuncts )
    {
        const [ key, val ] = Object.entries( conjunct )[ 0 ]!;

        if( indexField && ( key === indexField || key.startsWith( indexField + '.' )))
        {
            residual.push( conjunct );
            continue;
        }

        if( key.startsWith( prefix ))
        {
            const innerKey = key.slice( prefix.length );
            pushableToSub.push( { [ innerKey ]: deepClone( val ) } );
        }
        else if( key === lookupSpec.as && isPlainObject( val ) && isPlainObject( val.$elemMatch ))
        {
            const elemConjuncts = decomposeFilterIntoConjuncts( val.$elemMatch as Record<string, unknown> );
            pushableToSub.push( ...elemConjuncts.map(( c ) => deepClone( c )));
        }
        else
        {
            residual.push( conjunct );
        }
    }

    if( pushableToSub.length === 0 )
    {
        return null;
    }

    const newSubMatch = { $match: combineConjuncts( pushableToSub ) };
    const updatedLookup = {
        ...lookupStage,
        $lookup: {
            ...lookupSpec,
            pipeline: [ ...lookupSpec.pipeline, newSubMatch ]
        }
    };

    if( residual.length > 0 )
    {
        return {
            lookupStage: updatedLookup,
            residualStage: { $match: combineConjuncts( residual ) }
        };
    }

    return {
        lookupStage: updatedLookup
    };
}

export interface SubpipelineSuffixPushdownProof
{
    readonly lookupStage    : Record<string, unknown>;
    readonly matchOffset    : number;
    readonly residualStage? : {
        readonly $match : Record<string, unknown>;
    };
}

export function proveLookupSubpipelinePushdownAcrossSuffix(
    lookupStage : unknown,
    suffix      : readonly unknown[],
    context     : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): SubpipelineSuffixPushdownProof | null
{
    if(
        !isPlainObject( lookupStage )
        || Object.keys( lookupStage ).length !== 1
        || !isPlainObject( lookupStage.$lookup )
        || typeof lookupStage.$lookup.as !== 'string'
        || lookupStage.$lookup.as.length === 0
    )
    {
        return null;
    }

    const alias = lookupStage.$lookup.as;
    const live = new Set([ alias ]);
    let unwindStage: unknown = null;

    for( let i = 0; i < suffix.length; i++ )
    {
        const stage = suffix[ i ];

        if( unwindStage === null )
        {
            if( isUnwindForPath( stage, alias ))
            {
                unwindStage = stage;
                const entry = getSingleStageEntry( stage )!;
                const spec = entry[ 1 ];
                if( isPlainObject( spec ) && typeof spec.includeArrayIndex === 'string' )
                {
                    live.add( spec.includeArrayIndex );
                }
                continue;
            }
        }
        else if( isMatchStage( stage ))
        {
            const proof = proveLookupSubpipelinePushdown( lookupStage, unwindStage, stage, context );
            if( proof )
            {
                return {
                    lookupStage : proof.lookupStage,
                    matchOffset : i + 1,
                    ...( proof.residualStage ? { residualStage: proof.residualStage } : {} )
                };
            }
        }

        const semantics = analyzeStage( stage );
        if(
            dependenciesReadAnyPath( semantics, live )
            || !canContinuePastStage( semantics, live )
            || ( context.strictErrors && !isStageProvenErrorFree( stage ))
        )
        {
            return null;
        }
    }

    return null;
}

function hasTerminalLimitAtMost( pipeline: readonly unknown[], limitVal: number ): boolean
{
    if( pipeline.length === 0 ){ return false }

    const last = pipeline[ pipeline.length - 1 ];
    const entry = getSingleStageEntry( last );
    if( !entry ){ return false }

    return (
        entry[ 0 ] === '$limit'
        && typeof entry[ 1 ] === 'number'
        && Number.isSafeInteger( entry[ 1 ] )
        && entry[ 1 ] > 0
        && entry[ 1 ] <= limitVal
    );
}

function pushLimitToSubpipeline( pipeline: readonly unknown[], limitVal: number ): unknown[]
{
    const copy = deepClone( pipeline ) as unknown[];

    if( copy.length > 0 )
    {
        const last = copy[ copy.length - 1 ];
        const entry = getSingleStageEntry( last );

        if( entry && entry[ 0 ] === '$limit' )
        {
            copy[ copy.length - 1 ] = { $limit: limitVal };
            return copy;
        }
    }

    copy.push( { $limit: limitVal } );
    return copy;
}

function extractUnwindFollowerLimit( followingStages: readonly unknown[] ): number | null
{
    const second = getSingleStageEntry( followingStages[ 1 ] );
    if( !second ){ return null }

    if(
        second[ 0 ] === '$limit'
        && typeof second[ 1 ] === 'number'
        && Number.isSafeInteger( second[ 1 ] )
        && second[ 1 ] > 0
    )
    {
        return second[ 1 ];
    }

    if(
        second[ 0 ] === '$skip'
        && typeof second[ 1 ] === 'number'
        && Number.isSafeInteger( second[ 1 ] )
        && second[ 1 ] >= 0
        && followingStages.length >= 3
    )
    {
        const third = getSingleStageEntry( followingStages[ 2 ] );

        if(
            third
            && third[ 0 ] === '$limit'
            && typeof third[ 1 ] === 'number'
            && Number.isSafeInteger( third[ 1 ] )
            && third[ 1 ] > 0
            && Number.isSafeInteger( second[ 1 ] + third[ 1 ] )
        )
        {
            return second[ 1 ] + third[ 1 ];
        }
    }

    return null;
}

function isUnwindForPath( stage: unknown, alias: string ): boolean
{
    const entry = getSingleStageEntry( stage );
    if( !entry || entry[ 0 ] !== '$unwind' ){ return false }

    const unwind = entry[ 1 ];
    const target = `$${ alias }`;

    if( typeof unwind === 'string' )
    {
        return unwind === target;
    }

    if( isPlainObject( unwind ) && typeof unwind.path === 'string' )
    {
        return unwind.path === target;
    }

    return false;
}

function isDirectAliasReference( arg: unknown, alias: string ): boolean
{
    return (
        arg === `$${ alias }`
        || arg === `$$ROOT.${ alias }`
        || arg === `$$CURRENT.${ alias }`
    );
}

function extractHeadLimitExpression( expr: unknown, alias: string ): number | null
{
    if( !isPlainObject( expr ) ){ return null }

    const keys = Object.keys( expr );
    if( keys.length !== 1 ){ return null }

    const op = keys[ 0 ];

    if( op === '$first' )
    {
        const rawArg = ( expr as Record<string, unknown> ).$first;
        const arg = Array.isArray( rawArg ) && rawArg.length === 1
            ? rawArg[ 0 ]
            : rawArg;

        return isDirectAliasReference( arg, alias )
            ? 1
            : null;
    }

    if( op === '$arrayElemAt' )
    {
        const args = ( expr as Record<string, unknown> ).$arrayElemAt;
        if( !Array.isArray( args ) || args.length !== 2 ){ return null }

        return isDirectAliasReference( args[ 0 ], alias ) && args[ 1 ] === 0
            ? 1
            : null;
    }

    if( op === '$slice' )
    {
        const args = ( expr as Record<string, unknown> ).$slice;
        if( !Array.isArray( args ) || ( args.length !== 2 && args.length !== 3 )){ return null }

        if( args.length === 2 )
        {
            const [ arrArg, countArg ] = args;
            if(
                isDirectAliasReference( arrArg, alias )
                && typeof countArg === 'number'
                && Number.isSafeInteger( countArg )
                && countArg > 0
            )
            {
                return countArg;
            }
            return null;
        }

        const [ arrArg, skipArg, countArg ] = args;
        if(
            isDirectAliasReference( arrArg, alias )
            && skipArg === 0
            && typeof countArg === 'number'
            && Number.isSafeInteger( countArg )
            && countArg > 0
        )
        {
            return countArg;
        }
    }

    return null;
}

function containsPathReference( value: unknown, alias: string ): boolean
{
    if( typeof value === 'string' )
    {
        if( value.startsWith( '$' ))
        {
            const path = value.startsWith( '$$ROOT.' )
                ? value.slice( 7 )
                : value.startsWith( '$$CURRENT.' )
                    ? value.slice( 10 )
                    : value.startsWith( '$$' )
                        ? ''
                        : value.slice( 1 );

            return path === alias || path.startsWith( `${ alias }.` );
        }

        return false;
    }

    if( Array.isArray( value ))
    {
        return value.some(( item ) => containsPathReference( item, alias ));
    }

    if( isPlainObject( value ))
    {
        for( const [ k, v ] of Object.entries( value ))
        {
            if( containsPathReference( k, alias ) || containsPathReference( v, alias ))
            {
                return true;
            }
        }
    }

    return false;
}

function extractStageHeadLimit(
    stage            : unknown,
    alias            : string,
    subsequentStages : readonly unknown[]
): number | null
{
    const entry = getSingleStageEntry( stage );
    if( !entry ){ return null }

    const [ op, spec ] = entry;
    if( op !== '$addFields' && op !== '$set' && op !== '$project' )
    {
        return null;
    }

    if( !isPlainObject( spec ) ){ return null }

    let maxLimit = 0;

    for( const [ fieldName, fieldValue ] of Object.entries( spec ))
    {
        if( fieldName.startsWith( `${ alias }.` ))
        {
            return null;
        }

        if( containsPathReference( fieldValue, alias ))
        {
            const headLimit = extractHeadLimitExpression( fieldValue, alias );
            if( headLimit === null )
            {
                return null;
            }

            if( headLimit > maxLimit )
            {
                maxLimit = headLimit;
            }
        }
    }

    if( maxLimit === 0 )
    {
        return null;
    }

    const overwritesAlias = op === '$project'
        ? ( alias in spec && spec[ alias ] !== 1 && spec[ alias ] !== true )
        : ( alias in spec );
    if( overwritesAlias )
    {
        return maxLimit;
    }

    if( op === '$project' )
    {
        const semantics = analyzeStage( stage );
        const vis = projectionVisibility( semantics.projection!, alias );

        if( vis === 'hidden' )
        {
            return maxLimit;
        }
    }

    if( subsequentStages.length > 0 )
    {
        const follower = subsequentStages[ 0 ];

        if( isExactPathDiscardedByFollower( alias, follower ))
        {
            return maxLimit;
        }
    }

    return null;
}

export function proveLookupLimitPushdown(
    lookupStage     : unknown,
    followingStages : readonly unknown[],
    context         : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): LookupLimitPushdownProof | null
{
    const entry = getSingleStageEntry( lookupStage );
    if( !entry || entry[ 0 ] !== '$lookup' || !isPlainObject( entry[ 1 ] ))
    {
        return null;
    }

    if( context.strictErrors && !isStageProvenErrorFree( lookupStage ))
    {
        return null;
    }

    const lookupSpec = entry[ 1 ] as Record<string, unknown>;

    if(
        typeof lookupSpec.as !== 'string'
        || lookupSpec.as.length === 0
        || !Array.isArray( lookupSpec.pipeline )
    )
    {
        return null;
    }

    if( followingStages.length === 0 )
    {
        return null;
    }

    if( followingStages.length >= 2 )
    {
        const firstFollower = followingStages[ 0 ];
        const unwindLimit = extractUnwindFollowerLimit( followingStages );

        if( isUnwindForPath( firstFollower, lookupSpec.as ) && unwindLimit !== null )
        {
            if( hasTerminalLimitAtMost( lookupSpec.pipeline, unwindLimit ))
            {
                return null;
            }

            const updatedLookup = {
                ...( lookupStage as Record<string, unknown> ),
                $lookup: {
                    ...lookupSpec,
                    pipeline: pushLimitToSubpipeline( lookupSpec.pipeline, unwindLimit )
                }
            };

            return { lookupStage: updatedLookup };
        }
    }

    const firstFollower = followingStages[ 0 ];
    const headLimit = extractStageHeadLimit( firstFollower, lookupSpec.as, followingStages.slice( 1 ));
    if( headLimit !== null )
    {
        if( hasTerminalLimitAtMost( lookupSpec.pipeline, headLimit ))
        {
            return null;
        }

        if( context.strictErrors && !isStageProvenErrorFree( firstFollower ))
        {
            return null;
        }

        const updatedLookup = {
            ...( lookupStage as Record<string, unknown> ),
            $lookup: {
                ...lookupSpec,
                pipeline: pushLimitToSubpipeline( lookupSpec.pipeline, headLimit )
            }
        };

        return { lookupStage: updatedLookup };
    }

    return null;
}

export function proveLookupSubpipelineFieldPruning(
    lookupStage     : unknown,
    followingStages : readonly unknown[],
    context         : GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT
): LookupLimitPushdownProof | null
{
    if( context.strictFieldOrder || followingStages.length === 0 )
    {
        return null;
    }

    const entry = getSingleStageEntry( lookupStage );
    if( !entry || entry[ 0 ] !== '$lookup' || !isPlainObject( entry[ 1 ] ))
    {
        return null;
    }

    if( context.strictErrors && !isStageProvenErrorFree( lookupStage ))
    {
        return null;
    }

    const lookupSpec = entry[ 1 ] as Record<string, unknown>;
    if(
        typeof lookupSpec.as !== 'string'
        || lookupSpec.as.length === 0
        || !Array.isArray( lookupSpec.pipeline )
    )
    {
        return null;
    }

    const lastSub = lookupSpec.pipeline.length > 0
        ? getSingleStageEntry( lookupSpec.pipeline[ lookupSpec.pipeline.length - 1 ] )
        : null;
    if( lastSub && lastSub[ 0 ] === '$project' )
    {
        return null;
    }

    const alias = lookupSpec.as;
    const targetStage = isUnwindForPath( followingStages[ 0 ], alias )
        ? followingStages[ 1 ]
        : followingStages[ 0 ];

    const targetEntry = getSingleStageEntry( targetStage );
    if( !targetEntry || targetEntry[ 0 ] !== '$project' || !isPlainObject( targetEntry[ 1 ] ))
    {
        return null;
    }

    const projSpec = targetEntry[ 1 ] as Record<string, unknown>;
    const projSem = analyzeStage( targetStage );
    if(
        projSem.malformed
        || projSem.unknown
        || !projSem.projection
        || projSem.projection.unknown
        || projSem.projection.mode !== 'inclusion'
        || !hasOnlyKnownDependencyPaths( projSem )
        || containsGetField( projSpec )
        || alias in projSpec
        || projSem.dependencies.local.has( alias )
    )
    {
        return null;
    }

    const prefix = `${ alias }.`;
    const subFields = new Set<string>();

    for( const dep of projSem.dependencies.local )
    {
        if( dep.startsWith( prefix ))
        {
            subFields.add( dep.slice( prefix.length ).split( '.' )[ 0 ]! );
        }
    }

    for( const inc of projSem.projection.includedPaths )
    {
        if( inc.startsWith( prefix ))
        {
            subFields.add( inc.slice( prefix.length ).split( '.' )[ 0 ]! );
        }
    }

    if( subFields.size === 0 )
    {
        return null;
    }

    const subProject: Record<string, unknown> = {};
    if( !subFields.has( '_id' ))
    {
        subProject._id = 0;
    }

    for( const f of Array.from( subFields ).sort() )
    {
        subProject[ f ] = 1;
    }

    return {
        lookupStage: {
            ...( lookupStage as Record<string, unknown> ),
            $lookup: {
                ...lookupSpec,
                pipeline: [
                    ...( deepClone( lookupSpec.pipeline ) as unknown[] ),
                    { $project: subProject }
                ]
            }
        }
    };
}

/**
 * The contained priority pass can only reuse an existing pair-specific proof.
 */
export function provePrioritySwap(
    leftStage: unknown,
    rightStage: unknown,
): readonly [unknown, unknown] | null
{
    const right = analyzeStage(rightStage);
    if (right.operator === "$match")
    {
        const proof = proveMatchPushdownAcrossStage(leftStage, rightStage);
        return proof && !proof.residualStage
            ? [proof.matchStage, leftStage]
            : null;
    }

    if (
        (right.operator === "$limit" || right.operator === "$skip")
        && proveLimitAdvanceAcrossStage(leftStage, rightStage)
    )
    {
        return [rightStage, leftStage];
    }

    return null;
}
