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
    // Optimize find and count operations
    schema.pre(['find', 'findOne', 'countDocuments', 'deleteMany', 'updateMany'], function ()
    {
        const currentFilter = this.getFilter();
        if (currentFilter && Object.keys(currentFilter).length > 0)
        {
            this.setQuery(optimizeFilter(currentFilter));
        }
    });

    // Optimize aggregate pipelines
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

When filtering on nested array items after an `$unwind`, documents with empty or missing arrays still undergo expensive memory unwinding unless pre-filtered:

```typescript
const pipeline = [
    { $unwind: { path: '$tags', preserveNullAndEmptyArrays: false } },
    { $match: { tags: 'featured' } }
];

const optimized = optimizePipeline(pipeline);

// Result: Injects an $elemMatch pre-filter before $unwind to discard documents
// without matching tags before array expansion:
// [
//   { $match: { tags: { $elemMatch: { $eq: 'featured' } } } },
//   { $unwind: { path: '$tags', preserveNullAndEmptyArrays: false } },
//   { $match: { tags: 'featured' } }
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

You can use the built-in analyzer `getStageInfo` to inspect what fields a stage reads or writes:

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

console.log(info.reads);  // Set { 'inventory.warehouseId' }
console.log(info.writes); // Set { 'warehouseDetails' }
console.log(info.isPure); // true
```
