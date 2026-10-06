import { findPathCollisions, relatePaths } from './paths';
import {
    IdProjection,
    PathVisibility,
    ProjectionMode,
    ProjectionSummary,
} from './types';

export type ProjectionOperation = 'project' | 'add-fields';

function isProjectionObject(value: unknown): value is Record<string, unknown>
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isValidProjectionPath(path: string): boolean
{
    return path.length > 0
        && !path.startsWith('$')
        && path.split('.').every((part) => part.length > 0);
}

function classifyProjectionValue(value: unknown): 'include' | 'exclude' | 'computed'
{
    if (value === 1 || value === true)
    {
        return 'include';
    }

    if (value === 0 || value === false)
    {
        return 'exclude';
    }

    return 'computed';
}

function classifyId(
    value: unknown,
    operation: ProjectionOperation,
): IdProjection
{
    if (operation === 'add-fields')
    {
        return 'computed';
    }

    const classification = classifyProjectionValue(value);
    if (classification === 'include')
    {
        return 'included';
    }

    if (classification === 'exclude')
    {
        return 'excluded';
    }

    return 'computed';
}

function determineProjectMode(
    includes: number,
    excludes: number,
    computes: number,
    id: IdProjection,
): ProjectionMode
{
    if (excludes > 0 && (includes > 0 || computes > 0))
    {
        return 'mixed';
    }

    if (excludes > 0)
    {
        return 'exclusion';
    }

    if (includes > 0 || computes > 0)
    {
        return 'inclusion';
    }

    if (id === 'excluded')
    {
        return 'exclusion';
    }

    if (id === 'included' || id === 'computed')
    {
        return 'inclusion';
    }

    return 'unknown';
}

export function analyzeProjection(
    specification: unknown,
    operation: ProjectionOperation = 'project',
): ProjectionSummary
{
    const includedPaths = new Set<string>();
    const excludedPaths = new Set<string>();
    const computedPaths = new Set<string>();

    if (!isProjectionObject(specification))
    {
        return {
            mode: 'unknown',
            id: 'unknown',
            includedPaths,
            excludedPaths,
            computedPaths,
            shieldsOmittedFields: true,
            collisions: [],
            hasPathCollisions: false,
            unknown: true,
        };
    }

    const entries = Object.entries(specification);
    let id: IdProjection = 'default-included';
    let includes = 0;
    let excludes = 0;
    let computes = 0;
    let invalidPath = false;

    for (const [path, value] of entries)
    {
        if (!isValidProjectionPath(path))
        {
            invalidPath = true;
            continue;
        }

        if (path === '_id')
        {
            id = classifyId(value, operation);
        }

        if (operation === 'add-fields')
        {
            computedPaths.add(path);
            if (path !== '_id')
            {
                computes++;
            }
            continue;
        }

        const classification = classifyProjectionValue(value);
        if (classification === 'include')
        {
            includedPaths.add(path);
            if (path !== '_id')
            {
                includes++;
            }
        }
        else if (classification === 'exclude')
        {
            excludedPaths.add(path);
            if (path !== '_id')
            {
                excludes++;
            }
        }
        else
        {
            computedPaths.add(path);
            if (path !== '_id')
            {
                computes++;
            }
        }
    }

    const mode = operation === 'add-fields'
        ? 'add-fields'
        : determineProjectMode(includes, excludes, computes, id);
    const collisions = findPathCollisions(entries.map(([path]) => path));
    const unknown = invalidPath
        || entries.length === 0
        || mode === 'unknown'
        || mode === 'mixed'
        || collisions.length > 0;

    return {
        mode,
        id,
        includedPaths,
        excludedPaths,
        computedPaths,
        shieldsOmittedFields: mode === 'inclusion' || mode === 'mixed' || mode === 'unknown',
        collisions,
        hasPathCollisions: collisions.length > 0,
        unknown,
    };
}

function idVisibility(summary: ProjectionSummary): PathVisibility
{
    if (summary.id === 'excluded')
    {
        return 'removed';
    }

    if (summary.id === 'unknown')
    {
        return 'unknown';
    }

    return 'visible';
}

export function projectionVisibility(
    summary: ProjectionSummary,
    path: string,
): PathVisibility
{
    if (path === '_id' || path.startsWith('_id.'))
    {
        return idVisibility(summary);
    }

    if (summary.mode === 'unknown' || summary.mode === 'mixed')
    {
        return 'unknown';
    }

    if (summary.mode === 'add-fields')
    {
        for (const computedPath of summary.computedPaths)
        {
            if (
                relatePaths(computedPath, path) === 'ancestor'
                && computedPath !== path
            )
            {
                return 'unknown';
            }
        }

        return 'visible';
    }

    if (summary.mode === 'exclusion')
    {
        let partial = false;
        for (const excludedPath of summary.excludedPaths)
        {
            const relation = relatePaths(excludedPath, path);
            if (relation === 'exact' || relation === 'ancestor')
            {
                return 'removed';
            }
            if (relation === 'descendant')
            {
                partial = true;
            }
            if (relation === 'wildcard' || relation === 'unknown')
            {
                return 'unknown';
            }
        }

        return partial ? 'partial' : 'visible';
    }

    let partial = false;
    for (const includedPath of summary.includedPaths)
    {
        const relation = relatePaths(includedPath, path);
        if (relation === 'exact' || relation === 'ancestor')
        {
            return 'visible';
        }
        if (relation === 'descendant')
        {
            partial = true;
        }
    }

    for (const computedPath of summary.computedPaths)
    {
        const relation = relatePaths(computedPath, path);
        if (relation === 'exact')
        {
            return 'visible';
        }
        if (relation === 'ancestor')
        {
            return 'unknown';
        }
        if (relation === 'descendant')
        {
            partial = true;
        }
    }

    return partial ? 'partial' : 'hidden';
}
