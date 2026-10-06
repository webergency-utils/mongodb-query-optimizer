import { relatePaths } from '../analyzer/paths';
import {
    projectionVisibility,
} from '../analyzer/projections';
import { analyzeStage } from '../analyzer/semantics';
import {
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
    isMatchStage,
} from './helpers.js';

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

function isSafeMatchSummary(stage: StageSemantics): boolean
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

function arePathsDisjoint(
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

function pathOverlaps(path: string, effects: Iterable<string>): boolean
{
    for (const effect of effects)
    {
        if (relatePaths(path, effect) !== 'disjoint')
        {
            return true;
        }
    }

    return false;
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

function rewriteQueryDocument(
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

function isSafeSortStage(stage: StageSemantics): boolean
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
    modifiedPaths: Iterable<string>,
    matchStage: { readonly $match: Record<string, unknown> },
    match: StageSemantics
): MatchPushdownProof | null
{
    if( arePathsDisjoint( match.dependencies.local, modifiedPaths ))
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

        if(
            isSafeMatchSummary( conjunctSemantics )
            && arePathsDisjoint( conjunctSemantics.dependencies.local, modifiedPaths )
        )
        {
            pushable.push( conjunct );
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

function containsGetField( value: unknown ): boolean
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
    precedingStage: unknown,
    matchStage: unknown,
): MatchPushdownProof | null
{
    const match = analyzeStage(matchStage);
    if (!isSafeMatchSummary(match) || !isMatchStage(matchStage))
    {
        return null;
    }

    const preceding = analyzeStage(precedingStage);
    if (isSafeSortStage(preceding))
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

    if (preceding.operator === "$unset")
    {
        return arePathsDisjoint(
            match.dependencies.local,
            preceding.removes,
        )
            ? { matchStage }
            : null;
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
    if (!dependenciesProven)
    {
        return null;
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

/**
 * Proves one adjacent backward movement of a limit or skip stage.
 */
export function proveLimitAdvanceAcrossStage(
    precedingStage: unknown,
    limitOrSkipStage: unknown,
): boolean
{
    const terminal = analyzeStage(limitOrSkipStage);
    if (
        (terminal.operator !== "$limit" && terminal.operator !== "$skip")
        || terminal.cardinality !== "filters"
        || terminal.order !== "preserves"
        || terminal.observable.cardinality !== "filters"
        || terminal.observable.order !== "preserves"
        || !isDeterministicErrorFree(terminal)
        || !hasNoChildUncertainty(terminal)
        || !hasKnownLocalProvenance(terminal)
        || hasAmbiguousStagePaths(terminal)
    )
    {
        return false;
    }

    const preceding = analyzeStage(precedingStage);
    return (
        PASSIVE_LIMIT_OPERATORS.has(preceding.operator)
        && isSafePassiveSummary(preceding)
    );
}

function isSimpleEqualityLookup(stage: unknown): stage is {
    readonly $lookup: {
        readonly from: string;
        readonly localField: string;
        readonly foreignField: string;
        readonly as: string;
    };
}
{
    if (
        !isPlainObject(stage)
        || Object.keys(stage).length !== 1
        || !isPlainObject(stage.$lookup)
    )
    {
        return false;
    }

    const specification = stage.$lookup;
    const keys = Object.keys(specification);
    return (
        keys.length === 4
        && keys.includes("from")
        && keys.includes("localField")
        && keys.includes("foreignField")
        && keys.includes("as")
        && typeof specification.from === "string"
        && specification.from.length > 0
        && typeof specification.foreignField === "string"
        && specification.foreignField.length > 0
        && typeof specification.localField === "string"
        && relatePaths(specification.localField, specification.localField) === "exact"
        && typeof specification.as === "string"
        && relatePaths(specification.as, specification.as) === "exact"
    );
}

function isSafeLimitOrSkipSummary(stage: StageSemantics): boolean
{
    return (
        (stage.operator === "$limit" || stage.operator === "$skip")
        && stage.cardinality === "filters"
        && stage.order === "preserves"
        && stage.observable.cardinality === "filters"
        && stage.observable.order === "preserves"
        && isDeterministicErrorFree(stage)
        && hasNoChildUncertainty(stage)
        && hasKnownLocalProvenance(stage)
        && !hasAmbiguousStagePaths(stage)
    );
}

/**
 * Delays a simple equality lookup past an adjacent row-preserving or
 * row-reducing stage when the follower does not read the alias. Lookup
 * execution errors are treated as out of scope for this proof.
 */
export function proveLookupDelayAcrossStage(
    lookupStage: unknown,
    followingStage: unknown,
): boolean
{
    if (!isSimpleEqualityLookup(lookupStage))
    {
        return false;
    }

    const alias = lookupStage.$lookup.as;
    const following = analyzeStage(followingStage);
    if (
        !arePathsDisjoint(following.dependencies.local, [alias])
        || !arePathsDisjoint(following.writes, [alias])
        || !arePathsDisjoint(following.modifies, [alias])
        || !arePathsDisjoint(following.removes, [alias])
    )
    {
        return false;
    }

    if (following.operator === "$sort")
    {
        return isSafeSortStage(following);
    }

    if (following.operator === "$limit" || following.operator === "$skip")
    {
        return isSafeLimitOrSkipSummary(following);
    }

    return following.operator === "$match" && isSafeMatchSummary(following);
}

/**
 * Removes a simple equality lookup when the next stage drops the alias from
 * the successful output. Lookup execution errors are out of scope.
 */
export function proveRedundantLookupElimination(
    lookupStage: unknown,
    followingStage: unknown,
): boolean
{
    if (!isSimpleEqualityLookup(lookupStage))
    {
        return false;
    }

    return isExactPathDiscardedByFollower(
        lookupStage.$lookup.as,
        followingStage,
    );
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

export function proveLookupMatchSplit(
    lookupStage: unknown,
    followingStage: unknown
): LookupMatchSplitProof | null
{
    if( !isSimpleEqualityLookup( lookupStage ))
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
        const conjunctSemantics = analyzeStage( { $match: conjunct } );

        if(
            isSafeMatchSummary( conjunctSemantics )
            && arePathsDisjoint( conjunctSemantics.dependencies.local, [ alias ] )
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

    return {
        pushableStage: { $match: combineConjuncts( pushable ) },
        residualStage: { $match: combineConjuncts( residual ) }
    };
}

export function proveLookupSubpipelinePushdown(
    lookupStage: unknown,
    unwindStage: unknown,
    matchStage: unknown
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
