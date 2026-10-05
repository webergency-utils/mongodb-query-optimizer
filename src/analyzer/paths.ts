export const WILDCARD_PATH = '*';
export const UNKNOWN_PATH = '?';

export type PathRelation =
    | 'exact'
    | 'ancestor'
    | 'descendant'
    | 'disjoint'
    | 'wildcard'
    | 'removed'
    | 'unknown';

export type PathEffect =
    | { readonly kind: 'exact'; readonly path: string }
    | { readonly kind: 'wildcard' }
    | { readonly kind: 'removed'; readonly path: string }
    | { readonly kind: 'unknown' };

function normalizePath(path: string): string | null
{
    if (typeof path !== 'string')
    {
        return null;
    }

    const normalized = path.startsWith('$') && !path.startsWith('$$')
        ? path.slice(1)
        : path;

    if (
        normalized.length === 0
        || normalized === UNKNOWN_PATH
        || normalized.startsWith('$$')
        || normalized.split('.').some((part) => part.length === 0)
    )
    {
        return null;
    }

    return normalized;
}

export function exactPath(path: string): PathEffect
{
    const normalized = normalizePath(path);
    return normalized === null
        ? unknownPath()
        : { kind: 'exact', path: normalized };
}

export function removedPath(path: string): PathEffect
{
    const normalized = normalizePath(path);
    return normalized === null
        ? unknownPath()
        : { kind: 'removed', path: normalized };
}

export function wildcardPath(): PathEffect
{
    return { kind: 'wildcard' };
}

export function unknownPath(): PathEffect
{
    return { kind: 'unknown' };
}

export function relatePaths(left: string, right: string): Exclude<PathRelation, 'removed'>
{
    if (left === UNKNOWN_PATH || right === UNKNOWN_PATH)
    {
        return 'unknown';
    }

    if (left === WILDCARD_PATH || right === WILDCARD_PATH)
    {
        return 'wildcard';
    }

    const normalizedLeft = normalizePath(left);
    const normalizedRight = normalizePath(right);

    if (normalizedLeft === null || normalizedRight === null)
    {
        return 'unknown';
    }

    if (normalizedLeft === normalizedRight)
    {
        return 'exact';
    }

    if (normalizedRight.startsWith(`${normalizedLeft}.`))
    {
        return "ancestor";
    }

    if (normalizedLeft.startsWith(`${normalizedRight}.`))
    {
        return "descendant";
    }

    return "disjoint";
}

export function relatePathEffects(
    effect: PathEffect,
    path: string,
): PathRelation
{
    if (effect.kind === "unknown")
    {
        return "unknown";
    }

    if (effect.kind === "wildcard")
    {
        return "wildcard";
    }

    const relation = relatePaths(effect.path, path);
    if (
        effect.kind === "removed"
        && (relation === "exact" || relation === "ancestor" || relation === "wildcard")
    )
    {
        return "removed";
    }

    return relation;
}

/**
 * Returns true only when producing `availablePath` makes the complete
 * `requiredPath` available. Producing a child creates a partial parent and
 * therefore never covers a parent read.
 */
export function pathCovers(availablePath: string, requiredPath: string): boolean
{
    const relation = relatePaths(availablePath, requiredPath);
    return relation === "exact"
        || relation === "ancestor"
        || relation === "wildcard";
}

export function pathsOverlap(left: string, right: string): boolean
{
    const relation = relatePaths(left, right);
    return relation !== "disjoint" && relation !== "unknown";
}

export function anyPathCovers(
    availablePaths: Iterable<string>,
    requiredPath: string,
): boolean
{
    for (const availablePath of availablePaths)
    {
        if (pathCovers(availablePath, requiredPath))
        {
            return true;
        }
    }

    return false;
}

export interface PathCollision
{
    readonly left: string;
    readonly right: string;
    readonly relation: "ancestor" | "descendant";
}

export function findPathCollisions(paths: Iterable<string>): PathCollision[]
{
    const values = Array.from(new Set(paths));
    const collisions: PathCollision[] = [];

    for (let leftIndex = 0; leftIndex < values.length; leftIndex++)
    {
        for (let rightIndex = leftIndex + 1; rightIndex < values.length; rightIndex++)
        {
            const left = values[leftIndex]!;
            const right = values[rightIndex]!;
            const relation = relatePaths(left, right);

            if (relation === "ancestor" || relation === "descendant")
            {
                collisions.push({ left, right, relation });
            }
        }
    }

    return collisions;
}
