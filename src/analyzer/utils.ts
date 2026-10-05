export function extractExpressionFields(expr: any, used: Set<string>): void {
    if (!expr) return;
    if (typeof expr === 'string') {
        if (expr.startsWith('$') && !expr.startsWith('$$')) {
            used.add(expr.slice(1));
        }
    } else if (Array.isArray(expr)) {
        for (const item of expr) {
            extractExpressionFields(item, used);
        }
    } else if (typeof expr === 'object') {
        for (const [key, val] of Object.entries(expr)) {
            if (key.startsWith('$')) {
                if (key === '$literal') {
                    // ignore
                } else {
                    extractExpressionFields(val, used);
                }
            } else {
                extractExpressionFields(val, used);
            }
        }
    }
}

const DOCUMENT_SCOPE_OPS = new Set([
    '$text',
    '$where',
    '$jsonSchema',
    '$geoIntersects',
    '$geoWithin',
    '$near',
    '$nearSphere'
]);

export function extractFieldsFromFilter(filter: any): Set<string> {
    const used = new Set<string>();
    if (!filter || typeof filter !== 'object') return used;

    const traverse = (obj: any, pathPrefix = '') => {
        if (!obj || typeof obj !== 'object') return;

        if (Array.isArray(obj)) {
            for (const item of obj) {
                traverse(item, pathPrefix);
            }
            return;
        }

        for (const [key, val] of Object.entries(obj)) {
            if (key === '$and' || key === '$or' || key === '$nor') {
                traverse(val, pathPrefix);
            } else if (key === '$expr') {
                extractExpressionFields(val, used);
            } else if (DOCUMENT_SCOPE_OPS.has(key)) {
                used.add('*');
            } else if (key === '$elemMatch') {
                traverse(val, pathPrefix);
            } else if (key.startsWith('$')) {
                extractExpressionFields(val, used);
            } else {
                const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;
                used.add(fullPath);

                if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date) && !(val instanceof RegExp)) {
                    const valKeys = Object.keys(val);
                    if (valKeys.includes('$elemMatch')) {
                        traverse((val as Record<string, any>).$elemMatch, fullPath);
                    } else if (valKeys.some(k => k.startsWith('$'))) {
                        for (const [op, opVal] of Object.entries(val)) {
                            if (op === '$elemMatch') {
                                traverse(opVal, fullPath);
                            } else {
                                extractExpressionFields(opVal, used);
                            }
                        }
                    } else {
                        traverse(val, fullPath);
                    }
                }
            }
        }
    };

    traverse(filter);
    return used;
}
