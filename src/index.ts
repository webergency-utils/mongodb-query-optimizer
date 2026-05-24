export function optimizeFilter(filter: any): any {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter) || filter instanceof Date || filter instanceof RegExp) {
    return filter;
  }

  const keys = Object.keys(filter);
  if (keys.length === 0) {
    return {};
  }

  // 1. If the filter has a single key $and
  if (keys.length === 1 && keys[0] === '$and') {
    const conds = filter.$and;
    if (Array.isArray(conds)) {
      return mergeAndConditions(conds);
    }
  }

  // 2. If the filter has a single key $or
  if (keys.length === 1 && keys[0] === '$or') {
    const conds = filter.$or;
    if (Array.isArray(conds)) {
      const optimized = conds.map(c => optimizeFilter(c));
      const flattened: any[] = [];
      for (const cond of optimized) {
        if (cond && typeof cond === 'object' && Array.isArray(cond.$or) && Object.keys(cond).length === 1) {
          flattened.push(...cond.$or);
        } else if (cond && typeof cond === 'object' && Object.keys(cond).length === 0) {
          // Skip empty objects
        } else {
          flattened.push(cond);
        }
      }
      if (flattened.length === 0) {
        return {};
      }
      if (flattened.length === 1) {
        return flattened[0];
      }
      return { $or: flattened };
    }
  }

  // 3. Otherwise, traverse the object properties
  const result: any = {};
  for (const [key, val] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(val)) {
      const optimizedAnd = mergeAndConditions(val);
      if (optimizedAnd && typeof optimizedAnd === 'object' && !Array.isArray(optimizedAnd)) {
        let hasConflict = false;
        for (const k of Object.keys(optimizedAnd)) {
          if (k in result) {
            hasConflict = true;
            break;
          }
        }
        if (!hasConflict) {
          Object.assign(result, optimizedAnd);
        } else {
          result.$and = [optimizedAnd];
        }
      } else {
        result.$and = val;
      }
    } else if (key === '$or' && Array.isArray(val)) {
      const optimizedOr = optimizeFilter({ $or: val });
      if (optimizedOr && typeof optimizedOr === 'object' && '$or' in optimizedOr) {
        result.$or = optimizedOr.$or;
      } else if (optimizedOr && typeof optimizedOr === 'object' && !Array.isArray(optimizedOr)) {
        // If it simplified to a single object, merge it
        let hasConflict = false;
        for (const k of Object.keys(optimizedOr)) {
          if (k in result) {
            hasConflict = true;
            break;
          }
        }
        if (!hasConflict) {
          Object.assign(result, optimizedOr);
        } else {
          result.$or = [optimizedOr];
        }
      } else {
        result.$or = val;
      }
    } else if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date) && !(val instanceof RegExp)) {
      result[key] = optimizeOperatorSubdoc(val);
    } else {
      result[key] = val;
    }
  }

  // If result has an explicit $and but also other keys, merge them
  if ('$and' in result && Array.isArray(result.$and)) {
    const conds = [...result.$and];
    delete result.$and;
    return mergeAndConditions([result, ...conds]);
  }

  return result;
}

function isMergeableOperatorObject(val: any): boolean {
  if (!val || typeof val !== 'object' || Array.isArray(val) || val instanceof Date || val instanceof RegExp) {
    return false;
  }
  const keys = Object.keys(val);
  if (keys.length === 0) return false;
  return keys.every(k => k.startsWith('$'));
}

function optimizeOperatorSubdoc(val: any): any {
  const keys = Object.keys(val);
  if (keys.length === 1) {
    const op = keys[0];
    if (op === '$eq') {
      return val.$eq;
    }
    if (op === '$in' && Array.isArray(val.$in) && val.$in.length === 1) {
      return val.$in[0];
    }
  }

  const result: any = {};
  for (const [k, v] of Object.entries(val)) {
    if (k === '$not') {
      result.$not = optimizeFilter(v);
    } else if (k === '$elemMatch') {
      result.$elemMatch = optimizeFilter(v);
    } else {
      result[k] = v;
    }
  }

  const resKeys = Object.keys(result);
  if (resKeys.length === 1) {
    const op = resKeys[0];
    if (op === '$eq') {
      return result.$eq;
    }
    if (op === '$in' && Array.isArray(result.$in) && result.$in.length === 1) {
      return result.$in[0];
    }
  }

  return result;
}

function mergeOperatorObjects(a: any, b: any): any | null {
  const merged = { ...a };
  for (const [op, val] of Object.entries(b)) {
    if (!(op in merged)) {
      merged[op] = val;
      continue;
    }
    
    const existingVal = merged[op];
    if (typeof val === 'number' && typeof existingVal === 'number') {
      if (op === '$gt' || op === '$gte') {
        merged[op] = Math.max(existingVal, val);
      } else if (op === '$lt' || op === '$lte') {
        merged[op] = Math.min(existingVal, val);
      } else {
        return null;
      }
    } else {
      return null;
    }
  }
  
  if ('$gt' in merged && '$gte' in merged) {
    const gt = merged.$gt;
    const gte = merged.$gte;
    if (gt >= gte) {
      delete merged.$gte;
    } else {
      delete merged.$gt;
    }
  }
  if ('$lt' in merged && '$lte' in merged) {
    const lt = merged.$lt;
    const lte = merged.$lte;
    if (lt <= lte) {
      delete merged.$lte;
    } else {
      delete merged.$lt;
    }
  }
  
  return merged;
}

function getSetFromCondition(v: any): any[] | null {
  if (v === null || v === undefined) return [v];
  if (v instanceof RegExp) return null;
  if (v instanceof Date) return [v];
  if (Array.isArray(v)) return null;
  
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1) {
      const op = keys[0];
      if (op === '$in' && Array.isArray(v.$in)) {
        return v.$in;
      }
      if (op === '$eq') {
        return [v.$eq];
      }
    }
    return null;
  }
  return [v];
}

function intersectSets(a: any[], b: any[]): any[] {
  return a.filter(x => b.some(y => isEqual(x, y)));
}

function mergeAndConditions(conditions: any[]): any {
  const optimized = conditions.map(c => optimizeFilter(c));
  const flattened: any[] = [];
  for (const cond of optimized) {
    if (cond && typeof cond === 'object' && Array.isArray(cond.$and)) {
      const { $and, ...rest } = cond;
      if (Object.keys(rest).length > 0) {
        flattened.push(rest);
      }
      flattened.push(...$and);
    } else if (cond && typeof cond === 'object' && Object.keys(cond).length === 0) {
      // Skip empty objects
    } else {
      flattened.push(cond);
    }
  }

  // De-duplicate conditions in flattened before merging
  const uniqueFlattened: any[] = [];
  const seenStr = new Set<string>();
  for (const cond of flattened) {
    const s = JSON.stringify(cond);
    if (!seenStr.has(s)) {
      seenStr.add(s);
      uniqueFlattened.push(cond);
    }
  }

  if (uniqueFlattened.length === 0) {
    return {};
  }
  if (uniqueFlattened.length === 1) {
    return uniqueFlattened[0];
  }

  const mergedObj: any = {};
  const remainingConditions: any[] = [];

  for (const cond of uniqueFlattened) {
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date) && !(cond instanceof RegExp)) {
      let canMergeAllKeys = true;
      for (const [key, val] of Object.entries(cond)) {
        if (key.startsWith('$')) {
          canMergeAllKeys = false;
          break;
        }
        if (key in mergedObj) {
          const existing = mergedObj[key];
          const setA = getSetFromCondition(existing);
          const setB = getSetFromCondition(val);
          if (setA !== null && setB !== null) {
            const intersection = intersectSets(setA, setB);
            if (intersection.length === 0) {
              // Contradictory conditions (e.g., a:5 AND a:10), don't merge
              canMergeAllKeys = false;
              break;
            }
            continue;
          }
          
          if (isMergeableOperatorObject(existing) && isMergeableOperatorObject(val)) {
            const mergedVal = mergeOperatorObjects(existing, val);
            if (mergedVal === null) {
              canMergeAllKeys = false;
              break;
            }
          } else {
            canMergeAllKeys = false;
            break;
          }
        }
      }

      if (canMergeAllKeys) {
        for (const [key, val] of Object.entries(cond)) {
          if (key in mergedObj) {
            const setA = getSetFromCondition(mergedObj[key]);
            const setB = getSetFromCondition(val);
            if (setA !== null && setB !== null) {
              const intersected = intersectSets(setA, setB);
              if (intersected.length === 1) {
                mergedObj[key] = intersected[0];
              } else {
                mergedObj[key] = { $in: intersected };
              }
            } else if (isMergeableOperatorObject(mergedObj[key]) && isMergeableOperatorObject(val)) {
              mergedObj[key] = mergeOperatorObjects(mergedObj[key], val);
            } else {
              mergedObj[key] = { ...(mergedObj[key] as any), ...(val as any) };
            }
          } else {
            mergedObj[key] = val;
          }
        }
      } else {
        remainingConditions.push(cond);
      }
    } else {
      remainingConditions.push(cond);
    }
  }

  const finalRemaining: any[] = [];
  for (const cond of remainingConditions) {
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date) && !(cond instanceof RegExp)) {
      const keys = Object.keys(cond);
      if (keys.length === 1 && keys[0].startsWith('$') && !(keys[0] in mergedObj)) {
        mergedObj[keys[0]] = cond[keys[0]];
      } else {
        finalRemaining.push(cond);
      }
    } else {
      finalRemaining.push(cond);
    }
  }

  if (Object.keys(mergedObj).length > 0) {
    if (finalRemaining.length === 0) {
      return mergedObj;
    } else {
      return {
        ...mergedObj,
        $and: finalRemaining
      };
    }
  } else {
    return { $and: finalRemaining };
  }
}

// Pipeline Optimizer AST & Types

interface StageInfo {
  index: number;
  stage: any;
  operator: string;
  usedFields: Set<string>;
  producedFields: Set<string>;
  modifiedFields: Set<string>;
  removedFields: Set<string>;
  isDestructive: boolean;
  altersCount: boolean;
  isUnknown: boolean;
}

function extractExpressionFields(expr: any, used: Set<string>): void {
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

function extractFieldsFromFilter(filter: any): Set<string> {
  const used = new Set<string>();
  if (!filter || typeof filter !== 'object') return used;

  const traverse = (obj: any) => {
    if (!obj || typeof obj !== 'object') return;
    
    if (Array.isArray(obj)) {
      for (const item of obj) {
        traverse(item);
      }
      return;
    }

    for (const [key, val] of Object.entries(obj)) {
      if (key === '$and' || key === '$or' || key === '$nor') {
        traverse(val);
      } else if (key === '$expr') {
        extractExpressionFields(val, used);
      } else if (key.startsWith('$')) {
        if (key === '$elemMatch') {
          traverse(val);
        } else {
          extractExpressionFields(val, used);
        }
      } else {
        used.add(key);
        if (val && typeof val === 'object' && !(val instanceof Date) && !(val instanceof RegExp)) {
          traverse(val);
        }
      }
    }
  };

  traverse(filter);
  return used;
}

function extractStageInfo(stage: any, index: number): StageInfo {
  if (!stage || typeof stage !== 'object') {
    return {
      index,
      stage,
      operator: 'unknown',
      usedFields: new Set(['*']),
      producedFields: new Set(['*']),
      modifiedFields: new Set(['*']),
      removedFields: new Set(),
      isDestructive: true,
      altersCount: true,
      isUnknown: true,
    };
  }

  const operators = Object.keys(stage);
  if (operators.length !== 1) {
    return {
      index,
      stage,
      operator: 'unknown',
      usedFields: new Set(['*']),
      producedFields: new Set(['*']),
      modifiedFields: new Set(['*']),
      removedFields: new Set(),
      isDestructive: true,
      altersCount: true,
      isUnknown: true,
    };
  }

  const op = operators[0];
  const val = stage[op];

  const info: StageInfo = {
    index,
    stage,
    operator: op,
    usedFields: new Set(),
    producedFields: new Set(),
    modifiedFields: new Set(),
    removedFields: new Set(),
    isDestructive: false,
    altersCount: false,
    isUnknown: false,
  };

  switch (op) {
    case '$match': {
      info.altersCount = true;
      info.usedFields = extractFieldsFromFilter(val);
      break;
    }
    case '$sort': {
      if (val && typeof val === 'object') {
        for (const key of Object.keys(val)) {
          info.usedFields.add(key);
        }
      }
      break;
    }
    case '$limit':
    case '$skip':
    case '$sample': {
      info.altersCount = true;
      break;
    }
    case '$project': {
      info.isDestructive = true;
      if (val && typeof val === 'object') {
        let hasInclusions = false;
        for (const [key, v] of Object.entries(val)) {
          if (key === '_id') continue;
          if (v === 1 || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0)) {
            hasInclusions = true;
          } else if (typeof v === 'string' && v.startsWith('$')) {
            hasInclusions = true;
          }
        }
        if (!hasInclusions) {
          info.isDestructive = false;
        }

        for (const [key, v] of Object.entries(val)) {
          if (v === 0) {
            info.removedFields.add(key);
          } else {
            info.producedFields.add(key);
            if (v !== 1 && v !== `$${key}`) {
              info.modifiedFields.add(key);
            }
            extractExpressionFields(v, info.usedFields);
          }
        }
      }
      break;
    }
    case '$addFields':
    case '$set': {
      if (val && typeof val === 'object') {
        for (const [key, v] of Object.entries(val)) {
          info.producedFields.add(key);
          if (v !== `$${key}`) {
            info.modifiedFields.add(key);
          }
          extractExpressionFields(v, info.usedFields);
        }
      }
      break;
    }
    case '$unset': {
      const fields = Array.isArray(val) ? val : [val];
      for (const f of fields) {
        if (typeof f === 'string') {
          info.removedFields.add(f);
        }
      }
      break;
    }
    case '$unwind': {
      info.altersCount = true;
      let path = '';
      if (typeof val === 'string') {
        path = val;
      } else if (val && typeof val === 'object' && typeof val.path === 'string') {
        path = val.path;
      }
      if (path) {
        const cleanPath = path.startsWith('$') ? path.slice(1) : path;
        info.usedFields.add(cleanPath);
        info.producedFields.add(cleanPath);
        info.modifiedFields.add(cleanPath);
      }
      if (val && typeof val === 'object' && typeof val.includeArrayIndex === 'string') {
        info.producedFields.add(val.includeArrayIndex);
        info.modifiedFields.add(val.includeArrayIndex);
      }
      break;
    }
    case '$lookup': {
      if (val && typeof val === 'object') {
        if (typeof val.as === 'string') {
          info.producedFields.add(val.as);
          info.modifiedFields.add(val.as);
        }
        if (typeof val.localField === 'string') {
          info.usedFields.add(val.localField);
        }
        if (val.let && typeof val.let === 'object') {
          for (const v of Object.values(val.let)) {
            extractExpressionFields(v, info.usedFields);
          }
        }
        if (Array.isArray(val.pipeline)) {
          for (const subStage of val.pipeline) {
            const subInfo = extractStageInfo(subStage, 0);
            for (const f of subInfo.usedFields) {
              if (!f.startsWith('$')) {
                info.usedFields.add(f);
              }
            }
          }
        }
      }
      break;
    }
    case '$group': {
      info.isDestructive = true;
      info.altersCount = true;
      if (val && typeof val === 'object') {
        info.producedFields.add('_id');
        info.modifiedFields.add('_id');
        if ('_id' in val) {
          extractExpressionFields(val._id, info.usedFields);
        }
        for (const [key, v] of Object.entries(val)) {
          if (key === '_id') continue;
          info.producedFields.add(key);
          info.modifiedFields.add(key);
          extractExpressionFields(v, info.usedFields);
        }
      }
      break;
    }
    case '$count': {
      info.isDestructive = true;
      info.altersCount = true;
      if (typeof val === 'string') {
        info.producedFields.add(val);
        info.modifiedFields.add(val);
      }
      break;
    }
    case '$sortByCount': {
      info.isDestructive = true;
      info.altersCount = true;
      info.producedFields.add('_id');
      info.producedFields.add('count');
      info.modifiedFields.add('_id');
      info.modifiedFields.add('count');
      extractExpressionFields(val, info.usedFields);
      break;
    }
    case '$replaceRoot': {
      info.isDestructive = true;
      info.producedFields.add('*');
      info.modifiedFields.add('*');
      if (val && typeof val === 'object' && val.newRoot) {
        extractExpressionFields(val.newRoot, info.usedFields);
      }
      break;
    }
    case '$replaceWith': {
      info.isDestructive = true;
      info.producedFields.add('*');
      info.modifiedFields.add('*');
      extractExpressionFields(val, info.usedFields);
      break;
    }
    case '$facet': {
      info.isDestructive = true;
      info.altersCount = true;
      if (val && typeof val === 'object') {
        for (const [key, pipeline] of Object.entries(val)) {
          info.producedFields.add(key);
          info.modifiedFields.add(key);
          if (Array.isArray(pipeline)) {
            for (const subStage of pipeline) {
              const subInfo = extractStageInfo(subStage, 0);
              for (const f of subInfo.usedFields) {
                info.usedFields.add(f);
              }
            }
          }
        }
      }
      break;
    }
    case '$bucket': {
      info.isDestructive = true;
      info.altersCount = true;
      if (val && typeof val === 'object') {
        info.producedFields.add('_id');
        info.modifiedFields.add('_id');
        if ('groupBy' in val) {
          extractExpressionFields(val.groupBy, info.usedFields);
        }
        if (val.output && typeof val.output === 'object') {
          for (const [key, expr] of Object.entries(val.output)) {
            info.producedFields.add(key);
            info.modifiedFields.add(key);
            extractExpressionFields(expr, info.usedFields);
          }
        }
      }
      break;
    }
    case '$bucketAuto': {
      info.isDestructive = true;
      info.altersCount = true;
      if (val && typeof val === 'object') {
        info.producedFields.add('_id');
        info.modifiedFields.add('_id');
        if ('groupBy' in val) {
          extractExpressionFields(val.groupBy, info.usedFields);
        }
        if (val.output && typeof val.output === 'object') {
          for (const [key, expr] of Object.entries(val.output)) {
            info.producedFields.add(key);
            info.modifiedFields.add(key);
            extractExpressionFields(expr, info.usedFields);
          }
        }
      }
      break;
    }
    case '$setWindowFields': {
      info.altersCount = true;
      if (val && typeof val === 'object') {
        if ('partitionBy' in val) {
          extractExpressionFields(val.partitionBy, info.usedFields);
        }
        if (val.sortBy && typeof val.sortBy === 'object') {
          for (const key of Object.keys(val.sortBy)) {
            info.usedFields.add(key);
          }
        }
        if (val.output && typeof val.output === 'object') {
          for (const [key, expr] of Object.entries(val.output)) {
            info.producedFields.add(key);
            info.modifiedFields.add(key);
            extractExpressionFields(expr, info.usedFields);
          }
        }
      }
      break;
    }
    case '$densify': {
      info.altersCount = true;
      if (val && typeof val === 'object') {
        if (typeof val.field === 'string') {
          info.usedFields.add(val.field);
          info.producedFields.add(val.field);
          info.modifiedFields.add(val.field);
        }
        if (Array.isArray(val.partitionByFields)) {
          for (const f of val.partitionByFields) {
            if (typeof f === 'string') {
              info.usedFields.add(f);
            }
          }
        }
        if (val.range && typeof val.range === 'object') {
          extractExpressionFields(val.range, info.usedFields);
        }
      }
      break;
    }
    case '$fill': {
      info.altersCount = true;
      if (val && typeof val === 'object') {
        if ('partitionBy' in val) {
          extractExpressionFields(val.partitionBy, info.usedFields);
        }
        if (Array.isArray(val.partitionByFields)) {
          for (const f of val.partitionByFields) {
            if (typeof f === 'string') {
              info.usedFields.add(f);
            }
          }
        }
        if (val.sortBy && typeof val.sortBy === 'object') {
          for (const key of Object.keys(val.sortBy)) {
            info.usedFields.add(key);
          }
        }
        if (val.output && typeof val.output === 'object') {
          for (const [key, config] of Object.entries(val.output)) {
            info.producedFields.add(key);
            info.modifiedFields.add(key);
            if (config && typeof config === 'object') {
              if ('value' in config) {
                extractExpressionFields(config.value, info.usedFields);
              }
            }
          }
        }
      }
      break;
    }
    case '$documents': {
      info.isDestructive = true;
      info.altersCount = true;
      info.producedFields.add('*');
      info.modifiedFields.add('*');
      break;
    }
    case '$unionWith': {
      info.altersCount = true;
      info.producedFields.add('*');
      info.modifiedFields.add('*');
      if (val && typeof val === 'object' && Array.isArray(val.pipeline)) {
        for (const subStage of val.pipeline) {
          const subInfo = extractStageInfo(subStage, 0);
          for (const f of subInfo.usedFields) {
            info.usedFields.add(f);
          }
        }
      }
      break;
    }
    case '$graphLookup': {
      if (val && typeof val === 'object') {
        if (typeof val.as === 'string') {
          info.producedFields.add(val.as);
          info.modifiedFields.add(val.as);
        }
        if (typeof val.depthField === 'string') {
          info.producedFields.add(val.depthField);
          info.modifiedFields.add(val.depthField);
        }
        if ('startWith' in val) {
          extractExpressionFields(val.startWith, info.usedFields);
        }
        if (typeof val.connectFromField === 'string') {
          info.usedFields.add(val.connectFromField);
        }
        if (typeof val.connectToField === 'string') {
          info.usedFields.add(val.connectToField);
        }
        if (val.restrictSearchWithMatch && typeof val.restrictSearchWithMatch === 'object') {
          const restrictUsed = extractFieldsFromFilter(val.restrictSearchWithMatch);
          for (const f of restrictUsed) {
            info.usedFields.add(f);
          }
        }
      }
      break;
    }
    default: {
      info.isUnknown = true;
      info.usedFields.add('*');
      info.producedFields.add('*');
      info.modifiedFields.add('*');
      info.isDestructive = true;
      info.altersCount = true;
    }
  }

  return info;
}

function pathsIntersect(p1: string, p2: string): boolean {
  if (p1 === '*' || p2 === '*') return true;
  if (p1 === p2) return true;
  return p1.startsWith(p2 + '.') || p2.startsWith(p1 + '.');
}

function setsIntersect(s1: Set<string>, s2: Set<string>): boolean {
  for (const p1 of s1) {
    for (const p2 of s2) {
      if (pathsIntersect(p1, p2)) {
        return true;
      }
    }
  }
  return false;
}

function isSubsetOfProduced(used: Set<string>, produced: Set<string>): boolean {
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

function canSwap(a: StageInfo, b: StageInfo): boolean {
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

// Optimization Passes

function isMatchStage(stage: any): boolean {
  return stage && typeof stage === 'object' && '$match' in stage;
}

function mergeAdjacentMatches(pipeline: any[]): any[] {
  const result: any[] = [];
  for (const stage of pipeline) {
    if (result.length > 0 && isMatchStage(result[result.length - 1]) && isMatchStage(stage)) {
      const prevMatch = result[result.length - 1].$match;
      const currMatch = stage.$match;
      const mergedFilter = optimizeFilter({ $and: [prevMatch, currMatch] });
      result[result.length - 1] = { $match: mergedFilter };
    } else {
      result.push(stage);
    }
  }
  return result;
}

function coalesceLimitsAndSkips(pipeline: any[]): any[] {
  const result: any[] = [];
  for (const stage of pipeline) {
    if (result.length > 0) {
      const prev = result[result.length - 1];
      const prevOp = Object.keys(prev)[0];
      const currOp = Object.keys(stage)[0];
      
      if (prevOp === '$limit' && currOp === '$limit') {
        result[result.length - 1] = { $limit: Math.min(prev.$limit, stage.$limit) };
      } else if (prevOp === '$skip' && currOp === '$skip') {
        result[result.length - 1] = { $skip: prev.$skip + stage.$skip };
      } else {
        result.push(stage);
      }
    } else {
      result.push(stage);
    }
  }
  return result;
}

function splitFilterConditions(filter: any): any[] {
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

function isSimpleMatchCondition(cond: any, unwindPath: string): boolean {
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

function isEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, idx) => isEqual(val, b[idx]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(k => k in b && isEqual(a[k], b[k]));
  }
  return false;
}

function filterContainsCondition(parentFilter: any, cond: any): boolean {
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

function extractRenamings(spec: any, prefix = ''): Map<string, string> {
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

function rewriteKey(key: string, renamings: Map<string, string>): string | null {
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

function rewriteFilter(filter: any, renamings: Map<string, string>, modifiedFields: Set<string>): any | null {
  if (filter === null || filter === undefined) return filter;
  if (filter instanceof RegExp || filter instanceof Date) return filter;
  
  if (Array.isArray(filter)) {
    const rewrittenItems = [];
    for (const item of filter) {
      const rew = rewriteFilter(item, renamings, modifiedFields);
      if (rew === null) return null;
      rewrittenItems.push(rew);
    }
    return rewrittenItems;
  }
  
  if (typeof filter === 'object') {
    const result: any = {};
    for (const [k, v] of Object.entries(filter)) {
      if (k.startsWith('$')) {
        const rew = rewriteFilter(v, renamings, modifiedFields);
        if (rew === null) return null;
        result[k] = rew;
      } else {
        const newKey = rewriteKey(k, renamings);
        if (newKey !== null) {
          const rew = rewriteFilter(v, renamings, modifiedFields);
          if (rew === null) return null;
          result[newKey] = rew;
        } else {
          const isDiscardedOrModified = modifiedFields.has('*') || 
                                        modifiedFields.has(k) || 
                                        Array.from(modifiedFields).some(f => k === f || k.startsWith(f + '.'));
          if (isDiscardedOrModified) {
            return null;
          }
          const rew = rewriteFilter(v, renamings, modifiedFields);
          if (rew === null) return null;
          result[k] = rew;
        }
      }
    }
    return result;
  }
  return filter;
}

function pushMatchesDown(pipeline: any[]): any[] {
  const result = [...pipeline];

  for (let i = 1; i < result.length; i++) {
    if (isMatchStage(result[i])) {
      const matchStage = result[i];
      const matchFilter = matchStage.$match;
      const conditions = splitFilterConditions(matchFilter);
      
      const remainingConditions: any[] = [];
      const pushedStages: { index: number; stage: any }[] = [];

      for (let cond of conditions) {
        let condStage = { $match: cond };
        const condInfo = extractStageInfo(condStage, 0);

        let curIdx = i;
        let pushed = false;
        let copied = false;
        
        while (curIdx > 0) {
          const prevStage = result[curIdx - 1];
          const prevInfo = extractStageInfo(prevStage, 0);

          if (canSwap(prevInfo, condInfo)) {
            curIdx--;
            pushed = true;
          } else {
            const isProjectOrAddFields = prevInfo.operator === '$project' || 
                                         prevInfo.operator === '$addFields' || 
                                         prevInfo.operator === '$set';
            if (isProjectOrAddFields) {
              const spec = prevStage[prevInfo.operator];
              const renamings = extractRenamings(spec);
              if (renamings.size > 0) {
                const rewritten = rewriteFilter(cond, renamings, prevInfo.modifiedFields);
                if (rewritten !== null) {
                  cond = rewritten;
                  condStage.$match = rewritten;
                  condInfo.usedFields.clear();
                  extractFieldsFromFilter(rewritten).forEach(f => condInfo.usedFields.add(f));
                  curIdx--;
                  pushed = true;
                  continue;
                }
              }
            }

            if (prevInfo.operator === '$unwind') {
              const unwindPath = Array.from(prevInfo.usedFields)[0];
              if (setsIntersect(condInfo.usedFields, new Set([unwindPath])) && isSimpleMatchCondition(cond, unwindPath)) {
                // Check if match already exists before unwind
                const hasExistingMatch = curIdx - 2 >= 0 &&
                  isMatchStage(result[curIdx - 2]) &&
                  filterContainsCondition(result[curIdx - 2].$match, cond);
                
                if (!hasExistingMatch) {
                  result.splice(curIdx - 1, 0, { $match: cond });
                  copied = true;
                }
              }
            }
            break;
          }
        }

        if (copied) {
          return result;
        }

        if (pushed) {
          pushedStages.push({ index: curIdx, stage: condStage });
        } else {
          remainingConditions.push(cond);
        }
      }

      if (pushedStages.length > 0) {
        result.splice(i, 1);
        pushedStages.sort((a, b) => b.index - a.index);
        for (const p of pushedStages) {
          result.splice(p.index, 0, p.stage);
        }
        if (remainingConditions.length > 0) {
          const remainingMatch = { $match: optimizeFilter({ $and: remainingConditions }) };
          result.splice(i + pushedStages.length, 0, remainingMatch);
        }
        return result;
      }
    }
  }

  return result;
}

function advanceLimits(pipeline: any[]): any[] {
  const result = [...pipeline];

  for (let i = 1; i < result.length; i++) {
    const stage = result[i];
    const op = stage && typeof stage === 'object' ? Object.keys(stage)[0] : null;

    if (op === '$limit' || op === '$skip') {
      const info = extractStageInfo(stage, i);
      const prevStage = result[i - 1];
      const prevInfo = extractStageInfo(prevStage, i - 1);

      if (canSwap(prevInfo, info)) {
        result[i] = prevStage;
        result[i - 1] = stage;
        return result;
      }
    }
  }

  return result;
}

function delayLookups(pipeline: any[]): any[] {
  const result = [...pipeline];
  
  for (let i = 0; i < result.length - 1; i++) {
    const stage = result[i];
    const nextStage = result[i + 1];
    
    if (stage && typeof stage === 'object' && '$lookup' in stage) {
      const info = extractStageInfo(stage, i);
      const nextInfo = extractStageInfo(nextStage, i + 1);
      
      if (canSwap(info, nextInfo)) {
        result[i] = nextStage;
        result[i + 1] = stage;
        return result;
      }

      // If next stage is $unwind on the lookup's output field,
      // try to delay the $lookup + $unwind pair together
      if (nextInfo.operator === '$unwind' && i + 2 < result.length) {
        const lookupAs = stage.$lookup?.as;
        const unwindVal = nextStage.$unwind;
        const unwindPath = typeof unwindVal === 'string' ? unwindVal : unwindVal?.path;
        const cleanUnwindPath = unwindPath?.startsWith('$') ? unwindPath.slice(1) : unwindPath;

        if (lookupAs && cleanUnwindPath === lookupAs) {
          const afterStage = result[i + 2];
          const afterInfo = extractStageInfo(afterStage, i + 2);

          // Both $lookup and $unwind must be able to swap with the stage after them
          if (canSwap(info, afterInfo) && canSwap(nextInfo, afterInfo)) {
            result[i] = afterStage;
            result[i + 1] = stage;
            result[i + 2] = nextStage;
            return result;
          }
        }
      }
    }
  }
  
  return result;
}

function eliminateRedundantLookups(pipeline: any[]): any[] {
  const result = [...pipeline];
  const stageInfos = result.map((stage, idx) => extractStageInfo(stage, idx));

  for (let i = 0; i < result.length; i++) {
    const info = stageInfos[i];
    if (info.operator === '$lookup') {
      const alias = Array.from(info.producedFields)[0];
      if (alias) {
        let isUsed = false;
        let isDiscarded = false;
        let unwindIndex = -1;
        let canDeleteUnwind = true;

        for (let j = i + 1; j < result.length; j++) {
          if (result[j] === null) continue;
          const downInfo = stageInfos[j];
          const usesAlias = Array.from(downInfo.usedFields).some(f => f === alias || f.startsWith(alias + '.'));
          
          if (usesAlias) {
            if (downInfo.operator === '$unwind') {
              unwindIndex = j;
              const unwindVal = result[j].$unwind;
              const preserve = typeof unwindVal === 'object' && unwindVal.preserveNullAndEmptyArrays === true;
              if (!preserve) {
                canDeleteUnwind = false;
              }

              if (unwindVal && typeof unwindVal === 'object' && typeof unwindVal.includeArrayIndex === 'string') {
                const idxField = unwindVal.includeArrayIndex;
                let isIdxUsed = false;
                let isIdxDiscarded = false;
                for (let k = j + 1; k < result.length; k++) {
                  if (result[k] === null) continue;
                  const futureInfo = stageInfos[k];
                  if (setsIntersect(new Set([idxField]), futureInfo.usedFields)) {
                    isIdxUsed = true;
                    break;
                  }
                  if (futureInfo.isDestructive) {
                    if (!setsIntersect(new Set([idxField]), futureInfo.producedFields)) {
                      isIdxDiscarded = true;
                      break;
                    }
                  }
                }
                if (isIdxUsed || !isIdxDiscarded) {
                  canDeleteUnwind = false;
                }
              }
            } else {
              isUsed = true;
              break;
            }
          }

          if (downInfo.isDestructive) {
            const keepsAlias = setsIntersect(new Set([alias]), downInfo.producedFields);
            if (!keepsAlias) {
              isDiscarded = true;
              break;
            }
          }
        }

        if (isDiscarded && !isUsed && (unwindIndex === -1 || canDeleteUnwind)) {
          result[i] = null;
          if (unwindIndex !== -1) {
            result[unwindIndex] = null;
          }
        }
      }
    }
  }

  return result.filter(s => s !== null);
}

function eliminateRedundantProjections(pipeline: any[]): any[] {
  const result = [...pipeline];
  const stageInfos = result.map((stage, idx) => extractStageInfo(stage, idx));

  for (let i = 0; i < result.length; i++) {
    const info = stageInfos[i];
    const passiveProjections = new Set(['$project', '$addFields', '$set', '$unset']);
    
    if (passiveProjections.has(info.operator)) {
      let isUsed = false;
      let isDiscarded = false;

      for (let j = i + 1; j < result.length; j++) {
        if (result[j] === null) continue;
        const downInfo = stageInfos[j];
        
        const hasProducedIntersection = setsIntersect(info.producedFields, downInfo.usedFields);
        if (hasProducedIntersection) {
          isUsed = true;
          break;
        }

        if (downInfo.isDestructive) {
          const keepsAny = setsIntersect(info.producedFields, downInfo.producedFields);
          if (!keepsAny) {
            isDiscarded = true;
            break;
          }
        }
      }

      if (isDiscarded && !isUsed) {
        result[i] = null;
      }
    }
  }

  return result.filter(s => s !== null);
}

function deferComplexProjections(pipeline: any[]): any[] {
  const result = [...pipeline];
  const stageInfos = result.map((stage, idx) => extractStageInfo(stage, idx));

  for (let i = 0; i < result.length; i++) {
    const info = stageInfos[i];
    if (result[i] === null) continue;

    if (info.operator === '$project' || info.operator === '$addFields' || info.operator === '$set') {
      const val = result[i][info.operator];
      if (val && typeof val === 'object') {
        const prunedVal: any = { ...val };
        let hasDeferred = false;
        const deferredFields: { [key: string]: any } = {};
        let maxTargetIndex = -1;

        for (const key of Object.keys(val)) {
          if (key === '_id') continue;
          const v = val[key];

          // Check if it is a computed/complex field
          const isSimple = v === 1 || v === 0 || v === `$${key}`;
          if (isSimple) continue;

          let canDefer = false;
          let currentTargetIndex = -1;

          for (let j = i + 1; j < result.length; j++) {
            if (result[j] === null) continue;
            const downInfo = stageInfos[j];

            const isUsed = setsIntersect(new Set([key]), downInfo.usedFields);
            if (isUsed) {
              break;
            }

            if (downInfo.operator === '$sort' || downInfo.operator === '$limit' || downInfo.operator === '$skip') {
              canDefer = true;
              currentTargetIndex = j;
            }

            const stopOperators = new Set(['$group', '$bucket', '$bucketAuto', '$facet', '$unwind', '$count', '$sortByCount']);
            if (downInfo.isUnknown || downInfo.isDestructive || stopOperators.has(downInfo.operator)) {
              break;
            }
          }

          if (canDefer && currentTargetIndex !== -1) {
            delete prunedVal[key];
            deferredFields[key] = v;
            maxTargetIndex = Math.max(maxTargetIndex, currentTargetIndex);
            hasDeferred = true;
          }
        }

        if (hasDeferred && maxTargetIndex !== -1) {
          const fieldsToUnset: string[] = [];

          if (info.operator === '$project') {
            let originalHasInclusions = false;
            for (const [k, v] of Object.entries(val)) {
              if (k === '_id') continue;
              if (v !== 0 && v !== false) {
                originalHasInclusions = true;
                break;
              }
            }

            if (originalHasInclusions) {
              const deps = new Set<string>();
              for (const v of Object.values(deferredFields)) {
                extractExpressionFields(v, deps);
              }

              for (const dep of deps) {
                const topLevelDep = dep.split('.')[0];
                if (topLevelDep === '_id') continue;

                let isTopLevelProduced = false;
                for (const k of Object.keys(prunedVal)) {
                  if (k === topLevelDep || k.startsWith(topLevelDep + '.')) {
                    isTopLevelProduced = true;
                    break;
                  }
                }

                if (isTopLevelProduced) {
                  if (!(dep in prunedVal)) {
                    prunedVal[dep] = 1;
                    fieldsToUnset.push(dep);
                  }
                } else {
                  if (!(dep in prunedVal)) {
                    prunedVal[dep] = 1;
                    if (!fieldsToUnset.includes(topLevelDep)) {
                      fieldsToUnset.push(topLevelDep);
                    }
                  }
                }
              }
            }
          }

          const remainingKeys = Object.keys(prunedVal);
          const isEmpty = remainingKeys.length === 0 || (info.operator === '$project' && remainingKeys.length === 1 && remainingKeys[0] === '_id');
          if (isEmpty) {
            result[i] = null;
          } else {
            result[i] = { [info.operator]: prunedVal };
          }

          const insertIndex = maxTargetIndex + 1;
          if (fieldsToUnset.length > 0) {
            result.splice(
              insertIndex,
              0,
              { $addFields: deferredFields },
              { $unset: fieldsToUnset.length === 1 ? fieldsToUnset[0] : fieldsToUnset }
            );
          } else {
            result.splice(insertIndex, 0, { $addFields: deferredFields });
          }
          return result.filter(s => s !== null);
        }
      }
    }
  }

  return result.filter(s => s !== null);
}

function pruneUnusedFields(pipeline: any[]): any[] {
  const result = [...pipeline];
  const stageInfos = result.map((stage, idx) => extractStageInfo(stage, idx));

  for (let i = 0; i < result.length; i++) {
    const info = stageInfos[i];
    if (result[i] === null) continue;

    if (info.operator === '$project' || info.operator === '$addFields' || info.operator === '$set') {
      const val = result[i][info.operator];
      if (val && typeof val === 'object') {
        const prunedVal: any = { ...val };
        let hasPruned = false;

        for (const key of Object.keys(val)) {
          if (key === '_id') continue;

          let isAlive = false;
          let isDiscarded = false;

          for (let j = i + 1; j < result.length; j++) {
            if (result[j] === null) continue;
            const downInfo = stageInfos[j];

            const isUsed = setsIntersect(new Set([key]), downInfo.usedFields);
            if (isUsed) {
              isAlive = true;
              break;
            }

            if (downInfo.isDestructive) {
              const keepsKey = setsIntersect(new Set([key]), downInfo.producedFields);
              if (!keepsKey) {
                isDiscarded = true;
                break;
              }
            }
          }

          if (isDiscarded && !isAlive) {
            delete prunedVal[key];
            hasPruned = true;
          }
        }

        if (hasPruned) {
          const remainingKeys = Object.keys(prunedVal);
          const isEmpty = remainingKeys.length === 0 || (info.operator === '$project' && remainingKeys.length === 1 && remainingKeys[0] === '_id');
          
          if (isEmpty) {
            result[i] = null;
          } else {
            result[i] = { [info.operator]: prunedVal };
          }
        }
      }
    }
  }

  return result.filter(s => s !== null);
}

function mergeAdjacentProjects(pipeline: any[]): any[] {
  const result: any[] = [];
  for (const stage of pipeline) {
    if (result.length > 0 && result[result.length - 1] && '$project' in result[result.length - 1] && stage && '$project' in stage) {
      const prevProj = result[result.length - 1].$project;
      const currProj = stage.$project;
      
      const isSimple = Object.values(currProj as any).every(v => v === 1 || v === 0);
      if (isSimple) {
        const merged: any = {};
        const hasInclusions = Object.values(currProj as any).some(v => v === 1);
        
        if (hasInclusions) {
          for (const [k, v] of Object.entries(prevProj as any)) {
            if (currProj[k] === 1 || (k === '_id' && currProj[k] !== 0)) {
              merged[k] = v;
            }
          }
          for (const [k, v] of Object.entries(currProj as any)) {
            if (v === 1 && !(k in merged)) {
              merged[k] = 1;
            }
          }
        } else {
          for (const [k, v] of Object.entries(prevProj as any)) {
            if (currProj[k] !== 0) {
              merged[k] = v;
            }
          }
        }
        result[result.length - 1] = { $project: merged };
      } else {
        result.push(stage);
      }
    } else {
      result.push(stage);
    }
  }
  return result;
}

function mergeAdjacentAddFields(pipeline: any[]): any[] {
  const result: any[] = [];
  for (const stage of pipeline) {
    if (result.length > 0 && result[result.length - 1] && stage) {
      const prev = result[result.length - 1];
      const prevOp = Object.keys(prev)[0];
      const currOp = Object.keys(stage)[0];
      
      if ((prevOp === '$addFields' || prevOp === '$set') && (currOp === '$addFields' || currOp === '$set')) {
        const prevVal = prev[prevOp];
        const currVal = stage[currOp];
        
        const prevInfo = extractStageInfo(prev, 0);
        const currInfo = extractStageInfo(stage, 0);
        
        const canMerge = !setsIntersect(currInfo.usedFields, prevInfo.modifiedFields) &&
                         !setsIntersect(prevInfo.modifiedFields, currInfo.modifiedFields);
        
        if (canMerge) {
          result[result.length - 1] = { [prevOp]: { ...prevVal, ...currVal } };
        } else {
          result.push(stage);
        }
      } else {
        result.push(stage);
      }
    } else {
      result.push(stage);
    }
  }
  return result;
}

function deepClone(val: any): any {
  if (val === null || val === undefined) return val;
  if (val instanceof RegExp) {
    return new RegExp(val.source, val.flags);
  }
  if (val instanceof Date) {
    return new Date(val.getTime());
  }
  if (Array.isArray(val)) {
    return val.map(item => deepClone(item));
  }
  if (typeof val === 'object') {
    const proto = Object.getPrototypeOf(val);
    if (proto !== null && proto !== Object.prototype) {
      return val;
    }
    const clone: any = {};
    for (const [k, v] of Object.entries(val)) {
      clone[k] = deepClone(v);
    }
    return clone;
  }
  return val;
}

// Main Runner

export function optimizePipeline(pipeline: any[]): any[] {
  if (!Array.isArray(pipeline)) {
    return pipeline;
  }

  let current = deepClone(pipeline);
  let prevStr = '';
  
  for (let iter = 0; iter < 100; iter++) {
    const currStr = JSON.stringify(current);
    if (currStr === prevStr) {
      break;
    }
    prevStr = currStr;

    // 1. Optimize filters in all $match stages
    current = current.map((stage: any) => {
      if (isMatchStage(stage)) {
        return { $match: optimizeFilter(stage.$match) };
      }
      return stage;
    });


    // 2. Merge adjacent match stages
    current = mergeAdjacentMatches(current);


    // 3. Coalesce adjacent limits and skips
    current = coalesceLimitsAndSkips(current);


    // 4. Push match stages as early as possible
    current = pushMatchesDown(current);


    // 5. Advance limits and delay lookups until stable
    let reordered = true;
    while (reordered) {
      const before = JSON.stringify(current);
      current = advanceLimits(current);
      current = delayLookups(current);
      if (JSON.stringify(current) === before) {
        reordered = false;
      }
    }


    // 6. Defer complex projections past sort/limit/skip
    current = deferComplexProjections(current);


    // 7. Prune unused fields from projects/addFields
    current = pruneUnusedFields(current);


    // 8. Merge adjacent project stages
    current = mergeAdjacentProjects(current);


    // 9. Merge adjacent addFields stages
    current = mergeAdjacentAddFields(current);


    // 10. Eliminate redundant lookups and unwinds
    current = eliminateRedundantLookups(current);


    // 11. Eliminate redundant projections
    current = eliminateRedundantProjections(current);

  }

  return current;
}
