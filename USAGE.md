# Usage Guide

`@webergency-utils/mongodb-query-optimizer` seamlessly integrates into existing MongoDB architectures, whether using raw Node.js drivers, ORMs like Mongoose, or microservices constructing dynamic aggregation pipelines.

---

## 1. Native MongoDB Node.js Driver Integration

You can optimize queries directly before executing them with the official `mongodb` driver.

### Find Queries

```typescript
import { MongoClient } from 'mongodb';
import { optimizeFilter } from '@webergency-utils/mongodb-query-optimizer';

const client = new MongoClient(process.env.MONGODB_URI!);
await client.connect();

const db = client.db('analytics');
const users = db.collection('users');

// Dynamically composed query with redundancies from search filters
const rawFilter = {
    $and: [
        { status: { $eq: 'active' } },
        { role: { $in: ['admin', 'admin'] } },
        { $or: [{ tier: 'enterprise' }, { tier: 'enterprise' }] }
    ]
};

// Cleaned up to: { status: 'active', role: 'admin', tier: 'enterprise' }
const optimized = optimizeFilter(rawFilter);

const results = await users.find(optimized).toArray();
```

### Aggregation Pipelines

```typescript
import { MongoClient } from 'mongodb';
import { optimizePipeline } from '@webergency-utils/mongodb-query-optimizer';

const orders = db.collection('orders');

const rawPipeline = [
    { $match: { customerId: 'cust_123' } },
    { $match: { status: { $eq: 'shipped' } } },
    { $lookup: { from: 'inventory', localField: 'sku', foreignField: 'sku', as: 'items' } },
    { $project: { orderTotal: 1, createdAt: 1 } },
    { $sort: { createdAt: -1 } }
];

// Eliminates the redundant $lookup (alias 'items' never used),
// normalizes equality, and merges the two $match stages.
const cleanPipeline = optimizePipeline(rawPipeline);

const report = await orders.aggregate(cleanPipeline).toArray();
```

---

## 2. Mongoose Middleware Integration

You can attach the optimizer automatically to Mongoose queries and aggregation pipelines using schema plugins.

### Global Query & Aggregation Plugin

```typescript
import mongoose, { Schema } from 'mongoose';
import { optimizeFilter, optimizePipeline } from '@webergency-utils/mongodb-query-optimizer';

export function queryOptimizerPlugin(schema: Schema): void
{
    // Optimize read queries (find and count operations)
    schema.pre(['find', 'findOne', 'countDocuments'], function ()
    {
        const currentFilter = this.getFilter();
        if (currentFilter && Object.keys(currentFilter).length > 0)
        {
            this.setQuery(optimizeFilter(currentFilter));
        }
    });

    // Optimize write mutations with strict error safety to guarantee identical mutation semantics
    schema.pre(['deleteOne', 'deleteMany', 'updateOne', 'updateMany'], function ()
    {
        const currentFilter = this.getFilter();
        if (currentFilter && Object.keys(currentFilter).length > 0)
        {
            this.setQuery(optimizeFilter(currentFilter, { strictErrors: true }));
        }
    });

    // Optimize aggregate pipelines (write stages like $out and $merge automatically enforce strictErrors)
    schema.pre('aggregate', function ()
    {
        const pipeline = this.pipeline();
        if (Array.isArray(pipeline) && pipeline.length > 0)
        {
            const optimized = optimizePipeline(pipeline);
            // Replace pipeline stages in-place
            pipeline.length = 0;
            pipeline.push(...optimized);
        }
    });
}

// Apply globally to all schemas
mongoose.plugin(queryOptimizerPlugin);
```

---

## 3. High-Impact Pipeline Optimization Patterns

### Pattern A: Faceted Search Common-Prefix Hoisting

When building complex faceted search queries, multiple facets often filter on common conditions (such as tenant ID, catalog visibility, or active status):

```typescript
import { optimizePipeline } from '@webergency-utils/mongodb-query-optimizer';

const facetedPipeline = [
    {
        $facet: {
            categorizedCount: [
                { $match: { tenantId: 'tenant_abc', published: true } },
                { $sortByCount: '$category' }
            ],
            priceStats: [
                { $match: { tenantId: 'tenant_abc', published: true } },
                { $group: { _id: null, avgPrice: { $avg: '$price' }, maxPrice: { $max: '$price' } } }
            ]
        }
    }
];

const hoisted = optimizePipeline(facetedPipeline);

// Result: The common { $match: { tenantId: 'tenant_abc', published: true } }
// is hoisted out of the $facet and executed once before the facet branches,
// significantly reducing memory footprint and index lookups!
// [
//   { $match: { tenantId: 'tenant_abc', published: true } },
//   {
//     $facet: {
//       categorizedCount: [{ $sortByCount: '$category' }],
//       priceStats: [{ $group: { _id: null, avgPrice: { $avg: '$price' }, maxPrice: { $max: '$price' } } }]
//     }
//   }
// ]
```

### Pattern B: `$unwind` Pre-filtering

When filtering on subfields of unwound array elements after an `$unwind`, documents with non-matching elements or empty arrays still undergo expensive memory unwinding unless pre-filtered:

```typescript
const pipeline = [
    { $unwind: { path: '$items', preserveNullAndEmptyArrays: false } },
    { $match: { 'items.status': 'in_stock' } }
];

const optimized = optimizePipeline(pipeline);

// Result: Injects a shape-safe pre-filter before $unwind to discard non-matching documents
// while safely preserving polymorphic documents (e.g. where items is an object) and nested arrays:
// [
//   {
//     $match: {
//       $or: [
//         { 'items.status': 'in_stock' },
//         { items: { $elemMatch: { $type: 'array' } } }
//       ]
//     }
//   },
//   { $unwind: { path: '$items', preserveNullAndEmptyArrays: false } },
//   { $match: { 'items.status': 'in_stock' } }
// ]
```

### Pattern C: `$group` Filter Pushdown

When filtering by grouping keys after a `$group` stage, the optimizer pushes the filter before the `$group` stage to reduce the cardinality of grouping aggregations:

```typescript
const pipeline = [
    {
        $group: {
            _id: '$departmentId',
            totalPayroll: { $sum: '$salary' }
        }
    },
    { $match: { _id: 'eng_dept' } }
];

const optimized = optimizePipeline(pipeline);

// Result:
// [
//   { $match: { departmentId: 'eng_dept' } },
//   {
//     $group: {
//       _id: '$departmentId',
//       totalPayroll: { $sum: '$salary' }
//     }
//   }
// ]
```

---

## 4. AST Stage Introspection

You can use the built-in analyzer `getStageInfo` to inspect what fields a stage reads or creates:

```typescript
import { getStageInfo } from '@webergency-utils/mongodb-query-optimizer';

const info = getStageInfo({
    $lookup: {
        from: 'warehouses',
        localField: 'inventory.warehouseId',
        foreignField: '_id',
        as: 'warehouseDetails'
    }
});

console.log(info.usedFields);     // Set { 'inventory.warehouseId' }
console.log(info.producedFields); // Set { 'warehouseDetails' }
console.log(info.isDestructive);  // false
```

---

## 5. Optimizer Options & Write-Path Guarantees

Both `optimizePipeline` and `optimizeFilter` accept an optional `OptimizerOptions` configuration object:

```typescript
import {
    optimizePipeline,
    optimizeFilter,
    type OptimizerOptions
} from '@webergency-utils/mongodb-query-optimizer';

// 1. Strict Field Order Mode
// Guarantees exact BSON document key ordering byte-for-byte:
const strictOrderPipeline = optimizePipeline(pipeline, {
    strictFieldOrder: true
});

// 2. Strict Error Mode
// Preserves runtime error occurrence, timing, and conditions:
const strictErrorPipeline = optimizePipeline(pipeline, {
    strictErrors: true
});

// 3. Combined Strict Mode
const fullyStrictPipeline = optimizePipeline(pipeline, {
    strictFieldOrder: true,
    strictErrors: true
});
```

### Write-Path Recommendations
- **Aggregation Pipelines with `$out` or `$merge`**: Write stages automatically enforce `strictErrors: true` internally to prevent altering partial writes or suppressing runtime errors.
- **Update and Delete Filters**: When passing query filters to destructive operations (`updateOne`, `updateMany`, `deleteOne`, `deleteMany`), always pass `{ strictErrors: true }` to guarantee that error-prone filter expressions are evaluated with identical safety semantics.
