import { describe, expect, it } from 'vitest';
import { optimizeFilter, optimizePipeline } from '../src/index.js';
import { optimizePipelineWithCandidateProfile } from '../src/passes/registry.js';
import { runMockPipeline } from './helpers/mock-engine.js';

describe( 'End-to-End Complex Query Suite', () =>
{
    // -------------------------------------------------------------------------
    // 1. E-Commerce Order Fulfillment & Multi-Item Logistics
    // -------------------------------------------------------------------------
    describe( 'E-Commerce Order Fulfillment & Multi-Item Logistics', () =>
    {
        const database = {
            customers: [
                { _id: 'cust-1', name: 'Alice Smith', tier: 'gold', region: 'NA' },
                { _id: 'cust-2', name: 'Bob Jones', tier: 'silver', region: 'EMEA' },
                { _id: 'cust-3', name: 'Charlie Brown', tier: 'bronze', region: 'APAC' },
                { _id: 'cust-4', name: 'Diana Prince', tier: 'gold', region: 'NA' }
            ]
        };

        const ordersDataset = [
            {
                _id: 'ord-101',
                orderNumber: 'SO-101',
                customerId: 'cust-1',
                status: 'completed',
                storeId: 'store-east',
                items: [
                    { sku: 'LAPTOP-01', category: 'electronics', price: 1200, qty: 1, inStock: true },
                    { sku: 'MOUSE-01', category: 'accessories', price: 25, qty: 2, inStock: true }
                ]
            },
            {
                _id: 'ord-102',
                orderNumber: 'SO-102',
                customerId: 'cust-2',
                status: 'completed',
                storeId: 'store-east',
                items: [
                    { sku: 'PHONE-01', category: 'electronics', price: 800, qty: 1, inStock: true },
                    { sku: 'CASE-01', category: 'accessories', price: 15, qty: 1, inStock: false }
                ]
            },
            {
                _id: 'ord-103',
                orderNumber: 'SO-103',
                customerId: 'cust-1',
                status: 'cancelled',
                storeId: 'store-east',
                items: [
                    { sku: 'TABLET-01', category: 'electronics', price: 500, qty: 1, inStock: true }
                ]
            },
            {
                _id: 'ord-104',
                orderNumber: 'SO-104',
                customerId: 'cust-4',
                status: 'completed',
                storeId: 'store-east',
                items: [
                    { sku: 'KEYBOARD-01', category: 'accessories', price: 90, qty: 1, inStock: true },
                    { sku: 'MONITOR-01', category: 'electronics', price: 400, qty: 2, inStock: true }
                ]
            },
            {
                _id: 'ord-105',
                orderNumber: 'SO-105',
                customerId: 'cust-3',
                status: 'completed',
                storeId: 'store-west',
                items: [
                    { sku: 'MOUSE-01', category: 'accessories', price: 25, qty: 1, inStock: true }
                ]
            }
        ];

        it( 'optimizes multi-stage e-commerce order processing pipeline and preserves result parity', () =>
        {
            const pipeline = [
                {
                    $match: {
                        status: 'completed',
                        storeId: 'store-east'
                    }
                },
                {
                    $lookup: {
                        from: 'customers',
                        localField: 'customerId',
                        foreignField: '_id',
                        as: 'customer'
                    }
                },
                {
                    $unwind: '$customer'
                },
                {
                    $unwind: '$items'
                },
                {
                    $match: {
                        'items.category': 'electronics',
                        'items.price': { $gte: 400 }
                    }
                },
                {
                    $addFields: {
                        lineRevenue: { $multiply: [ '$items.price', '$items.qty' ] }
                    }
                },
                {
                    $group: {
                        _id: '$customer.tier',
                        totalRevenue: { $sum: '$lineRevenue' },
                        totalUnits: { $sum: '$items.qty' },
                        orderCount: { $sum: 1 }
                    }
                },
                {
                    $match: {
                        _id: 'gold'
                    }
                },
                {
                    $sort: { totalRevenue: -1 }
                }
            ];

            const optimized = optimizePipeline( pipeline );

            // Verifications of optimization passes:
            // 1. Group filter pushdown: match on _id: 'gold' pushed to pre-filter on customer.tier before $group
            // 2. Unwind prefilter: elemMatch synthesized before $unwind
            // 3. Execution parity between original and optimized queries
            const originalResults = runMockPipeline( ordersDataset, pipeline, database );
            const optimizedResults = runMockPipeline( ordersDataset, optimized, database );

            expect( optimizedResults ).toEqual( originalResults );
            expect( optimizedResults ).toEqual(
                [
                    { _id: 'gold', totalRevenue: 2000, totalUnits: 3, orderCount: 2 }
                ]
            );
        });
    });

    // -------------------------------------------------------------------------
    // 2. Executive Multi-Metric Analytics Dashboard with $facet
    // -------------------------------------------------------------------------
    describe( 'Executive Multi-Metric Analytics Dashboard with $facet', () =>
    {
        const salesDataset = [
            { _id: 1, orgId: 'org-main', region: 'North', category: 'hardware', amount: 500, customerTier: 'vip' },
            { _id: 2, orgId: 'org-main', region: 'North', category: 'software', amount: 300, customerTier: 'standard' },
            { _id: 3, orgId: 'org-main', region: 'South', category: 'hardware', amount: 700, customerTier: 'vip' },
            { _id: 4, orgId: 'org-other', region: 'North', category: 'hardware', amount: 999, customerTier: 'vip' },
            { _id: 5, orgId: 'org-main', region: 'South', category: 'software', amount: 200, customerTier: 'standard' },
            { _id: 6, orgId: 'org-main', region: 'East', category: 'hardware', amount: 450, customerTier: 'vip' }
        ];

        it( 'optimizes faceted analytics with hoisted common prefixes and internal grouping', () =>
        {
            const pipeline = [
                {
                    $facet: {
                        regionalRevenue: [
                            { $match: { orgId: 'org-main' } },
                            { $group: { _id: '$region', total: { $sum: '$amount' } } },
                            { $sort: { total: -1 } }
                        ],
                        categoryVolume: [
                            { $match: { orgId: 'org-main' } },
                            { $group: { _id: '$category', count: { $sum: 1 }, total: { $sum: '$amount' } } },
                            { $sort: { count: -1 } }
                        ],
                        vipSummary: [
                            { $match: { orgId: 'org-main' } },
                            { $group: { _id: '$customerTier', vipRevenue: { $sum: '$amount' }, vipCount: { $sum: 1 } } },
                            { $match: { _id: 'vip' } }
                        ]
                    }
                }
            ];

            const optimized = optimizePipeline( pipeline );

            // Verify common { orgId: 'org-main' } is hoisted out of the $facet
            expect( optimized[0] ).toEqual(
                {
                    $match: {
                        orgId: 'org-main'
                    }
                }
            );

            const originalResults = runMockPipeline( salesDataset, pipeline );
            const optimizedResults = runMockPipeline( salesDataset, optimized );

            expect( optimizedResults ).toEqual( originalResults );
            expect( optimizedResults ).toHaveLength( 1 );
            expect( optimizedResults[0].regionalRevenue ).toHaveLength( 3 );
            expect( optimizedResults[0].vipSummary ).toEqual(
                [
                    { _id: 'vip', vipRevenue: 1650, vipCount: 3 }
                ]
            );
        });
    });

    // -------------------------------------------------------------------------
    // 3. Hierarchical Activity Feed & Social Feed Optimization
    // -------------------------------------------------------------------------
    describe( 'Hierarchical Activity Feed & Social Feed Optimization', () =>
    {
        const database = {
            users: [
                { _id: 'u-1', handle: 'alice', badge: 'verified', status: 'active' },
                { _id: 'u-2', handle: 'bob', badge: 'standard', status: 'active' },
                { _id: 'u-3', handle: 'spammer', badge: 'flagged', status: 'suspended' }
            ]
        };

        const postsDataset = [
            {
                _id: 'p-1',
                authorId: 'u-1',
                content: 'Hello World',
                likes: 150,
                isDeleted: false,
                tags: [ 'tech', 'announcement' ],
                commentList: [
                    { authorId: 'u-2', text: 'Nice post!' }
                ]
            },
            {
                _id: 'p-2',
                authorId: 'u-2',
                content: 'Just another day',
                likes: 12,
                isDeleted: false,
                tags: [ 'general' ],
                commentList: []
            },
            {
                _id: 'p-3',
                authorId: 'u-3',
                content: 'Buy crypto now',
                likes: 0,
                isDeleted: true,
                tags: [ 'spam' ],
                commentList: []
            },
            {
                _id: 'p-4',
                authorId: 'u-1',
                content: 'Deep Dive on Query Optimizers',
                likes: 320,
                isDeleted: false,
                tags: [ 'tech', 'database' ],
                commentList: [
                    { authorId: 'u-2', text: 'Amazing insights!' }
                ]
            }
        ];

        it( 'optimizes feed queries with lookup, projection merging, and coalesced pagination', () =>
        {
            const pipeline = [
                {
                    $match: {
                        isDeleted: false
                    }
                },
                {
                    $lookup: {
                        from: 'users',
                        localField: 'authorId',
                        foreignField: '_id',
                        as: 'author'
                    }
                },
                {
                    $unwind: '$author'
                },
                {
                    $match: {
                        'author.status': 'active'
                    }
                },
                {
                    $project: {
                        _id: 1,
                        content: 1,
                        likes: 1,
                        authorHandle: '$author.handle',
                        authorBadge: '$author.badge',
                        tagCount: { $size: '$tags' }
                    }
                },
                {
                    $project: {
                        _id: 1,
                        content: 1,
                        likes: 1,
                        authorHandle: 1,
                        authorBadge: 1
                    }
                },
                {
                    $sort: { likes: -1 }
                },
                {
                    $skip: 0
                },
                {
                    $limit: 10
                },
                {
                    $limit: 2
                }
            ];

            const optimized = optimizePipeline( pipeline );

            // Adjacent projections merged, limits coalesced
            const originalResults = runMockPipeline( postsDataset, pipeline, database );
            const optimizedResults = runMockPipeline( postsDataset, optimized, database );

            expect( optimizedResults ).toEqual( originalResults );
            expect( optimizedResults ).toHaveLength( 2 );
            expect( optimizedResults[0]._id ).toBe( 'p-4' );
            expect( optimizedResults[1]._id ).toBe( 'p-1' );
        });
    });

    // -------------------------------------------------------------------------
    // 4. IoT Fleet Telemetry & Sensor Anomaly Detection
    // -------------------------------------------------------------------------
    describe( 'IoT Fleet Telemetry & Sensor Anomaly Detection', () =>
    {
        const telemetryDataset = [
            { _id: 'dev-1', type: 'thermal', zone: 'A1', batteryLevel: 85, reading: { celsius: 45.2, status: 'nominal' } },
            { _id: 'dev-2', type: 'thermal', zone: 'A1', batteryLevel: 10, reading: { celsius: 92.5, status: 'warning' } }, // low battery
            { _id: 'dev-3', type: 'pressure', zone: 'A2', batteryLevel: 70, reading: { psi: 120, status: 'nominal' } },
            { _id: 'dev-4', type: 'thermal', zone: 'B1', batteryLevel: 90, reading: { celsius: 78.0, status: 'warning' } },
            { _id: 'dev-5', type: 'thermal', zone: 'A1', batteryLevel: 55, reading: { celsius: 88.1, status: 'warning' } }
        ];

        it( 'normalizes $expr comparisons, merges adjacent filters, and executes with parity', () =>
        {
            const pipeline = [
                {
                    $match: {
                        $expr: {
                            $gte: [ '$batteryLevel', 20 ]
                        }
                    }
                },
                {
                    $match: {
                        type: 'thermal',
                        'reading.status': 'warning'
                    }
                },
                {
                    $group: {
                        _id: '$zone',
                        alertCount: { $sum: 1 },
                        maxTemp: { $max: '$reading.celsius' }
                    }
                },
                {
                    $sort: { maxTemp: -1 }
                }
            ];

            const optimized = optimizePipeline( pipeline );

            // First match: $expr normalized to native { batteryLevel: { $gte: 20 } }
            // Adjacent matches merged
            expect( optimized[0].$match.batteryLevel ).toEqual( { $gte: 20 } );
            expect( optimized[0].$match.type ).toBe( 'thermal' );

            const originalResults = runMockPipeline( telemetryDataset, pipeline );
            const optimizedResults = runMockPipeline( telemetryDataset, optimized );

            expect( optimizedResults ).toEqual( originalResults );
            expect( optimizedResults ).toEqual(
                [
                    { _id: 'A1', alertCount: 1, maxTemp: 88.1 },
                    { _id: 'B1', alertCount: 1, maxTemp: 78.0 }
                ]
            );
        });
    });

    // -------------------------------------------------------------------------
    // 5. Financial Ledger & Multi-Currency Reconciliation
    // -------------------------------------------------------------------------
    describe( 'Financial Ledger & Multi-Currency Reconciliation', () =>
    {
        const ledgerDataset = [
            { _id: 1, accountNo: 'ACC-100', currency: 'EUR', debit: 250, credit: 0, reconciled: true },
            { _id: 2, accountNo: 'ACC-100', currency: 'EUR', debit: 150, credit: 0, reconciled: true },
            { _id: 3, accountNo: 'ACC-200', currency: 'USD', debit: 500, credit: 50, reconciled: true },
            { _id: 4, accountNo: 'ACC-100', currency: 'EUR', debit: 0, credit: 100, reconciled: false },
            { _id: 5, accountNo: 'ACC-300', currency: 'GBP', debit: 300, credit: 0, reconciled: true }
        ];

        it( 'optimizes ledger aggregation with singleton $in simplification and group pushdown', () =>
        {
            const pipeline = [
                {
                    $match: {
                        currency: { $in: [ 'EUR' ] },
                        reconciled: true
                    }
                },
                {
                    $group: {
                        _id: '$accountNo',
                        totalDebit: { $sum: '$debit' },
                        totalCredit: { $sum: '$credit' }
                    }
                },
                {
                    $match: {
                        _id: 'ACC-100'
                    }
                }
            ];

            const optimized = optimizePipeline( pipeline );

            // $match on _id should be pushed before $group, and single-element $in simplified to equality
            const originalResults = runMockPipeline( ledgerDataset, pipeline );
            const optimizedResults = runMockPipeline( ledgerDataset, optimized );

            expect( optimizedResults ).toEqual( originalResults );
            expect( optimizedResults ).toEqual(
                [
                    { _id: 'ACC-100', totalDebit: 400, totalCredit: 0 }
                ]
            );
        });
    });

    // -------------------------------------------------------------------------
    // 6. Deep Filter Normalization & Document Matching Parity
    // -------------------------------------------------------------------------
    describe( 'Deep Filter Normalization & Document Matching Parity', () =>
    {
        const catalogDataset = [
            { _id: 1, title: 'Clean Architecture', category: 'Tech', stock: 15, rating: 4.8 },
            { _id: 2, title: 'Design Patterns', category: 'Tech', stock: 0, rating: 4.9 },
            { _id: 3, title: 'The Hobbit', category: 'Fiction', stock: 50, rating: 4.7 },
            { _id: 4, title: 'Outliers', category: 'Non-Fiction', stock: 20, rating: 4.2 }
        ];

        it( 'flattens redundant nested $and trees and simplifies singleton $in clauses', () =>
        {
            const complexFilter = {
                $and: [
                    { category: { $in: [ 'Tech' ] } },
                    {
                        $and: [
                            { stock: { $gt: 0 } },
                            {
                                $and: [
                                    { rating: { $gte: 4.5 } }
                                ]
                            }
                        ]
                    }
                ]
            };

            const optimizedFilter = optimizeFilter( complexFilter );

            const originalPipeline = [ { $match: complexFilter } ];
            const optimizedPipeline = [ { $match: optimizedFilter } ];

            const originalResults = runMockPipeline( catalogDataset, originalPipeline );
            const optimizedResults = runMockPipeline( catalogDataset, optimizedPipeline );

            expect( optimizedResults ).toEqual( originalResults );
            expect( optimizedResults ).toHaveLength( 1 );
            expect( optimizedResults[0].title ).toBe( 'Clean Architecture' );
        });
    });

    // -------------------------------------------------------------------------
    // 7. Extreme 12-Stage Pipeline with Cascading Interactions
    // -------------------------------------------------------------------------
    describe( 'Extreme 12-Stage Pipeline with Cascading Interactions', () =>
    {
        const dataset = [
            {
                _id: 'emp-1',
                empId: 101,
                name: 'Alice',
                dept: 'Engineering',
                status: 'active',
                skills: [
                    { name: 'TypeScript', years: 5 },
                    { name: 'MongoDB', years: 3 }
                ],
                meta: { internalRank: 4 }
            },
            {
                _id: 'emp-2',
                empId: 102,
                name: 'Bob',
                dept: 'Engineering',
                status: 'active',
                skills: [
                    { name: 'Python', years: 4 }
                ],
                meta: { internalRank: 2 }
            },
            {
                _id: 'emp-3',
                empId: 103,
                name: 'Charlie',
                dept: 'Sales',
                status: 'active',
                skills: [
                    { name: 'Negotiation', years: 7 }
                ],
                meta: { internalRank: 5 }
            },
            {
                _id: 'emp-4',
                empId: 104,
                name: 'Diana',
                dept: 'Engineering',
                status: 'inactive',
                skills: [
                    { name: 'TypeScript', years: 2 }
                ],
                meta: { internalRank: 1 }
            }
        ];

        it( 'successfully executes complex cascading passes and maintains exact output identity', () =>
        {
            const pipeline = [
                // 1. Initial filter
                { $match: { status: 'active' } },
                // 2. Second adjacent filter (mergable)
                { $match: { dept: 'Engineering' } },
                // 3. Unwind skills
                { $unwind: '$skills' },
                // 4. Match on unwound child field (eligible for unwind-prefilter)
                { $match: { 'skills.name': 'TypeScript' } },
                // 5. Add fields
                { $addFields: { seniorityBonus: { $multiply: [ '$skills.years', 1000 ] } } },
                // 6. Group by department
                {
                    $group: {
                        _id: '$dept',
                        totalSeniorityBonus: { $sum: '$seniorityBonus' },
                        tsSpecialistCount: { $sum: 1 }
                    }
                },
                // 7. Match after group (eligible for group filter pushdown)
                { $match: { _id: 'Engineering' } },
                // 8. Sort
                { $sort: { totalSeniorityBonus: -1 } },
                // 9. Skip
                { $skip: 0 },
                // 10. Limit 100
                { $limit: 100 },
                // 11. Coalesceable limit 1
                { $limit: 1 }
            ];

            const optimized = optimizePipeline( pipeline );

            // Verify the pipeline shrunk significantly due to pass coalescing and merging
            expect( optimized.length ).toBeLessThan( pipeline.length );

            const originalResults = runMockPipeline( dataset, pipeline );
            const optimizedResults = runMockPipeline( dataset, optimized );

            expect( optimizedResults ).toEqual( originalResults );
            expect( optimizedResults ).toEqual(
                [
                    {
                        _id: 'Engineering',
                        totalSeniorityBonus: 5000,
                        tsSpecialistCount: 1
                    }
                ]
            );
        });
    });

    // -------------------------------------------------------------------------
    // 8. Nested Double Unwinds with Multi-Level Filters
    // -------------------------------------------------------------------------
    describe( 'Nested Double Unwinds with Multi-Level Filters', () =>
    {
        const shipmentDataset = [
            {
                _id: 'ship-1',
                orderRef: 'ORD-1',
                packages: [
                    {
                        packageId: 'pkg-1',
                        carrier: 'DHL',
                        items: [
                            { sku: 'ITEM-1', weight: 2.5 },
                            { sku: 'ITEM-2', weight: 0.8 }
                        ]
                    },
                    {
                        packageId: 'pkg-2',
                        carrier: 'FedEx',
                        items: [
                            { sku: 'ITEM-3', weight: 12.0 }
                        ]
                    }
                ]
            },
            {
                _id: 'ship-2',
                orderRef: 'ORD-2',
                packages: [
                    {
                        packageId: 'pkg-3',
                        carrier: 'DHL',
                        items: [
                            { sku: 'ITEM-4', weight: 1.2 }
                        ]
                    }
                ]
            },
            {
                _id: 'ship-3',
                orderRef: 'ORD-3',
                packages: []
            }
        ];

        it( 'optimizes nested package and item unwinds with synthesised prefilters and parity', () =>
        {
            const pipeline = [
                { $unwind: '$packages' },
                { $match: { 'packages.carrier': 'DHL' } },
                { $unwind: '$packages.items' },
                { $match: { 'packages.items.weight': { $gt: 2.0 } } },
                {
                    $project: {
                        _id: 1,
                        orderRef: 1,
                        carrier: '$packages.carrier',
                        itemSku: '$packages.items.sku',
                        itemWeight: '$packages.items.weight'
                    }
                }
            ];

            const optimized = optimizePipeline( pipeline );
            const originalResults = runMockPipeline( shipmentDataset, pipeline );
            const optimizedResults = runMockPipeline( shipmentDataset, optimized );

            expect( optimizedResults ).toEqual( originalResults );
            expect( optimizedResults ).toEqual(
                [
                    {
                        _id: 'ship-1',
                        orderRef: 'ORD-1',
                        carrier: 'DHL',
                        itemSku: 'ITEM-1',
                        itemWeight: 2.5
                    }
                ]
            );
        });
    });

    // -------------------------------------------------------------------------
    // 9. Multi-Tenant SaaS Usage Quota & Billing Aggregation
    // -------------------------------------------------------------------------
    describe( 'Multi-Tenant SaaS Usage Quota & Billing Aggregation', () =>
    {
        const apiLogsDataset = [
            { _id: 1, tenantId: 'tenant-alpha', endpoint: '/v1/charge', status: 200, responseMs: 45, bytesSent: 1200 },
            { _id: 2, tenantId: 'tenant-alpha', endpoint: '/v1/refund', status: 200, responseMs: 80, bytesSent: 800 },
            { _id: 3, tenantId: 'tenant-beta', endpoint: '/v1/charge', status: 500, responseMs: 300, bytesSent: 200 },
            { _id: 4, tenantId: 'tenant-alpha', endpoint: '/v1/charge', status: 400, responseMs: 12, bytesSent: 400 },
            { _id: 5, tenantId: 'tenant-gamma', endpoint: '/v1/verify', status: 200, responseMs: 35, bytesSent: 600 }
        ];

        it( 'optimizes tenant usage pipeline with group filter pushdown and sorting', () =>
        {
            const pipeline = [
                {
                    $match: {
                        status: 200
                    }
                },
                {
                    $group: {
                        _id: '$tenantId',
                        totalBytes: { $sum: '$bytesSent' },
                        avgResponseMs: { $avg: '$responseMs' },
                        callCount: { $sum: 1 }
                    }
                },
                {
                    $match: {
                        _id: 'tenant-alpha'
                    }
                },
                {
                    $sort: { totalBytes: -1 }
                }
            ];

            const optimized = optimizePipeline( pipeline );

            // Group filter pushdown will push { tenantId: 'tenant-alpha' } before $group
            expect( optimized[0].$match.tenantId ).toBe( 'tenant-alpha' );
            expect( optimized[0].$match.status ).toBe( 200 );

            const originalResults = runMockPipeline( apiLogsDataset, pipeline );
            const optimizedResults = runMockPipeline( apiLogsDataset, optimized );

            expect( optimizedResults ).toEqual( originalResults );
            expect( optimizedResults ).toEqual(
                [
                    {
                        _id: 'tenant-alpha',
                        totalBytes: 2000,
                        avgResponseMs: 62.5,
                        callCount: 2
                    }
                ]
            );
        });
    });

    // -------------------------------------------------------------------------
    // 10. Supply Chain Inventory & Sort-Project Commuting
    // -------------------------------------------------------------------------
    describe( 'Supply Chain Inventory & Sort-Project Commuting', () =>
    {
        const supplierDatabase = {
            vendors: [
                { _id: 'ven-1', name: 'Munich Tech Parts', country: 'DE', leadDays: 3 },
                { _id: 'ven-2', name: 'Tokyo Micro Electronics', country: 'JP', leadDays: 7 },
                { _id: 'ven-3', name: 'Berlin Cables', country: 'DE', leadDays: 2 }
            ]
        };

        const warehouseDataset = [
            { _id: 'inv-1', sku: 'PART-A', vendorId: 'ven-1', qtyOnHand: 15, reorderLevel: 20 },
            { _id: 'inv-2', sku: 'PART-B', vendorId: 'ven-2', qtyOnHand: 5, reorderLevel: 10 },
            { _id: 'inv-3', sku: 'PART-C', vendorId: 'ven-1', qtyOnHand: 50, reorderLevel: 25 },
            { _id: 'inv-4', sku: 'PART-D', vendorId: 'ven-3', qtyOnHand: 2, reorderLevel: 15 }
        ];

        it( 'optimizes reorder queue with sort-project commuting and foreign lookups', () =>
        {
            const pipeline = [
                {
                    $project: {
                        sku: 1,
                        vendorId: 1,
                        qtyOnHand: 1,
                        reorderLevel: 1,
                        needsReorder: { $lt: [ '$qtyOnHand', '$reorderLevel' ] }
                    }
                },
                {
                    $sort: { qtyOnHand: 1 }
                },
                {
                    $lookup: {
                        from: 'vendors',
                        localField: 'vendorId',
                        foreignField: '_id',
                        as: 'vendor'
                    }
                },
                {
                    $unwind: '$vendor'
                },
                {
                    $match: {
                        'vendor.country': 'DE'
                    }
                },
                {
                    $limit: 2
                }
            ];

            const optimized = optimizePipeline( pipeline );
            const originalResults = runMockPipeline( warehouseDataset, pipeline, supplierDatabase );
            const optimizedResults = runMockPipeline( warehouseDataset, optimized, supplierDatabase );

            expect( optimizedResults ).toEqual( originalResults );
            expect( optimizedResults ).toHaveLength( 2 );
            expect( optimizedResults[0].sku ).toBe( 'PART-D' );
            expect( optimizedResults[1].sku ).toBe( 'PART-A' );
        });
    });

    // -------------------------------------------------------------------------
    // 11. Security Audit Log with $nor, $exists, and $nin operators
    // -------------------------------------------------------------------------
    describe( 'Security Audit Log with $nor, $exists, and $nin operators', () =>
    {
        const auditDataset = [
            { _id: 1, event: 'login', ip: '192.168.1.1', severity: 'low', user: { role: 'admin', mfa: true } },
            { _id: 2, event: 'export', ip: '10.0.0.5', severity: 'high', user: { role: 'analyst', mfa: false } },
            { _id: 3, event: 'login', ip: '192.168.1.50', severity: 'critical', user: { role: 'guest' } }, // no mfa field
            { _id: 4, event: 'passwd_change', ip: '172.16.0.1', severity: 'medium', user: { role: 'admin', mfa: true } },
            { _id: 5, event: 'revoke', ip: '10.0.0.99', severity: 'low', user: { role: 'operator', mfa: true } }
        ];

        it( 'evaluates complex security auditing conditions with full execution parity', () =>
        {
            const pipeline = [
                {
                    $match: {
                        'user.mfa': { $exists: true },
                        severity: { $nin: [ 'low' ] },
                        $nor: [
                            { event: 'passwd_change' }
                        ]
                    }
                },
                {
                    $project: {
                        _id: 1,
                        event: 1,
                        userRole: '$user.role',
                        severity: 1
                    }
                }
            ];

            const optimized = optimizePipeline( pipeline );
            const originalResults = runMockPipeline( auditDataset, pipeline );
            const optimizedResults = runMockPipeline( auditDataset, optimized );

            expect( optimizedResults ).toEqual( originalResults );
            expect( optimizedResults ).toEqual(
                [
                    { _id: 2, event: 'export', userRole: 'analyst', severity: 'high' }
                ]
            );
        });
    });

    // -------------------------------------------------------------------------
    // 12. Clinical Trials Cohort Filtration & Multi-Group Metrics
    // -------------------------------------------------------------------------
    describe( 'Clinical Trials Cohort Filtration & Multi-Group Metrics', () =>
    {
        const patientDataset = [
            {
                _id: 'P-001',
                studyGroup: 'Control',
                demographics: { age: 54, gender: 'F' },
                biomarkers: { hba1c: 6.8, systolicBp: 135 },
                adverseEvents: []
            },
            {
                _id: 'P-002',
                studyGroup: 'Treatment-A',
                demographics: { age: 62, gender: 'M' },
                biomarkers: { hba1c: 7.4, systolicBp: 142 },
                adverseEvents: [ { severity: 'mild', code: 'AE-01' } ]
            },
            {
                _id: 'P-003',
                studyGroup: 'Treatment-A',
                demographics: { age: 48, gender: 'F' },
                biomarkers: { hba1c: 6.1, systolicBp: 120 },
                adverseEvents: []
            },
            {
                _id: 'P-004',
                studyGroup: 'Treatment-B',
                demographics: { age: 71, gender: 'M' },
                biomarkers: { hba1c: 8.5, systolicBp: 160 },
                adverseEvents: [ { severity: 'moderate', code: 'AE-05' } ]
            },
            {
                _id: 'P-005',
                studyGroup: 'Treatment-A',
                demographics: { age: 58, gender: 'M' },
                biomarkers: { hba1c: 7.0, systolicBp: 130 },
                adverseEvents: []
            }
        ];

        it( 'optimizes clinical cohort aggregation with nested paths and group projection', () =>
        {
            const pipeline = [
                {
                    $match: {
                        'demographics.age': { $gte: 50 },
                        'biomarkers.hba1c': { $gte: 6.5 }
                    }
                },
                {
                    $group: {
                        _id: '$studyGroup',
                        patientCount: { $sum: 1 },
                        avgAge: { $avg: '$demographics.age' },
                        maxBp: { $max: '$biomarkers.systolicBp' }
                    }
                },
                {
                    $match: {
                        _id: 'Treatment-A'
                    }
                }
            ];

            const optimized = optimizePipeline( pipeline );

            // Group filter pushdown applies on studyGroup
            expect( optimized[0].$match.studyGroup ).toBe( 'Treatment-A' );

            const originalResults = runMockPipeline( patientDataset, pipeline );
            const optimizedResults = runMockPipeline( patientDataset, optimized );

            expect( optimizedResults ).toEqual( originalResults );
            expect( optimizedResults ).toEqual(
                [
                    {
                        _id: 'Treatment-A',
                        patientCount: 2,
                        avgAge: 60,
                        maxBp: 142
                    }
                ]
            );
        });
    });

    // -------------------------------------------------------------------------
    // 13. Customer Age Demographic Bucketing & Range Allocation (Bucket Pushdown)
    // -------------------------------------------------------------------------
    describe( 'Customer Age Demographic Bucketing & Range Allocation', () =>
    {
        const customerDataset =
        [
            { _id: 1, name: 'Emma', age: 16, spend: 50 },
            { _id: 2, name: 'Liam', age: 24, spend: 320 },
            { _id: 3, name: 'Olivia', age: 29, spend: 410 },
            { _id: 4, name: 'Noah', age: 45, spend: 600 },
            { _id: 5, name: 'Ava', age: 72, spend: 150 }
        ];

        it( 'pushes age range prefilter before $bucket allocation and verifies mock parity', () =>
        {
            const pipeline =
            [
                {
                    $bucket: {
                        groupBy: '$age',
                        boundaries: [ 0, 18, 35, 65, 100 ],
                        default: 'other',
                        output: {
                            count: { $sum: 1 },
                            totalSpend: { $sum: '$spend' }
                        }
                    }
                },
                { $match: { _id: 18 } }
            ];

            const optimized = optimizePipeline( pipeline );

            // Verifies prefilter was pushed down
            expect( optimized[0].$match.age ).toEqual({ $gte: 18, $lt: 35 });

            const rawResult = runMockPipeline( customerDataset, pipeline );
            const optimizedResult = runMockPipeline( customerDataset, optimized );

            expect( rawResult ).toEqual( optimizedResult );
            expect( optimizedResult ).toEqual(
            [
                {
                    _id: 18,
                    count: 2,
                    totalSpend: 730
                }
            ]);
        });
    });

    // -------------------------------------------------------------------------
    // 14. Content Publishing Tag Analytics (SortByCount Simplification)
    // -------------------------------------------------------------------------
    describe( 'Content Publishing Tag Analytics', () =>
    {
        const articleDataset =
        [
            { _id: 1, title: 'AI Revolution', topic: 'technology', views: 1200 },
            { _id: 2, title: 'Stock Market Surge', topic: 'finance', views: 800 },
            { _id: 3, title: 'Quantum Breakthrough', topic: 'technology', views: 2400 },
            { _id: 4, title: 'Global Inflation Update', topic: 'finance', views: 1500 },
            { _id: 5, title: 'Tech Giants Earnings', topic: 'technology', views: 3000 },
            { _id: 6, title: 'Champions League Final', topic: 'sports', views: 4000 }
        ];

        it( 'folds grouping and descending count sort into native $sortByCount', () =>
        {
            const pipeline =
            [
                { $match: { views: { $gte: 1000 } } },
                { $group: { _id: '$topic', count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ];

            const optimized = optimizePipeline( pipeline );

            // Verifies $sortByCount folding
            expect( optimized[1].$sortByCount ).toBe( '$topic' );

            const rawResult = runMockPipeline( articleDataset, pipeline );
            const optimizedResult = runMockPipeline( articleDataset, optimized );

            expect( rawResult ).toEqual( optimizedResult );
            expect( optimizedResult ).toEqual(
            [
                { _id: 'technology', count: 3 },
                { _id: 'finance', count: 1 },
                { _id: 'sports', count: 1 }
            ]);
        });
    });

    // -------------------------------------------------------------------------
    // 15. Financial Audit Log Event Sorting (Redundant Sort Elimination)
    // -------------------------------------------------------------------------
    describe( 'Financial Audit Log Event Sorting', () =>
    {
        const auditDataset =
        [
            { _id: 'log-1', accountId: 'ACC-A', action: 'DEPOSIT', amount: 500, timestamp: 100 },
            { _id: 'log-2', accountId: 'ACC-B', action: 'TRANSFER', amount: 200, timestamp: 200 },
            { _id: 'log-3', accountId: 'ACC-A', action: 'WITHDRAW', amount: 150, timestamp: 300 },
            { _id: 'log-4', accountId: 'ACC-B', action: 'DEPOSIT', amount: 700, timestamp: 400 }
        ];

        it( 'eliminates adjacent sort overwrites and pre-group dead sorts', () =>
        {
            const pipeline =
            [
                // Dead adjacent sort: overwritten immediately by timestamp sort
                { $sort: { amount: 1 } },
                // Dead pre-group sort: overwritten because group has only commutative $sum
                { $sort: { timestamp: -1 } },
                {
                    $group: {
                        _id: '$accountId',
                        totalAmount: { $sum: '$amount' }
                    }
                },
                // Retained post-group sort
                { $sort: { _id: 1 } }
            ];

            const optimized = optimizePipeline( pipeline );

            // The two leading sorts are eliminated
            expect( optimized ).toEqual(
            [
                {
                    $group: {
                        _id: '$accountId',
                        totalAmount: { $sum: '$amount' }
                    }
                },
                { $sort: { _id: 1 } }
            ]);

            const rawResult = runMockPipeline( auditDataset, pipeline );
            const optimizedResult = runMockPipeline( auditDataset, optimized );

            expect( rawResult ).toEqual( optimizedResult );
            expect( optimizedResult ).toEqual(
            [
                { _id: 'ACC-A', totalAmount: 650 },
                { _id: 'ACC-B', totalAmount: 900 }
            ]);
        });
    });

    // -------------------------------------------------------------------------
    // 11. Covered-Index Synthesis & High-Throughput Aggregation
    // -------------------------------------------------------------------------
    describe( 'Covered-Index Synthesis & High-Throughput Aggregation', () =>
    {
        const telemetryDataset =
        [
            {
                _id: 'tel-1',
                deviceId: 'dev-alpha',
                sensor: 'temperature',
                reading: 72.4,
                rawPayload: '0xDEADBEEFCAFE',
                batteryLevel: 98,
                location: { lat: 37.77, lon: -122.41 },
                firmware: 'v2.1.0'
            },
            {
                _id: 'tel-2',
                deviceId: 'dev-alpha',
                sensor: 'temperature',
                reading: 73.1,
                rawPayload: '0xDEADBEEFBABE',
                batteryLevel: 97,
                location: { lat: 37.77, lon: -122.41 },
                firmware: 'v2.1.0'
            },
            {
                _id: 'tel-3',
                deviceId: 'dev-beta',
                sensor: 'humidity',
                reading: 45.0,
                rawPayload: '0xDEADBEEFFEED',
                batteryLevel: 82,
                location: { lat: 40.71, lon: -74.00 },
                firmware: 'v1.8.4'
            },
            {
                _id: 'tel-4',
                deviceId: 'dev-beta',
                sensor: 'temperature',
                reading: 68.9,
                rawPayload: '0xDEADBEEFF00D',
                batteryLevel: 81,
                location: { lat: 40.71, lon: -74.00 },
                firmware: 'v1.8.4'
            }
        ];

        it( 'synthesizes minimal leading projection stripping _id and unread payload for covered query execution', () =>
        {
            const pipeline =
            [
                { $match: { sensor: 'temperature' } },
                { $sort: { reading: -1 } },
                {
                    $group: {
                        _id: '$deviceId',
                        maxReading: { $max: '$reading' }
                    }
                }
            ];

            const optimized = optimizePipelineWithCandidateProfile(
                pipeline,
                [ 'covered-projection-synthesis' ]
            );

            // Synthesized projection sits right after $match and before $sort
            expect( optimized ).toEqual(
            [
                { $match: { sensor: 'temperature' } },
                {
                    $project: {
                        _id: 0,
                        deviceId: 1,
                        reading: 1
                    }
                },
                { $sort: { reading: -1 } },
                {
                    $group: {
                        _id: '$deviceId',
                        maxReading: { $max: '$reading' }
                    }
                }
            ]);

            const rawResult = runMockPipeline( telemetryDataset, pipeline );
            const optimizedResult = runMockPipeline( telemetryDataset, optimized );

            expect( optimizedResult ).toEqual( rawResult );
            expect( optimizedResult ).toEqual(
            [
                { _id: 'dev-alpha', maxReading: 73.1 },
                { _id: 'dev-beta', maxReading: 68.9 }
            ]);
        });
    });
});
