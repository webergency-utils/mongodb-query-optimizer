import { describe, it, expect } from 'vitest';
import { optimizeFilter, optimizePipeline } from './helpers/pre-gate-optimizer.js';
import { runMockPipeline } from './helpers/mock-engine.js';

// Fast structural supplement only; the MongoDB differential oracle is authoritative.
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

    it('should preserve same-field conditions under $and', () => {
        const input = {
            $and: [
                { a: { $gt: 5 } },
                { a: { $lt: 10 } },
                { b: 3 }
            ]
        };
        expect(optimizeFilter(input)).toEqual({
            a: { $gt: 5 },
            b: 3,
            $and: [
                { a: { $lt: 10 } }
            ]
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

        const repeatedFieldInput = {
            $and: [
                { a: { $gt: 5 } },
                { a: { $gt: 10 } }
            ]
        };
        expect(optimizeFilter(repeatedFieldInput)).toEqual({
            a: { $gt: 5 },
            $and: [
                { a: { $gt: 10 } }
            ]
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

    it('should delay $lookup past an alias-independent $match', () => {
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
            pipeline[0]
        ], db);
    });

    it('should optimize a simple match after $unwind with an early elemMatch prefilter', () => {
        const data = [
            { _id: 1, items: [{ status: 'active' }, { status: 'inactive' }] },
            { _id: 2, items: [{ status: 'inactive' }] }
        ];
        const pipeline = [
            { $unwind: '$items' },
            { $match: { 'items.status': 'active' } }
        ];
        verifyPipelineEquivalence(data, pipeline, [
            { $match: { items: { $elemMatch: { status: 'active' } } } },
            { $unwind: '$items' },
            { $match: { 'items.status': 'active' } }
        ]);
    });

    it('should push disjoint matches before $unwind', () => {
        const data = [
            { _id: 1, category: 'electronics', items: [1, 2] },
            { _id: 2, category: 'clothing', items: [3] }
        ];
        const pipeline = [
            { $unwind: '$items' },
            { $match: { category: 'electronics' } }
        ];
        const expected = [
            { $match: { category: 'electronics' } },
            { $unwind: '$items' }
        ];
        verifyPipelineEquivalence(data, pipeline, expected);
    });

    it('should retain $lookup and preserving $unwind without uniqueness metadata', () => {
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
        verifyPipelineEquivalence(data, pipeline, pipeline, db);
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

    it('should retain passive stages without an exact immediate kill proof', () => {
        const data = [
            { name: 'John', age: 25 },
            { name: 'Jane', age: 15 }
        ];
        const pipeline = [
            { $project: { name: 1, age: 1 } },
            { $addFields: { countPlusOne: { $sum: ['$age', 1] } } },
            { $count: 'total' }
        ];
        verifyPipelineEquivalence(data, pipeline, pipeline);
    });

    it('should delay $lookup past $limit when the alias is unused', () => {
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
            pipeline[0]
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

    it('should not prune inclusion project entries through later inclusion projections', () => {
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
            { $project: { name: 1, unusedField: 1, age: 1 } },
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

    it('should delay $lookup past alias-independent sort and limit', () => {
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
            pipeline[0]
        ], db);
    });

    it('should keep complex project evaluation before sort and limit', () => {
        const data = [
            { name: 'John', age: 25 },
            { name: 'Jane', age: 15 }
        ];
        const pipeline = [
            { $project: { name: 1, age: 1, complex: { $sum: [1, 2] } } },
            { $sort: { age: 1 } },
            { $limit: 1 }
        ];
        verifyPipelineEquivalence(data, pipeline, pipeline);
    });

    it('should not push match before replaceRoot or replaceWith stages', () => {
        const data = [
            { user: { name: 'John' } }
        ];
        const pipelineRoot = [
            { $replaceRoot: { newRoot: '$user' } },
            { $match: { name: 'John' } }
        ];
        verifyPipelineEquivalence(data, pipelineRoot, pipelineRoot);

        const pipelineWith = [
            { $replaceWith: '$user' },
            { $match: { name: 'John' } }
        ];
        verifyPipelineEquivalence(data, pipelineWith, pipelineWith);
    });

    it('should handle property renamings in project and addFields safely', () => {
        const data = [
            { oldName: 'John' }
        ];
        const pipelineProject = [
            { $project: { newName: '$oldName' } },
            { $match: { newName: 'John' } }
        ];
        const expectedProject = [
            { $match: { oldName: 'John' } },
            { $project: { newName: '$oldName' } }
        ];
        verifyPipelineEquivalence(data, pipelineProject, expectedProject);

        const pipelineAddFields = [
            { $addFields: { newName: '$oldName' } },
            { $match: { newName: 'John' } }
        ];
        const expectedAddFields = [
            { $match: { oldName: 'John' } },
            { $addFields: { newName: '$oldName' } }
        ];
        verifyPipelineEquivalence(data, pipelineAddFields, expectedAddFields);
    });

    it('should NOT push match before $setWindowFields stage', () => {
        const pipeline = [
            {
                $setWindowFields: {
                    partitionBy: '$age',
                    sortBy: { val: 1 },
                    output: {
                        cumulativeVal: { $sum: '$val' }
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
                    partitionBy: '$age',
                    sortBy: { val: 1 },
                    output: { cumulativeVal: { $sum: '$val' } }
                }
            },
            { $match: { age: { $gt: 18 } } }
        ];
        expect(optimizePipeline(pipelinePartition)).toEqual(pipelinePartition);

        const pipelineSort = [
            {
                $setWindowFields: {
                    partitionBy: '$age',
                    sortBy: { val: 1 },
                    output: { cumulativeVal: { $sum: '$val' } }
                }
            },
            { $match: { val: { $gt: 15 } } }
        ];
        expect(optimizePipeline(pipelineSort)).toEqual(pipelineSort);

        const pipelineComputed = [
            {
                $setWindowFields: {
                    partitionBy: '$age',
                    sortBy: { val: 1 },
                    output: { cumulativeVal: { $sum: '$val' } }
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
                    partitionByFields: ['store'],
                    sortBy: { date: 1 },
                    output: {
                        price: { value: 0 }
                    }
                }
            },
            { $match: { category: 'electronics' } }
        ];
        expect(optimizePipeline(pipelineFill)).toEqual(pipelineFill);

        const pipelineDensify = [
            {
                $densify: {
                    field: 'date',
                    partitionByFields: ['store'],
                    range: { bounds: [1, 10], step: 1 }
                }
            },
            { $match: { category: 'electronics' } }
        ];
        expect(optimizePipeline(pipelineDensify)).toEqual(pipelineDensify);
    });

    it('should not delay $graphLookup through an unrelated match', () => {
        const pipeline = [
            {
                $graphLookup: {
                    from: 'users',
                    startWith: '$reportsTo',
                    connectFromField: 'reportsTo',
                    connectToField: 'name',
                    as: 'reportingHierarchy',
                    maxDepth: 2,
                    depthField: 'level'
                }
            },
            { $match: { status: 'active' } }
        ];
        expect(optimizePipeline(pipeline)).toEqual(pipeline);
    });

    it('should NOT push match before $graphLookup if it references looked-up array or depthField', () => {
        const pipelineAs = [
            {
                $graphLookup: {
                    from: 'users',
                    startWith: '$reportsTo',
                    connectFromField: 'reportsTo',
                    connectToField: 'name',
                    as: 'reportingHierarchy',
                    depthField: 'level'
                }
            },
            { $match: { 'reportingHierarchy.status': 'active' } }
        ];
        expect(optimizePipeline(pipelineAs)).toEqual(pipelineAs);

        const pipelineDepth = [
            {
                $graphLookup: {
                    from: 'users',
                    startWith: '$reportsTo',
                    connectFromField: 'reportsTo',
                    connectToField: 'name',
                    as: 'reportingHierarchy',
                    depthField: 'level'
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

    it('should keep matches after volatile and potentially erroring $function projections', () => {
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
                            body: 'function(score) { return score >= 90 ? \'A\' : \'B\'; }',
                            args: ['$score'],
                            lang: 'js'
                        }
                    }
                }
            },
            { $match: { name: 'Jane' } }
        ];

        const optimized = optimizePipeline(pipeline);
        expect(optimized).toEqual(pipeline);

        const originalResult = runMockPipeline(data, pipeline);
        const optimizedResult = runMockPipeline(data, optimized);
        expect(optimizedResult).toEqual(originalResult);
        expect(optimizedResult).toEqual([
            { name: 'Jane', grade: 'A' }
        ]);
    });

    it('should retain $lookup before a group without error-free namespace metadata', () => {
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
        verifyPipelineEquivalence(data, pipeline, pipeline, db);
    });

    it('should correctly handle nested dependencies in projection deferral', () => {
        const data = [
            { name: 'John', age: 25, info: { status: 'active', role: 'admin' } }
        ];
        const pipeline = [
            {
                $project: {
                    name: 1,
                    'info.status': 1,
                    customRole: {
                        $function: {
                            body: 'function(role) { return \'Role: \' + role; }',
                            args: ['$info.role'],
                            lang: 'js'
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

    it('should keep a RegExp match after $unwind without an early duplicate', () => {
        const data = [
            { _id: 1, items: [{ status: 'active' }, { status: 'inactive' }] },
            { _id: 2, items: [{ status: 'pending' }] }
        ];
        const pipeline = [
            { $unwind: '$items' },
            { $match: { 'items.status': /active/ } }
        ];
        verifyPipelineEquivalence(data, pipeline, pipeline);
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

    it('should merge consecutive matches while preserving repeated comparison predicates', () => {
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
            {
                $match: {
                    b: { $gt: 100 },
                    $and: [
                        { b: { $gt: 10 } },
                        { b: { $lt: 200 } },
                        { b: { $lt: 300 } }
                    ]
                }
            }
        ];
        verifyPipelineEquivalence(data, pipeline, expected);
    });

    it('should preserve different $in and equality constraints on the same field', () => {
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
            {
                $match: {
                    tag: { $in: ['apple', 'banana'] },
                    $and: [
                        { tag: 'apple' }
                    ]
                }
            }
        ];
        verifyPipelineEquivalence(data, pipeline, expected);

        const pipelineIn = [
            { $match: { tag: { $in: ['apple', 'banana'] } } },
            { $match: { tag: { $in: ['banana', 'cherry'] } } }
        ];
        const expectedIn = [
            {
                $match: {
                    tag: { $in: ['apple', 'banana'] },
                    $and: [
                        { tag: { $in: ['banana', 'cherry'] } }
                    ]
                }
            }
        ];
        verifyPipelineEquivalence(data, pipelineIn, expectedIn);
    });

    it('should never delay a $lookup and $unwind pair as a composite', () => {
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
        expect(optimized).toEqual(pipeline);

        const originalResult = runMockPipeline(data, pipeline, db);
        const optimizedResult = runMockPipeline(data, optimized, db);
        expect(optimizedResult).toEqual(originalResult);
    });

    it('should advance $limit past $project and delay the preceding $lookup', () => {
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
        expect(optimized).toEqual([
            pipeline[0],
            pipeline[3],
            pipeline[1],
            pipeline[2],
        ]);

        const originalResult = runMockPipeline(data, pipeline, db);
        const optimizedResult = runMockPipeline(data, optimized, db);
        expect(optimizedResult).toEqual(originalResult);
    });

    it('should NOT remove $unset if a downstream stage reads the unset fields (bugfix)', () => {
        const data = [
            { _id: 1, name: 'Alice', age: 20 },
            { _id: 2, name: 'Bob', age: 25 }
        ];
        const pipeline = [
            { $unset: 'age' },
            { $match: { age: 20 } },
            { $project: { name: 1 } }
        ];
        verifyPipelineEquivalence(data, pipeline, [
            { $unset: 'age' },
            { $match: { age: 20 } },
            { $project: { name: 1 } }
        ]);
    });

    it('should retain $unset without a dedicated elimination proof', () => {
        const data = [
            { _id: 1, name: 'Alice', age: 20 },
            { _id: 2, name: 'Bob', age: 25 }
        ];
        const pipeline = [
            { $unset: 'age' },
            { $project: { name: 1 } }
        ];
        verifyPipelineEquivalence(data, pipeline, pipeline);
    });

    it('should retain $graphLookup when its alias is not used', () => {
        const pipeline = [
            {
                $graphLookup: {
                    from: 'users',
                    startWith: '$reportsTo',
                    connectFromField: 'reportsTo',
                    connectToField: 'name',
                    as: 'hierarchy'
                }
            },
            { $project: { name: 1 } }
        ];
        expect(optimizePipeline(pipeline)).toEqual(pipeline);
    });

    it('should commute sort and project when every sort key stays visible', () => {
        const data = [
            { name: 'Charlie', age: 30 },
            { name: 'Alice', age: 20 },
            { name: 'Bob', age: 25 }
        ];
        const pipeline = [
            { $sort: { age: 1 } },
            { $project: { name: 1, age: 1 } }
        ];
        verifyPipelineEquivalence(data, pipeline, [
            { $project: { name: 1, age: 1 } },
            { $sort: { age: 1 } }
        ]);
    });

    it('should keep sort before a project that drops the sort key', () => {
        const data = [
            { name: 'Charlie', age: 30 },
            { name: 'Alice', age: 20 },
            { name: 'Bob', age: 25 }
        ];
        const pipeline = [
            { $sort: { age: 1 } },
            { $project: { name: 1 } }
        ];
        verifyPipelineEquivalence(data, pipeline, pipeline);
    });

    it('should preserve fields referenced within $expr in downstream $match', () => {
        const data = [
            { name: 'Alice', age: 20 },
            { name: 'Bob', age: 25 }
        ];
        const pipeline = [
            { $project: { name: 1, age: 1 } },
            { $match: { $expr: { $eq: ['$age', 20] } } },
            { $project: { age: 1 } }
        ];
        // 'name' is not used downstream and eventually discarded by the final $project,
        // so it should be pruned. 'age' is referenced by $expr inside $match, so it must be preserved.
        verifyPipelineEquivalence(data, pipeline, [
            { $match: { age: 20 } },
            { $project: { age: 1 } }
        ]);
    });

    it('should preserve fields referenced within $mergeObjects', () => {
        const data = [
            { name: 'Alice', details: { age: 20 } }
        ];
        const pipeline = [
            { $project: { name: 1, details: 1 } },
            { $addFields: { merged: { $mergeObjects: ['$details', { extra: '$name' }] } } },
            { $project: { merged: 1 } }
        ];
        // 'name' and 'details' are both used in the $addFields stage via $mergeObjects.
        // 'merged' is kept by the final $project. Both 'name' and 'details' must be preserved in the first $project.
        verifyPipelineEquivalence(data, pipeline, [
            { $project: { name: 1, details: 1 } },
            { $addFields: { merged: { $mergeObjects: ['$details', { extra: '$name' }] } } },
            { $project: { merged: 1 } }
        ]);
    });

    it('should not delay pipeline-form $lookup through $addFields', () => {
        const data = [
            { _id: 1, val: 'a' }
        ];
        const db = {
            orders: [{ userId: 1, status: 'shipped' }]
        };
        const pipeline = [
            {
                $lookup: {
                    from: 'orders',
                    localField: '_id',
                    foreignField: 'userId',
                    pipeline: [
                        { $match: { status: 'shipped' } }
                    ],
                    as: 'userOrders'
                }
            },
            { $addFields: { status: 'active' } }
        ];
        expect(optimizePipeline(pipeline)).toEqual(pipeline);
    });

    it('should merge adjacent projects using true/false boolean specifications', () => {
        const data = [
            { name: 'John', age: 25 }
        ];
        const pipeline = [
            { $project: { name: true, age: true, _id: false } },
            { $project: { name: true, _id: false } }
        ];
        verifyPipelineEquivalence(data, pipeline, [
            { $project: { name: true, _id: false } }
        ]);
    });

    it('should not defer boolean inclusion projects across sort or limit', () => {
        const data = [
            { name: 'John', age: 25 }
        ];
        const pipeline = [
            { $project: { name: true, age: true, complex: { $sum: [1, 2] } } },
            { $sort: { age: 1 } },
            { $limit: 1 }
        ];
        verifyPipelineEquivalence(data, pipeline, pipeline);
    });

    it('should NOT push match before project when sub-field of the match target is modified', () => {
        const data = [
            { user: { name: 'John', age: 25 } }
        ];
        const pipeline = [
            { $project: { 'user.name': 'Jane', 'user.age': 1 } },
            { $match: { user: { name: 'Jane', age: 25 } } }
        ];
        verifyPipelineEquivalence(data, pipeline, pipeline);
    });

    it('should NOT push match on unrelated fields before destructive project that has renaming', () => {
        const data = [
            { name: 'John', tempAge: 25, otherField: 10 }
        ];
        const pipeline = [
            { $project: { name: 1, age: '$tempAge' } },
            { $match: { otherField: 10 } }
        ];
        // In original, otherField is discarded, so match results in empty array.
        // Pushing otherField before the project would incorrectly match the document and output { name: 'John', age: 25 }
        verifyPipelineEquivalence(data, pipeline, pipeline);
    });
});

describe('correctness regressions', () => {
    it('should not invent fields when merging non-subset consecutive $projects', () => {
        const data = [
            { a: 1, b: 2, c: 3 }
        ];
        const pipeline = [
            { $project: { a: 1, b: 1 } },
            { $project: { c: 1 } }
        ];

        // Arrange / Act / Assert — first project drops c; second cannot resurrect it
        verifyPipelineEquivalence(data, pipeline, pipeline);
    });

    it('should preserve _id:0 when merging exclusion project into inclusion project', () => {
        const data = [
            { _id: 1, name: 'Alice', secret: 'x' }
        ];
        const pipeline = [
            { $project: { _id: 0, secret: 0 } },
            { $project: { name: 1 } }
        ];
        const optimized = optimizePipeline(pipeline);

        // Assert
        expect(JSON.stringify(optimized).includes('"_id":0')).toBe(true);

        const originalResult = runMockPipeline(data, pipeline);
        const optimizedResult = runMockPipeline(data, optimized);
        expect(optimizedResult).toEqual(originalResult);
        expect(optimizedResult[0]._id).toBeUndefined();
    });

    it('should not delete a shielding inclusion $project when deferring its only computed field', () => {
        const data = [
            { _id: 1, name: 'Alice', extra: 'keep-me-out' }
        ];
        const pipeline = [
            { $project: { complex: { $sum: [1, 2] } } },
            { $sort: { _id: 1 } }
        ];
        const optimized = optimizePipeline(pipeline);

        // Assert — must keep a $project so extra is not leaked
        expect(optimized.some((s: any) => s.$project)).toBe(true);

        const originalResult = runMockPipeline(data, pipeline);
        const optimizedResult = runMockPipeline(data, optimized);
        expect(optimizedResult).toEqual(originalResult);
        expect(optimizedResult[0].extra).toBeUndefined();
    });

    it('should not remove $graphLookup when only depthField is used downstream', () => {
        const pipeline = [
            {
                $graphLookup: {
                    from: 'users',
                    startWith: '$reportsTo',
                    connectFromField: 'reportsTo',
                    connectToField: 'name',
                    as: 'hierarchy',
                    depthField: 'level'
                }
            },
            { $project: { level: 1 } }
        ];

        // Act
        const optimized = optimizePipeline(pipeline);

        // Assert
        expect(optimized.some((s: any) => s.$graphLookup)).toBe(true);
        expect(optimized).toEqual(pipeline);
    });

    it('should preserve empty $or as match-nothing instead of match-all', () => {
        // Act
        const got = optimizeFilter({ $or: [] });

        // Assert
        expect(got).toEqual({ $or: [] });
    });

    it('should still collapse $or of empty match-all branches to {}', () => {
        expect(optimizeFilter({ $or: [{}] })).toEqual({});
        expect(optimizeFilter({ $or: [{}, {}] })).toEqual({});
    });

    it('should preserve string and numeric $skip values for MongoDB validation', () => {
        const pipeline = [
            { $skip: '2' },
            { $skip: 3 }
        ];

        // Act
        const optimized = optimizePipeline(pipeline);

        // MongoDB, not JavaScript slice coercion in the supplemental mock, is authoritative.
        expect(optimized).toEqual(pipeline);
    });

    it('should not coalesce non-numeric $skip values via string concatenation', () => {
        const pipeline = [
            { $skip: 'abc' },
            { $skip: 3 }
        ];

        // Act
        const optimized = optimizePipeline(pipeline);

        // Assert — leave stages alone rather than producing "abc3"
        expect(optimized).toEqual(pipeline);
    });

    it('should preserve BSON-like exotic objects across optimizePipeline cloning', () => {
        class FakeObjectId {
            _bsontype = 'ObjectId';
            constructor(public id: string) {}
            equals(other: any) {
                return other && other.id === this.id;
            }
            valueOf() {
                return this.id;
            }
            toString() {
                return this.id;
            }
        }

        const oid = new FakeObjectId('abc123');
        const pipeline = [
            { $match: { _id: oid } }
        ];

        // Act
        const optimized = optimizePipeline(pipeline);

        // Assert
        expect(optimized[0].$match._id).toBeInstanceOf(FakeObjectId);
        expect(optimized[0].$match._id.id).toBe('abc123');
    });

    it('should treat $text matches as document-scoped and not push past projections', () => {
        const pipeline = [
            { $project: { name: 1, bio: 1 } },
            { $match: { $text: { $search: 'hello' } } }
        ];

        // Act
        const optimized = optimizePipeline(pipeline);

        // Assert — $text must not move before the projection
        expect(optimized[0].$project).toBeDefined();
        expect(optimized[1].$match.$text).toBeDefined();
    });

    it('should record $elemMatch nested paths under the parent field', () => {
        const data = [
            { items: [{ status: 'active' }], other: 1 },
            { items: [{ status: 'inactive' }], other: 2 }
        ];
        const pipeline = [
            { $project: { items: 1 } },
            { $match: { items: { $elemMatch: { status: 'active' } } } }
        ];

        // Act — should be able to push match before project since only items is used
        const optimized = optimizePipeline(pipeline);

        // Assert
        expect(optimized[0]).toEqual({ $match: { items: { $elemMatch: { status: 'active' } } } });
        expect(optimized[1]).toEqual({ $project: { items: 1 } });

        const originalResult = runMockPipeline(data, pipeline);
        const optimizedResult = runMockPipeline(data, optimized);
        expect(optimizedResult).toEqual(originalResult);
    });

    it('should recursively optimize $lookup sub-pipelines', () => {
        const pipeline = [
            {
                $lookup: {
                    from: 'orders',
                    localField: '_id',
                    foreignField: 'userId',
                    pipeline: [
                        { $match: { status: 'shipped' } },
                        { $match: { price: { $gt: 10 } } }
                    ],
                    as: 'orders'
                }
            }
        ];

        // Act
        const optimized = optimizePipeline(pipeline);

        // Assert
        expect(optimized[0].$lookup.pipeline).toEqual([
            { $match: { status: 'shipped', price: { $gt: 10 } } }
        ]);
    });

    it('should recursively optimize $facet sub-pipelines', () => {
        const pipeline = [
            {
                $facet: {
                    byStatus: [
                        { $match: { a: 1 } },
                        { $match: { b: 2 } }
                    ],
                    limited: [
                        { $limit: 10 },
                        { $limit: 5 }
                    ]
                }
            }
        ];

        // Act
        const optimized = optimizePipeline(pipeline);

        // Assert
        expect(optimized[0].$facet.byStatus).toEqual([
            { $match: { a: 1, b: 2 } }
        ]);
        expect(optimized[0].$facet.limited).toEqual([{ $limit: 5 }]);
    });

    it('should keep RegExp values stable across fixed-point optimization', () => {
        const pipeline = [
            { $match: { name: /alice/i } },
            { $match: { status: 'active' } }
        ];

        // Act
        const optimized = optimizePipeline(pipeline);

        // Assert
        expect(optimized).toHaveLength(1);
        expect(optimized[0].$match.name).toBeInstanceOf(RegExp);
        expect(optimized[0].$match.name.source).toBe('alice');
        expect(optimized[0].$match.name.flags).toBe('i');
        expect(optimized[0].$match.status).toBe('active');
    });
});

