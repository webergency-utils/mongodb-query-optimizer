import { StageInfo } from '../analyzer/types';
import { optimizeFilter } from '../filter-optimizer';
import { isEqual } from '../utils';

export function pathsIntersect(p1: string, p2: string): boolean {
    if (p1 === '*' || p2 === '*') return true;
    if (p1 === p2) return true;
    return p1.startsWith(p2 + '.') || p2.startsWith(p1 + '.');
}

export function setsIntersect(s1: Set<string>, s2: Set<string>): boolean {
    for (const p1 of s1) {
        for (const p2 of s2) {
            if (pathsIntersect(p1, p2)) {
                return true;
            }
        }
    }
    return false;
}

export function isSubsetOfProduced(used: Set<string>, produced: Set<string>): boolean {
    for (const u of used) {
        let matched = false;
        for (const p of produced) {
            if (u === p || u.startsWith(p + '.') || p.startsWith(u + '.')) {
                matched = true;
                break;
            }
        }
        if (!matched) return false;
    }
    return true;
}

export function canSwap(a: StageInfo, b: StageInfo): boolean {
    if (a.isUnknown || b.isUnknown) return false;

    // 1. Read-after-write check: b cannot use fields modified by a
    if (setsIntersect(b.usedFields, a.modifiedFields)) return false;

    // 2. Write-after-read check: a cannot use fields modified by b
    if (setsIntersect(a.usedFields, b.modifiedFields)) return false;

    // 3. Write-after-write check: cannot modify the same fields
    if (setsIntersect(a.modifiedFields, b.modifiedFields)) return false;

    // 4. Removal conflicts
    if (setsIntersect(a.removedFields, b.usedFields)) return false;
    if (setsIntersect(b.removedFields, a.usedFields)) return false;

    // 5. Destructive stage check
    if (a.isDestructive && !isSubsetOfProduced(b.usedFields, a.producedFields)) {
        return false;
    }
    if (b.isDestructive && !isSubsetOfProduced(a.usedFields, b.producedFields)) {
        return false;
    }

    // 6. Count alteration ordering
    if (a.altersCount && b.altersCount) {
        const allowed = (a.operator === '$match' && b.operator === '$unwind') ||
                                        (a.operator === '$unwind' && b.operator === '$match');
        if (!allowed) {
            return false;
        }
    }

    // 7. Limit/Skip/Sample ordering restrictions
    const isLimitOrSkipOrSample = (op: string) => op === '$limit' || op === '$skip' || op === '$sample';
    if (isLimitOrSkipOrSample(a.operator) || isLimitOrSkipOrSample(b.operator)) {
        const passiveOperators = new Set(['$project', '$addFields', '$set', '$unset', '$lookup']);
        if (isLimitOrSkipOrSample(a.operator)) {
            if (!passiveOperators.has(b.operator)) return false;
        }
        if (isLimitOrSkipOrSample(b.operator)) {
            if (!passiveOperators.has(a.operator)) return false;
        }
    }

    return true;
}

export function isMatchStage(stage: any): boolean {
    return stage && typeof stage === 'object' && '$match' in stage;
}

export function splitFilterConditions(filter: any): any[] {
    if (!filter || typeof filter !== 'object') return [filter];
    if (Array.isArray(filter)) return [filter];

    const keys = Object.keys(filter);
    if (keys.length === 1 && keys[0] === '$and' && Array.isArray(filter.$and)) {
        return filter.$and.flatMap((c: any) => splitFilterConditions(c));
    }

    if (keys.length > 1 && !keys.some(k => k.startsWith('$'))) {
        return keys.map(k => ({ [k]: filter[k] }));
    }

    return [filter];
}

export function isSimpleMatchCondition(cond: any, unwindPath: string): boolean {
    if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return false;
    const keys = Object.keys(cond);
    if (keys.length !== 1) return false;
    const key = keys[0];
    if (key.startsWith('$')) return false;
    if (key !== unwindPath && !key.startsWith(unwindPath + '.')) return false;

    const val = cond[key];
    if (!val || typeof val !== 'object' || val instanceof Date || val instanceof RegExp) {
        return true;
    }

    const opKeys = Object.keys(val);
    const allowedOps = new Set(['$eq', '$gt', '$gte', '$lt', '$lte', '$in']);
    return opKeys.every(k => allowedOps.has(k));
}

export function filterContainsCondition(parentFilter: any, cond: any): boolean {
    if (!parentFilter || !cond) return false;
    if (isEqual(parentFilter, cond)) return true;

    if (typeof parentFilter === 'object' && typeof cond === 'object') {
        if (Array.isArray(parentFilter.$and)) {
            if (parentFilter.$and.some((sub: any) => filterContainsCondition(sub, cond))) {
                return true;
            }
        }
        
        const condKeys = Object.keys(cond);
        if (condKeys.length > 0 && condKeys.every(k => k in parentFilter && isEqual(parentFilter[k], cond[k]))) {
            return true;
        }
    }
    return false;
}

export function extractRenamings(spec: any, prefix = ''): Map<string, string> {
    const renamings = new Map<string, string>();
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        return renamings;
    }
    for (const [k, v] of Object.entries(spec)) {
        const currentPath = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'string') {
            if (v.startsWith('$') && !v.startsWith('$$')) {
                renamings.set(currentPath, v.slice(1));
            }
        } else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp)) {
            const keys = Object.keys(v);
            const isExpr = keys.some(key => key.startsWith('$'));
            if (!isExpr) {
                const sub = extractRenamings(v, currentPath);
                for (const [subK, subV] of sub.entries()) {
                    renamings.set(subK, subV);
                }
            }
        }
    }
    return renamings;
}

export function rewriteKey(key: string, renamings: Map<string, string>): string | null {
    const sortedRenamings = Array.from(renamings.entries()).sort((a, b) => b[0].length - a[0].length);
    for (const [target, source] of sortedRenamings) {
        if (key === target) {
            return source;
        }
        if (key.startsWith(target + '.')) {
            return source + key.slice(target.length);
        }
    }
    return null;
}

export function rewriteFilter(
    filter: any,
    renamings: Map<string, string>,
    modifiedFields: Set<string>,
    isDestructive = false,
    producedFields = new Set<string>()
): any | null {
    if (filter === null || filter === undefined) return filter;
    if (filter instanceof RegExp || filter instanceof Date) return filter;
    
    if (Array.isArray(filter)) {
        const rewrittenItems = [];
        for (const item of filter) {
            const rew = rewriteFilter(item, renamings, modifiedFields, isDestructive, producedFields);
            if (rew === null) return null;
            rewrittenItems.push(rew);
        }
        return rewrittenItems;
    }
    
    if (typeof filter === 'object') {
        const result: any = {};
        for (const [k, v] of Object.entries(filter)) {
            if (k.startsWith('$')) {
                const rew = rewriteFilter(v, renamings, modifiedFields, isDestructive, producedFields);
                if (rew === null) return null;
                result[k] = rew;
            } else {
                const newKey = rewriteKey(k, renamings);
                if (newKey !== null) {
                    const rew = rewriteFilter(v, renamings, modifiedFields, isDestructive, producedFields);
                    if (rew === null) return null;
                    result[newKey] = rew;
                } else {
                    const isDiscardedOrModified = modifiedFields.has('*') ||
                                                                                modifiedFields.has(k) ||
                                                                                Array.from(modifiedFields).some(f => k === f || k.startsWith(f + '.') || f.startsWith(k + '.'));
                    if (isDiscardedOrModified) {
                        return null;
                    }
                    if (isDestructive) {
                        const isProduced = producedFields.has('*') ||
                               producedFields.has(k) ||
                               Array.from(producedFields).some(f => k.startsWith(f + '.'));
                        if (!isProduced) {
                            return null;
                        }
                    }
                    const rew = rewriteFilter(v, renamings, modifiedFields, isDestructive, producedFields);
                    if (rew === null) return null;
                    result[k] = rew;
                }
            }
        }
        return result;
    }
    return filter;
}
