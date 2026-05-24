import { describe, it, expect } from 'vitest';
import { optimizeFilter, optimizePipeline } from '../src/index.js';

// --- In-Memory Mock MongoDB Execution Engine ---

function runMockPipeline(data: any[], pipeline: any[], db: { [coll: string]: any[] } = {}): any[] {
  let docs = JSON.parse(JSON.stringify(data));

  for (const stage of pipeline) {
    const op = Object.keys(stage)[0];
    const val = stage[op];

    switch (op) {
      case '$match': {
        docs = docs.filter((doc: any) => matchDoc(doc, val));
        break;
      }
      case '$project': {
        docs = docs.map((doc: any) => {
          const newDoc: any = {};
          
          let hasInclusions = false;
          for (const [k, v] of Object.entries(val)) {
            if (k === '_id') continue;
            if (v === 1 || v === true || typeof v === 'object' || (typeof v === 'string' && v.startsWith('$'))) {
              hasInclusions = true;
            }
          }

          if (hasInclusions) {
            if (val._id !== 0 && '_id' in doc) {
              newDoc._id = doc._id;
            }
            for (const [k, v] of Object.entries(val)) {
              if (k === '_id') continue;
              if (v === 1 || v === true) {
                setNestedVal(newDoc, k, getNestedVal(doc, k));
              } else {
                setNestedVal(newDoc, k, evalExpr(doc, v));
              }
            }
          } else {
            Object.assign(newDoc, doc);
            for (const [k, v] of Object.entries(val)) {
              if (v === 0) {
                delete newDoc[k];
              }
            }
          }
          return newDoc;
        });
        break;
      }
      case '$addFields':
      case '$set': {
        docs = docs.map((doc: any) => {
          const newDoc = { ...doc };
          for (const [k, v] of Object.entries(val)) {
            setNestedVal(newDoc, k, evalExpr(doc, v));
          }
          return newDoc;
        });
        break;
      }
      case '$unset': {
        const fields = Array.isArray(val) ? val : [val];
        docs = docs.map((doc: any) => {
          const newDoc = { ...doc };
          for (const f of fields) {
            deleteNestedVal(newDoc, f);
          }
          return newDoc;
        });
        break;
      }
      case '$unwind': {
        const path = typeof val === 'string' ? val : val.path;
        const cleanPath = path.startsWith('$') ? path.slice(1) : path;
        const indexField = (val && typeof val === 'object') ? val.includeArrayIndex : undefined;
        const unwound: any[] = [];

        for (const doc of docs) {
          const arr = getNestedVal(doc, cleanPath);
          if (Array.isArray(arr)) {
            if (arr.length === 0 && val.preserveNullAndEmptyArrays) {
              const newDoc = { ...doc };
              setNestedVal(newDoc, cleanPath, null);
              if (indexField) {
                newDoc[indexField] = null;
              }
              unwound.push(newDoc);
            } else {
              for (let idx = 0; idx < arr.length; idx++) {
                const item = arr[idx];
                const newDoc = { ...doc };
                setNestedVal(newDoc, cleanPath, item);
                if (indexField) {
                  newDoc[indexField] = idx;
                }
                unwound.push(newDoc);
              }
            }
          } else if ((arr === null || arr === undefined) && val.preserveNullAndEmptyArrays) {
            const newDoc = { ...doc };
            setNestedVal(newDoc, cleanPath, null);
            if (indexField) {
              newDoc[indexField] = null;
            }
            unwound.push(newDoc);
          } else if (arr !== null && arr !== undefined) {
            const newDoc = { ...doc };
            if (indexField) {
              newDoc[indexField] = 0;
            }
            unwound.push(newDoc);
          }
        }
        docs = unwound;
        break;
      }
      case '$sort': {
        docs.sort((a: any, b: any) => {
          for (const [k, direction] of Object.entries(val)) {
            const valA = getNestedVal(a, k);
            const valB = getNestedVal(b, k);
            if (valA < valB) return (direction as number) === -1 ? 1 : -1;
            if (valA > valB) return (direction as number) === -1 ? -1 : 1;
          }
          return 0;
        });
        break;
      }
      case '$limit': {
        docs = docs.slice(0, val);
        break;
      }
      case '$skip': {
        docs = docs.slice(val);
        break;
      }
      case '$lookup': {
        const from = val.from;
        const local = val.localField;
        const foreign = val.foreignField;
        const asField = val.as;
        const foreignDocs = db[from] || [];

        docs = docs.map((doc: any) => {
          const newDoc = { ...doc };
          const localVal = getNestedVal(doc, local);
          const matches = foreignDocs.filter((fDoc: any) => {
            const fVal = getNestedVal(fDoc, foreign);
            return JSON.stringify(localVal) === JSON.stringify(fVal);
          });
          newDoc[asField] = matches;
          return newDoc;
        });
        break;
      }
      case '$group': {
        const idExpr = val._id;
        const accumulators = { ...val };
        delete accumulators._id;

        const groups: { [key: string]: any[] } = {};
        for (const doc of docs) {
          const groupKey = JSON.stringify(evalExpr(doc, idExpr));
          if (!groups[groupKey]) {
            groups[groupKey] = [];
          }
          groups[groupKey].push(doc);
        }

        const groupedDocs: any[] = [];
        for (const [key, groupDocs] of Object.entries(groups)) {
          const groupKeyVal = JSON.parse(key);
          const groupedDoc: any = { _id: groupKeyVal };

          for (const [field, accExpr] of Object.entries(accumulators)) {
            const accOp = Object.keys(accExpr as any)[0];
            const accVal = (accExpr as any)[accOp];

            if (accOp === '$sum') {
              let sum = 0;
              for (const doc of groupDocs) {
                const evalVal = evalExpr(doc, accVal);
                sum += typeof evalVal === 'number' ? evalVal : 0;
              }
              groupedDoc[field] = sum;
            }
          }
          groupedDocs.push(groupedDoc);
        }
        docs = groupedDocs;
        break;
      }
      case '$count': {
        docs = [ { [val]: docs.length } ];
        break;
      }
      case '$replaceRoot': {
        docs = docs.map((doc: any) => {
          const rootVal = evalExpr(doc, val.newRoot);
          return typeof rootVal === 'object' ? rootVal : {};
        });
        break;
      }
      case '$replaceWith': {
        docs = docs.map((doc: any) => {
          const rootVal = evalExpr(doc, val);
          return typeof rootVal === 'object' ? rootVal : {};
        });
        break;
      }
      default:
        throw new Error(`Mock pipeline runner does not support stage: ${op}`);
    }
  }

  return docs;
}

function getNestedVal(obj: any, path: string): any {
  if (obj === null || obj === undefined) return undefined;
  const parts = path.split('.');
  
  let current: any = obj;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (Array.isArray(current)) {
      const remainingPath = parts.slice(i).join('.');
      return current.map(item => getNestedVal(item, remainingPath));
    }
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function setNestedVal(obj: any, path: string, val: any): void {
  const parts = path.split('.');
  let curr = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!curr[parts[i]]) curr[parts[i]] = {};
    curr = curr[parts[i]];
  }
  curr[parts[parts.length - 1]] = val;
}

function deleteNestedVal(obj: any, path: string): void {
  const parts = path.split('.');
  let curr = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (curr && typeof curr === 'object' && parts[i] in curr) {
      curr = curr[parts[i]];
    } else {
      return;
    }
  }
  if (curr && typeof curr === 'object') {
    delete curr[parts[parts.length - 1]];
  }
}

function evalExpr(doc: any, expr: any): any {
  if (typeof expr === 'string') {
    if (expr.startsWith('$') && !expr.startsWith('$$')) {
      return getNestedVal(doc, expr.slice(1));
    }
    return expr;
  }
  if (!expr || typeof expr !== 'object') {
    return expr;
  }
  if (Array.isArray(expr)) {
    return expr.map(e => evalExpr(doc, e));
  }
  
  const op = Object.keys(expr)[0];
  if (op.startsWith('$')) {
    const val = expr[op];
    if (op === '$sum') {
      const arr = Array.isArray(val) ? val.map(e => evalExpr(doc, e)) : [evalExpr(doc, val)];
      return arr.reduce((acc, v) => acc + (typeof v === 'number' ? v : 0), 0);
    }
    if (op === '$add') {
      const arr = Array.isArray(val) ? val.map(e => evalExpr(doc, e)) : [evalExpr(doc, val)];
      return arr.reduce((acc, v) => acc + (typeof v === 'number' ? v : 0), 0);
    }
    if (op === '$gte') {
      const arr = val.map((e: any) => evalExpr(doc, e));
      return arr[0] >= arr[1];
    }
    if (op === '$eq') {
      const arr = val.map((e: any) => evalExpr(doc, e));
      return arr[0] === arr[1];
    }
    if (op === '$ne') {
      const arr = val.map((e: any) => evalExpr(doc, e));
      return arr[0] !== arr[1];
    }
    if (op === '$not') {
      const arr = Array.isArray(val) ? val.map(e => evalExpr(doc, e)) : [evalExpr(doc, val)];
      return !arr[0];
    }
    if (op === '$and') {
      const arr = val.map((e: any) => evalExpr(doc, e));
      return arr.every(Boolean);
    }
    if (op === '$or') {
      const arr = val.map((e: any) => evalExpr(doc, e));
      return arr.some(Boolean);
    }
    if (op === '$function') {
      const { body, args } = val;
      const evaluatedArgs = Array.isArray(args) ? args.map(arg => evalExpr(doc, arg)) : [];
      const fn = typeof body === 'function' ? body : eval(`(${body})`);
      return fn(...evaluatedArgs);
    }
  }
  
  const result: any = {};
  for (const [k, v] of Object.entries(expr)) {
    result[k] = evalExpr(doc, v);
  }
  return result;
}

function matchSingleValue(val: any, queryVal: any): boolean {
  if (queryVal instanceof RegExp) {
    return typeof val === 'string' && queryVal.test(val);
  }
  if (queryVal && typeof queryVal === 'object' && !Array.isArray(queryVal) && !(queryVal instanceof Date)) {
    for (const [op, opVal] of Object.entries(queryVal)) {
      if (op === '$eq' && val !== opVal) return false;
      if (op === '$ne' && val === opVal) return false;
      if (op === '$gt' && !(val > opVal)) return false;
      if (op === '$lt' && !(val < opVal)) return false;
      if (op === '$gte' && !(val >= opVal)) return false;
      if (op === '$lte' && !(val <= opVal)) return false;
      if (op === '$in' && Array.isArray(opVal) && !opVal.includes(val)) return false;
      if (op === '$not') {
        if (opVal instanceof RegExp) {
          if (typeof val === 'string' && opVal.test(val)) return false;
        } else if (matchSingleValue(val, opVal)) {
          return false;
        }
      }
      if (op === '$regex') {
        const regex = opVal instanceof RegExp ? opVal : new RegExp(String(opVal));
        if (typeof val !== 'string' || !regex.test(val)) return false;
      }
    }
    return true;
  } else {
    return val === queryVal;
  }
}

function matchValueOrArray(docVal: any, queryVal: any): boolean {
  if (matchSingleValue(docVal, queryVal)) {
    return true;
  }
  if (Array.isArray(docVal)) {
    return docVal.some(item => matchValueOrArray(item, queryVal));
  }
  return false;
}

function matchDoc(doc: any, filter: any): boolean {
  if (!filter || typeof filter !== 'object') return true;
  for (const [key, val] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(val)) {
      if (!val.every(cond => matchDoc(doc, cond))) return false;
    } else if (key === '$or' && Array.isArray(val)) {
      if (!val.some(cond => matchDoc(doc, cond))) return false;
    } else {
      const docVal = getNestedVal(doc, key);
      if (!matchValueOrArray(docVal, val)) return false;
    }
  }
  return true;
}

// Helper to verify structural equivalence and identical mock results
function verifyPipelineEquivalence(data: any[], pipeline: any[], expectedStructure: any[], db: { [coll: string]: any[] } = {}) {
  const optimized = optimizePipeline(pipeline);
  expect(optimized).toEqual(expectedStructure);
  
  const originalResult = runMockPipeline(data, pipeline, db);
  const optimizedResult = runMockPipeline(data, optimized, db);
  expect(optimizedResult).toEqual(originalResult);
}

// --- Test Suites ---

describe('optimizeFilter', () => {
  it('should return primitive and non-object inputs as-is', () => {
    expect(optimizeFilter(null)).toBeNull();
    expect(optimizeFilter(undefined)).toBeUndefined();
    expect(optimizeFilter(42)).toBe(42);
    expect(optimizeFilter('hello')).toBe('hello');
    const date = new Date();
    expect(optimizeFilter(date)).toBe(date);
    const regex = /abc/;
    expect(optimizeFilter(regex)).toBe(regex);
  });

  it('should simplify $eq operator', () => {
    expect(optimizeFilter({ x: { $eq: 10 } })).toEqual({ x: 10 });
  });

  it('should simplify single-element $in operator', () => {
    expect(optimizeFilter({ x: { $in: [42] } })).toEqual({ x: 42 });
  });

  it('should flatten nested $and operators', () => {
    const input = {
      $and: [
        { a: 1 },
        { $and: [{ b: 2 }, { c: 3 }] }
      ]
    };
    expect(optimizeFilter(input)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('should flatten nested $or operators', () => {
    const input = {
      $or: [
        { a: 1 },
        { $or: [{ b: 2 }, { c: 3 }] }
      ]
    };
    expect(optimizeFilter(input)).toEqual({
      $or: [
        { a: 1 },
        { b: 2 },
        { c: 3 }
      ]
    });
  });

  it('should merge conditions on the same field', () => {
    const input = {
      $and: [
        { a: { $gt: 5 } },
        { a: { $lt: 10 } },
        { b: 3 }
      ]
    };
    expect(optimizeFilter(input)).toEqual({
      a: { $gt: 5, $lt: 10 },
      b: 3
    });
  });

  it('should keep conflicting conditions in $and', () => {
    const input = {
      $and: [
        { a: 5 },
        { a: 10 },
        { b: 3 }
      ]
    };
    expect(optimizeFilter(input)).toEqual({
      a: 5,
      b: 3,
      $and: [
        { a: 10 }
      ]
    });

    const mergeableInput = {
      $and: [
        { a: { $gt: 5 } },
        { a: { $gt: 10 } }
      ]
    };
    expect(optimizeFilter(mergeableInput)).toEqual({
      a: { $gt: 10 }
    });
  });
});

describe('optimizePipeline', () => {
  it('should merge adjacent $match stages', () => {
    const data = [
      { age: 20, status: 'active' },
      { age: 15, status: 'active' },
      { age: 25, status: 'inactive' }
    ];
    const pipeline = [
      { $match: { age: { $gt: 18 } } },
      { $match: { status: 'active' } }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $match: { age: { $gt: 18 }, status: 'active' } }
    ]);
  });

  it('should coalesce adjacent $limit stages', () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ val: i }));
    const pipeline = [
      { $limit: 10 },
      { $limit: 5 }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $limit: 5 }
    ]);
  });

  it('should coalesce adjacent $skip stages', () => {
    const data = Array.from({ length: 50 }, (_, i) => ({ val: i }));
    const pipeline = [
      { $skip: 10 },
      { $skip: 5 }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $skip: 15 }
    ]);
  });

  it('should push $match before $project when safe', () => {
    const data = [
      { name: 'John', age: 25 },
      { name: 'Jane', age: 15 }
    ];
    const pipeline = [
      { $project: { name: 1, age: 1 } },
      { $match: { age: { $gt: 18 } } }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $match: { age: { $gt: 18 } } },
      { $project: { name: 1, age: 1 } }
    ]);
  });

  it('should not push $match before $project when it uses a computed field', () => {
    const data = [
      { name: 'John', age: 25 },
      { name: 'Jane', age: 15 }
    ];
    const pipeline = [
      { $project: { isAdult: { $gte: ['$age', 18] } } },
      { $match: { isAdult: true } }
    ];
    verifyPipelineEquivalence(data, pipeline, pipeline);
  });

  it('should push $match before $lookup when safe', () => {
    const data = [
      { _id: 1, email: 'user@example.com' },
      { _id: 2, email: 'other@example.com' }
    ];
    const db = {
      orders: [
        { userId: 1, price: 100 },
        { userId: 2, price: 200 }
      ]
    };
    const pipeline = [
      {
        $lookup: {
          from: 'orders',
          localField: '_id',
          foreignField: 'userId',
          as: 'orders'
        }
      },
      { $match: { email: 'user@example.com' } }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $match: { email: 'user@example.com' } },
      {
        $lookup: {
          from: 'orders',
          localField: '_id',
          foreignField: 'userId',
          as: 'orders'
        }
      }
    ], db);
  });

  it('should push a copy of match before $unwind if it is a simple match condition', () => {
    const data = [
      { _id: 1, items: [{ status: 'active' }, { status: 'inactive' }] },
      { _id: 2, items: [{ status: 'inactive' }] }
    ];
    const pipeline = [
      { $unwind: '$items' },
      { $match: { 'items.status': 'active' } }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $match: { 'items.status': 'active' } },
      { $unwind: '$items' },
      { $match: { 'items.status': 'active' } }
    ]);
  });

  it('should completely move match before $unwind if field does not intersect', () => {
    const data = [
      { _id: 1, category: 'electronics', items: [1, 2] },
      { _id: 2, category: 'clothing', items: [3] }
    ];
    const pipeline = [
      { $unwind: '$items' },
      { $match: { category: 'electronics' } }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $match: { category: 'electronics' } },
      { $unwind: '$items' }
    ]);
  });

  it('should remove redundant $lookup and its subsequent $unwind if alias is never used', () => {
    const data = [
      { _id: 1, email: 'test@example.com' },
      { _id: 2, email: 'other@example.com' }
    ];
    const db = {
      orders: [
        { userId: 1, val: 5 }
      ]
    };
    const pipeline = [
      {
        $lookup: {
          from: 'orders',
          localField: '_id',
          foreignField: 'userId',
          as: 'orders'
        }
      },
      { $unwind: { path: '$orders', preserveNullAndEmptyArrays: true } },
      { $project: { email: 1 } }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $project: { email: 1 } }
    ], db);
  });

  it('should NOT remove redundant $lookup and its subsequent $unwind if preserveNullAndEmptyArrays is not true', () => {
    const data = [
      { _id: 1, email: 'test@example.com' },
      { _id: 2, email: 'other@example.com' }
    ];
    const db = {
      orders: [
        { userId: 1, val: 5 }
      ]
    };
    const pipeline = [
      {
        $lookup: {
          from: 'orders',
          localField: '_id',
          foreignField: 'userId',
          as: 'orders'
        }
      },
      { $unwind: '$orders' },
      { $project: { email: 1 } }
    ];
    verifyPipelineEquivalence(data, pipeline, pipeline, db);
  });

  it('should remove passive stages if downstream only consists of $count', () => {
    const data = [
      { name: 'John', age: 25 },
      { name: 'Jane', age: 15 }
    ];
    const pipeline = [
      { $project: { name: 1, age: 1 } },
      { $addFields: { countPlusOne: { $sum: ['$age', 1] } } },
      { $count: 'total' }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $count: 'total' }
    ]);
  });

  it('should delay $lookup by pushing it past $limit and $skip', () => {
    const data = [
      { _id: 1, val: 'a' },
      { _id: 2, val: 'b' }
    ];
    const db = {
      orders: [{ userId: 1, price: 10 }]
    };
    const pipeline = [
      {
        $lookup: {
          from: 'orders',
          localField: '_id',
          foreignField: 'userId',
          as: 'orders'
        }
      },
      { $limit: 1 }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $limit: 1 },
      {
        $lookup: {
          from: 'orders',
          localField: '_id',
          foreignField: 'userId',
          as: 'orders'
        }
      }
    ], db);
  });

  it('should treat unknown stages as barriers and not reorder past them', () => {
    const data = [
      { name: 'John' },
      { name: 'Jane' }
    ];
    const pipeline = [
      { $project: { name: 1 } },
      { $myCustomStage: { config: true } },
      { $match: { name: 'John' } }
    ];
    // Since mock engine doesn't support $myCustomStage, we bypass running execution logic for this test
    const optimized = optimizePipeline(pipeline);
    expect(optimized).toEqual(pipeline);
  });

  it('should prune unused fields from $project and $addFields', () => {
    const data = [
      { name: 'John', age: 25, unusedField: 'delete' },
      { name: 'Jane', age: 15, unusedField: 'delete' }
    ];
    const pipeline = [
      { $project: { name: 1, unusedField: 1, age: 1 } },
      { $addFields: { extra: 1, temp: 2 } },
      { $project: { name: 1, extra: 1 } }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $project: { name: 1 } },
      { $addFields: { extra: 1 } },
      { $project: { name: 1, extra: 1 } }
    ]);
  });

  it('should merge adjacent $project stages', () => {
    const data = [
      { name: 'John', age: 25 }
    ];
    const pipeline = [
      { $project: { name: 1, age: 1 } },
      { $project: { name: 1 } }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $project: { name: 1 } }
    ]);
  });

  it('should merge adjacent $addFields / $set stages', () => {
    const data = [
      { name: 'John' }
    ];
    const pipeline = [
      { $addFields: { a: 1 } },
      { $set: { b: 2 } },
      { $project: { a: 1, b: 1 } }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $addFields: { a: 1, b: 2 } },
      { $project: { a: 1, b: 1 } }
    ]);
  });

  it('should push match before sort when safe', () => {
    const data = [
      { date: 2, status: 'active' },
      { date: 1, status: 'inactive' },
      { date: 3, status: 'active' }
    ];
    const pipeline = [
      { $sort: { date: -1 } },
      { $match: { status: 'active' } }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $match: { status: 'active' } },
      { $sort: { date: -1 } }
    ]);
  });

  it('should delay lookup past sort and limit', () => {
    const data = [
      { userId: 1, date: 2 },
      { userId: 2, date: 1 }
    ];
    const db = {
      users: [
        { _id: 1, name: 'John' },
        { _id: 2, name: 'Jane' }
      ]
    };
    const pipeline = [
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $sort: { date: -1 } },
      { $limit: 1 }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $sort: { date: -1 } },
      { $limit: 1 },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user'
        }
      }
    ], db);
  });

  it('should defer complex projections past sort and limit stages', () => {
    const data = [
      { name: 'John', age: 25 },
      { name: 'Jane', age: 15 }
    ];
    const pipeline = [
      { $project: { name: 1, age: 1, complex: { $sum: [1, 2] } } },
      { $sort: { age: 1 } },
      { $limit: 1 }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      { $project: { name: 1, age: 1 } },
      { $sort: { age: 1 } },
      { $limit: 1 },
      { $addFields: { complex: { $sum: [1, 2] } } }
    ]);
  });

  it('should not push match before replaceRoot or replaceWith stages', () => {
    const data = [
      { user: { name: 'John' } }
    ];
    const pipelineRoot = [
      { $replaceRoot: { newRoot: "$user" } },
      { $match: { name: 'John' } }
    ];
    verifyPipelineEquivalence(data, pipelineRoot, pipelineRoot);

    const pipelineWith = [
      { $replaceWith: "$user" },
      { $match: { name: 'John' } }
    ];
    verifyPipelineEquivalence(data, pipelineWith, pipelineWith);
  });

  it('should handle property renamings in project and addFields safely', () => {
    const data = [
      { oldName: 'John' }
    ];
    const pipelineProject = [
      { $project: { newName: "$oldName" } },
      { $match: { newName: 'John' } }
    ];
    const expectedProject = [
      { $match: { oldName: 'John' } },
      { $project: { newName: "$oldName" } }
    ];
    verifyPipelineEquivalence(data, pipelineProject, expectedProject);

    const pipelineAddFields = [
      { $addFields: { newName: "$oldName" } },
      { $match: { newName: 'John' } }
    ];
    const expectedAddFields = [
      { $match: { oldName: 'John' } },
      { $addFields: { newName: "$oldName" } }
    ];
    verifyPipelineEquivalence(data, pipelineAddFields, expectedAddFields);
  });

  it('should NOT push match before $setWindowFields stage', () => {
    const pipeline = [
      {
        $setWindowFields: {
          partitionBy: "$age",
          sortBy: { val: 1 },
          output: {
            cumulativeVal: { $sum: "$val" }
          }
        }
      },
      { $match: { name: 'John' } }
    ];
    expect(optimizePipeline(pipeline)).toEqual(pipeline);
  });

  it('should NOT push match before $setWindowFields if it uses partition, sort, or computed field', () => {
    const pipelinePartition = [
      {
        $setWindowFields: {
          partitionBy: "$age",
          sortBy: { val: 1 },
          output: { cumulativeVal: { $sum: "$val" } }
        }
      },
      { $match: { age: { $gt: 18 } } }
    ];
    expect(optimizePipeline(pipelinePartition)).toEqual(pipelinePartition);

    const pipelineSort = [
      {
        $setWindowFields: {
          partitionBy: "$age",
          sortBy: { val: 1 },
          output: { cumulativeVal: { $sum: "$val" } }
        }
      },
      { $match: { val: { $gt: 15 } } }
    ];
    expect(optimizePipeline(pipelineSort)).toEqual(pipelineSort);

    const pipelineComputed = [
      {
        $setWindowFields: {
          partitionBy: "$age",
          sortBy: { val: 1 },
          output: { cumulativeVal: { $sum: "$val" } }
        }
      },
      { $match: { cumulativeVal: { $gt: 100 } } }
    ];
    expect(optimizePipeline(pipelineComputed)).toEqual(pipelineComputed);
  });

  it('should NOT push match before $fill and $densify stages', () => {
    const pipelineFill = [
      {
        $fill: {
          partitionByFields: ["store"],
          sortBy: { date: 1 },
          output: {
            price: { value: 0 }
          }
        }
      },
      { $match: { category: "electronics" } }
    ];
    expect(optimizePipeline(pipelineFill)).toEqual(pipelineFill);

    const pipelineDensify = [
      {
        $densify: {
          field: "date",
          partitionByFields: ["store"],
          range: { bounds: [1, 10], step: 1 }
        }
      },
      { $match: { category: "electronics" } }
    ];
    expect(optimizePipeline(pipelineDensify)).toEqual(pipelineDensify);
  });

  it('should optimize match pushdown around $graphLookup stage', () => {
    const pipeline = [
      {
        $graphLookup: {
          from: "users",
          startWith: "$reportsTo",
          connectFromField: "reportsTo",
          connectToField: "name",
          as: "reportingHierarchy",
          maxDepth: 2,
          depthField: "level"
        }
      },
      { $match: { status: "active" } }
    ];
    const optimized = optimizePipeline(pipeline);
    expect(optimized[0]).toEqual({ $match: { status: "active" } });
    expect(optimized[1].$graphLookup).toBeDefined();
  });

  it('should NOT push match before $graphLookup if it references looked-up array or depthField', () => {
    const pipelineAs = [
      {
        $graphLookup: {
          from: "users",
          startWith: "$reportsTo",
          connectFromField: "reportsTo",
          connectToField: "name",
          as: "reportingHierarchy",
          depthField: "level"
        }
      },
      { $match: { "reportingHierarchy.status": "active" } }
    ];
    expect(optimizePipeline(pipelineAs)).toEqual(pipelineAs);

    const pipelineDepth = [
      {
        $graphLookup: {
          from: "users",
          startWith: "$reportsTo",
          connectFromField: "reportsTo",
          connectToField: "name",
          as: "reportingHierarchy",
          depthField: "level"
        }
      },
      { $match: { level: { $gt: 1 } } }
    ];
    expect(optimizePipeline(pipelineDepth)).toEqual(pipelineDepth);
  });

  it('should guarantee semantic equivalence on complex multi-stage pipelines', () => {
    const data = [
      { _id: 1, name: 'Apple', type: 'fruit', price: 1.5, stock: 100, supplierId: 101, tags: ['fresh', 'red'] },
      { _id: 2, name: 'Banana', type: 'fruit', price: 0.8, stock: 150, supplierId: 102, tags: ['fresh', 'yellow'] },
      { _id: 3, name: 'Carrot', type: 'vegetable', price: 1.2, stock: 80, supplierId: 101, tags: ['organic'] },
      { _id: 4, name: 'Broccoli', type: 'vegetable', price: 2.0, stock: 40, supplierId: 103, tags: ['organic', 'green'] },
      { _id: 5, name: 'Donut', type: 'bakery', price: 1.0, stock: 200, supplierId: 104, tags: ['sweet'] }
    ];
    const db = {
      suppliers: [
        { _id: 101, companyName: 'FruitCorp', country: 'USA' },
        { _id: 102, companyName: 'Chiquita', country: 'Honduras' },
        { _id: 103, companyName: 'GreenFields', country: 'Canada' },
        { _id: 104, companyName: 'SweetBaker', country: 'USA' }
      ]
    };

    const pipeline = [
      { $match: { type: { $in: ['fruit', 'vegetable'] } } },
      {
        $lookup: {
          from: 'suppliers',
          localField: 'supplierId',
          foreignField: '_id',
          as: 'supplierInfo'
        }
      },
      { $unwind: { path: '$supplierInfo', preserveNullAndEmptyArrays: true } },
      { $addFields: { totalValue: { $sum: [{ $add: ['$price', 0] }, 0] } } },
      { $match: { 'supplierInfo.country': 'USA' } },
      { $sort: { price: 1 } },
      { $project: { name: 1, price: 1, totalValue: 1, supplierCountry: '$supplierInfo.country' } },
      { $match: { price: { $gt: 1.0 } } },
      { $limit: 2 }
    ];

    const optimized = optimizePipeline(pipeline);
    expect(optimized).not.toEqual(pipeline);

    const originalResult = runMockPipeline(data, pipeline, db);
    const optimizedResult = runMockPipeline(data, optimized, db);
    expect(optimizedResult).toEqual(originalResult);
  });

  it('should correctly optimize and execute pipelines using $function operator', () => {
    const data = [
      { name: 'John', score: 85 },
      { name: 'Jane', score: 95 }
    ];
    const pipeline = [
      {
        $project: {
          name: 1,
          grade: {
            $function: {
              body: "function(score) { return score >= 90 ? 'A' : 'B'; }",
              args: ["$score"],
              lang: "js"
            }
          }
        }
      },
      { $match: { name: 'Jane' } }
    ];

    const optimized = optimizePipeline(pipeline);
    expect(optimized[0]).toEqual({ $match: { name: 'Jane' } });
    expect(optimized[1].$project).toBeDefined();

    const originalResult = runMockPipeline(data, pipeline);
    const optimizedResult = runMockPipeline(data, optimized);
    expect(optimizedResult).toEqual(originalResult);
    expect(optimizedResult).toEqual([
      { name: 'Jane', grade: 'A' }
    ]);
  });

  it('should remove redundant $lookup if downstream is a $group that does not use the alias', () => {
    const data = [
      { _id: 1, category: 'A' },
      { _id: 2, category: 'B' }
    ];
    const db = {
      orders: [
        { userId: 1, val: 5 }
      ]
    };
    const pipeline = [
      {
        $lookup: {
          from: 'orders',
          localField: '_id',
          foreignField: 'userId',
          as: 'orders'
        }
      },
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 }
        }
      }
    ];
    verifyPipelineEquivalence(data, pipeline, [
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 }
        }
      }
    ], db);
  });

  it('should correctly handle nested dependencies in projection deferral', () => {
    const data = [
      { name: 'John', age: 25, info: { status: 'active', role: 'admin' } }
    ];
    const pipeline = [
      {
        $project: {
          name: 1,
          "info.status": 1,
          customRole: {
            $function: {
              body: "function(role) { return 'Role: ' + role; }",
              args: ["$info.role"],
              lang: "js"
            }
          }
        }
      },
      { $sort: { name: 1 } }
    ];

    const optimized = optimizePipeline(pipeline);
    
    const originalResult = runMockPipeline(data, pipeline);
    const optimizedResult = runMockPipeline(data, optimized);
    expect(optimizedResult).toEqual(originalResult);
    expect(optimizedResult).toEqual([
      { name: 'John', info: { status: 'active' }, customRole: 'Role: admin' }
    ]);
  });

  it('should NOT remove redundant $lookup and its subsequent $unwind if includeArrayIndex is used downstream', () => {
    const data = [
      { _id: 1, email: 'test@example.com' }
    ];
    const db = {
      orders: [
        { userId: 1, val: 5 }
      ]
    };
    const pipeline = [
      {
        $lookup: {
          from: 'orders',
          localField: '_id',
          foreignField: 'userId',
          as: 'orders'
        }
      },
      {
        $unwind: {
          path: '$orders',
          includeArrayIndex: 'orderIdx',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $project: {
          email: 1,
          orderIdx: 1
        }
      }
    ];
    verifyPipelineEquivalence(data, pipeline, pipeline, db);
  });

  it('should NOT push a copy of match before $unwind if it is a negative condition like $ne', () => {
    const data = [
      { _id: 1, items: [{ status: 'active' }, { status: 'inactive' }] }
    ];
    const pipeline = [
      { $unwind: '$items' },
      { $match: { 'items.status': { $ne: 'active' } } }
    ];
    verifyPipelineEquivalence(data, pipeline, pipeline);
  });

  it('should NOT push a copy of match before $unwind if it is a negated condition using $not', () => {
    const data = [
      { _id: 1, items: [{ status: 'active' }, { status: 'inactive' }] }
    ];
    const pipeline = [
      { $unwind: '$items' },
      { $match: { 'items.status': { $not: { $eq: 'active' } } } }
    ];
    verifyPipelineEquivalence(data, pipeline, pipeline);
  });

  it('should push a copy of match before $unwind if it is a RegExp condition', () => {
    const data = [
      { _id: 1, items: [{ status: 'active' }, { status: 'inactive' }] },
      { _id: 2, items: [{ status: 'pending' }] }
    ];
    const pipeline = [
      { $unwind: '$items' },
      { $match: { 'items.status': /active/ } }
    ];
    const expected = [
      { $match: { 'items.status': /active/ } },
      { $unwind: '$items' },
      { $match: { 'items.status': /active/ } }
    ];
    verifyPipelineEquivalence(data, pipeline, expected);
  });

  it('should rewrite match fields and push match before $project when renaming matches', () => {
    const data = [
      { _id: 1, bar: 'bar' },
      { _id: 2, bar: 'other' }
    ];
    const pipeline = [
      { $project: { foo: '$bar' } },
      { $match: { foo: 'bar' } }
    ];
    const expected = [
      { $match: { bar: 'bar' } },
      { $project: { foo: '$bar' } }
    ];
    verifyPipelineEquivalence(data, pipeline, expected);
  });

  it('should rewrite match fields and push match before $addFields when renaming matches', () => {
    const data = [
      { _id: 1, info: { state: 'active' } },
      { _id: 2, info: { state: 'inactive' } }
    ];
    const pipeline = [
      { $addFields: { status: '$info.state' } },
      { $match: { status: 'active' } }
    ];
    const expected = [
      { $match: { 'info.state': 'active' } },
      { $addFields: { status: '$info.state' } }
    ];
    verifyPipelineEquivalence(data, pipeline, expected);
  });

  it('should merge consecutive matches on comparison operators by keeping the most restrictive limit', () => {
    const data = [
      { _id: 1, b: 150 },
      { _id: 2, b: 50 },
      { _id: 3, b: 5 }
    ];
    const pipeline = [
      { $match: { b: { $gt: 100 } } },
      { $match: { b: { $gt: 10 } } },
      { $match: { b: { $lt: 200 } } },
      { $match: { b: { $lt: 300 } } }
    ];
    const expected = [
      { $match: { b: { $gt: 100, $lt: 200 } } }
    ];
    verifyPipelineEquivalence(data, pipeline, expected);
  });

  it('should merge and intersect different $in and equality constraints on the same field', () => {
    const data = [
      { _id: 1, tag: 'apple' },
      { _id: 2, tag: 'banana' },
      { _id: 3, tag: 'cherry' }
    ];
    const pipeline = [
      { $match: { tag: { $in: ['apple', 'banana'] } } },
      { $match: { tag: 'apple' } }
    ];
    const expected = [
      { $match: { tag: 'apple' } }
    ];
    verifyPipelineEquivalence(data, pipeline, expected);

    const pipelineIn = [
      { $match: { tag: { $in: ['apple', 'banana'] } } },
      { $match: { tag: { $in: ['banana', 'cherry'] } } }
    ];
    const expectedIn = [
      { $match: { tag: 'banana' } }
    ];
    verifyPipelineEquivalence(data, pipelineIn, expectedIn);
  });

  it('should delay $lookup + $unwind pair together past $sort and $addFields', () => {
    const data = [
      { _id: 1, category: 'A', supplierId: 10, price: 3 },
      { _id: 2, category: 'B', supplierId: 20, price: 1 }
    ];
    const db = {
      suppliers: [
        { _id: 10, name: 'SupA' },
        { _id: 20, name: 'SupB' }
      ]
    };
    const pipeline = [
      {
        $lookup: {
          from: 'suppliers',
          localField: 'supplierId',
          foreignField: '_id',
          as: 'supplier'
        }
      },
      { $unwind: '$supplier' },
      { $sort: { price: 1 } },
      { $addFields: { doubled: { $sum: ['$price', '$price'] } } },
      { $project: { category: 1, price: 1, doubled: 1, supplierName: '$supplier.name' } }
    ];
    const optimized = optimizePipeline(pipeline);
    // $sort and $addFields should be before $lookup+$unwind
    const lookupIdx = optimized.findIndex((s: any) => '$lookup' in s);
    const sortIdx = optimized.findIndex((s: any) => '$sort' in s);
    const addFieldsIdx = optimized.findIndex((s: any) => '$addFields' in s);
    expect(sortIdx).toBeLessThan(lookupIdx);
    expect(addFieldsIdx).toBeLessThan(lookupIdx);

    const originalResult = runMockPipeline(data, pipeline, db);
    const optimizedResult = runMockPipeline(data, optimized, db);
    expect(optimizedResult).toEqual(originalResult);
  });

  it('should advance $limit past $project and delay $lookup after it', () => {
    const data = [
      { _id: 1, userId: 10, score: 80 },
      { _id: 2, userId: 20, score: 90 },
      { _id: 3, userId: 30, score: 70 }
    ];
    const db = {
      users: [
        { _id: 10, name: 'Alice' },
        { _id: 20, name: 'Bob' },
        { _id: 30, name: 'Charlie' }
      ]
    };
    const pipeline = [
      { $sort: { score: -1 } },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $project: { score: 1, userName: '$user' } },
      { $limit: 2 }
    ];
    const optimized = optimizePipeline(pipeline);
    // $limit should come before $lookup
    const lookupIdx = optimized.findIndex((s: any) => '$lookup' in s);
    const limitIdx = optimized.findIndex((s: any) => '$limit' in s);
    expect(limitIdx).toBeLessThan(lookupIdx);

    const originalResult = runMockPipeline(data, pipeline, db);
    const optimizedResult = runMockPipeline(data, optimized, db);
    expect(optimizedResult).toEqual(originalResult);
  });
});
