import { describe, expect, it } from 'vitest';
import {
    proveFacetDeadBranchPruning,
    proveFacetPrefixHoisting,
    proveUnionWithPushdown,
} from '../src/passes/facet-proofs.js';
import {
    FacetPrefixHoistingPass,
} from '../src/passes/facet-prefix-hoisting.js';
import { optimizePipeline } from './helpers/pre-gate-optimizer.js';
import { runMockPipeline } from './helpers/mock-engine.js';

describe('proveFacetPrefixHoisting', () =>
{
    it('proves hoisting for identical leading $match across 2 branches', () =>
    {
        const facetStage = {
            $facet: {
                a: [{ $match: { org: 'A' } }, { $sort: { y: 1 } }],
                b: [{ $match: { org: 'A' } }, { $limit: 10 }],
            },
        };

        const proof = proveFacetPrefixHoisting(facetStage);
        expect(proof).not.toBeNull();
        expect(proof?.hoistedStages).toEqual([{ $match: { org: 'A' } }]);
        expect(proof?.simplifiedFacet).toEqual({
            $facet: {
                a: [{ $sort: { y: 1 } }],
                b: [{ $limit: 10 }],
            },
        });
    });

    it('proves hoisting for multiple consecutive common leading stages', () =>
    {
        const facetStage = {
            $facet: {
                a: [
                    { $match: { org: 'A' } },
                    { $project: { name: 1, org: 1 } },
                    { $sort: { name: 1 } },
                ],
                b: [
                    { $match: { org: 'A' } },
                    { $project: { name: 1, org: 1 } },
                    { $count: 'total' },
                ],
            },
        };

        const proof = proveFacetPrefixHoisting(facetStage);
        expect(proof).not.toBeNull();
        expect(proof?.hoistedStages).toEqual([
            { $match: { org: 'A' } },
            { $project: { name: 1, org: 1 } },
        ]);
        expect(proof?.simplifiedFacet).toEqual({
            $facet: {
                a: [{ $sort: { name: 1 } }],
                b: [{ $count: 'total' }],
            },
        });
    });

    it('proves hoisting across 3 branches when 100% agree', () =>
    {
        const facetStage = {
            $facet: {
                branch1: [{ $match: { x: 1 } }, { $limit: 5 }],
                branch2: [{ $match: { x: 1 } }, { $skip: 2 }],
                branch3: [{ $match: { x: 1 } }, { $sort: { z: 1 } }],
            },
        };

        const proof = proveFacetPrefixHoisting(facetStage);
        expect(proof).not.toBeNull();
        expect(proof?.hoistedStages).toEqual([{ $match: { x: 1 } }]);
        expect(proof?.simplifiedFacet).toEqual({
            $facet: {
                branch1: [{ $limit: 5 }],
                branch2: [{ $skip: 2 }],
                branch3: [{ $sort: { z: 1 } }],
            },
        });
    });

    it('rejects when there is only partial consensus (2 of 3 branches)', () =>
    {
        const facetStage = {
            $facet: {
                branch1: [{ $match: { x: 1 } }, { $limit: 5 }],
                branch2: [{ $match: { x: 1 } }, { $skip: 2 }],
                branch3: [{ $match: { x: 2 } }, { $sort: { z: 1 } }],
            },
        };

        expect(proveFacetPrefixHoisting(facetStage)).toBeNull();
    });

    it('rejects single-branch facet', () =>
    {
        const facetStage = {
            $facet: {
                only: [{ $match: { x: 1 } }],
            },
        };

        expect(proveFacetPrefixHoisting(facetStage)).toBeNull();
    });

    it('rejects when one branch is empty', () =>
    {
        const facetStage = {
            $facet: {
                branch1: [{ $match: { x: 1 } }],
                branch2: [],
            },
        };

        expect(proveFacetPrefixHoisting(facetStage)).toBeNull();
    });

    it('rejects non-deterministic stages ($rand or $function)', () =>
    {
        const facetStageWithRand = {
            $facet: {
                a: [{ $match: { $expr: { $gt: [{ $rand: {} }, 0.5] } } }],
                b: [{ $match: { $expr: { $gt: [{ $rand: {} }, 0.5] } } }],
            },
        };

        expect(proveFacetPrefixHoisting(facetStageWithRand)).toBeNull();

        const facetStageWithFunction = {
            $facet: {
                a: [{ $match: { $expr: { $function: { body: 'function() { return true; }', args: [], lang: 'js' } } } }],
                b: [{ $match: { $expr: { $function: { body: 'function() { return true; }', args: [], lang: 'js' } } } }],
            },
        };

        expect(proveFacetPrefixHoisting(facetStageWithFunction)).toBeNull();
    });

    it('proves hoisting when one branch is exhausted after the first common stage', () =>
    {
        const facetStage = {
            $facet: {
                short: [{ $match: { active: true } }],
                longer: [{ $match: { active: true } }, { $sort: { createdAt: -1 } }],
            },
        };

        const proof = proveFacetPrefixHoisting(facetStage);
        expect(proof).not.toBeNull();
        expect(proof?.hoistedStages).toEqual([{ $match: { active: true } }]);
        expect(proof?.simplifiedFacet).toEqual({
            $facet: {
                short: [],
                longer: [{ $sort: { createdAt: -1 } }],
            },
        });
    });

    it( 'hoists shared leading $sort, $limit, and $skip stages and rejects non-allowed or non-numeric sort stages', () =>
    {
        const facetStage = {
            $facet: {
                a: [ { $sort: { score: -1 } }, { $skip: 5 }, { $limit: 10 }, { $project: { a: 1 } } ],
                b: [ { $sort: { score: -1 } }, { $skip: 5 }, { $limit: 10 }, { $count: 'total' } ]
            }
        };

        const proof = proveFacetPrefixHoisting( facetStage );
        expect( proof ).not.toBeNull();
        expect( proof?.hoistedStages ).toEqual([
            { $sort: { score: -1 } },
            { $skip: 5 },
            { $limit: 10 }
        ]);
        expect( proof?.simplifiedFacet ).toEqual({
            $facet: {
                a: [ { $project: { a: 1 } } ],
                b: [ { $count: 'total' } ]
            }
        });

        const nonAllowedStage = {
            $facet: {
                a: [ { $group: { _id: '$dept' } }, { $limit: 5 } ],
                b: [ { $group: { _id: '$dept' } }, { $limit: 10 } ]
            }
        };
        expect( proveFacetPrefixHoisting( nonAllowedStage )).toBeNull();

        const nonNumericSortStage = {
            $facet: {
                a: [ { $sort: { score: { $meta: 'textScore' } } }, { $limit: 5 } ],
                b: [ { $sort: { score: { $meta: 'textScore' } } }, { $limit: 10 } ]
            }
        };
        expect( proveFacetPrefixHoisting( nonNumericSortStage )).toBeNull();

        // Hoists shared deterministic $unwind and $lookup stages
        const unwindAndLookupFacet = {
            $facet: {
                a: [
                    { $unwind: '$items' },
                    { $lookup: { from: 'catalog', localField: 'items.sku', foreignField: 'sku', as: 'details' } },
                    { $limit: 5 }
                ],
                b: [
                    { $unwind: '$items' },
                    { $lookup: { from: 'catalog', localField: 'items.sku', foreignField: 'sku', as: 'details' } },
                    { $count: 'total' }
                ]
            }
        };
        const unwindLookupProof = proveFacetPrefixHoisting( unwindAndLookupFacet );
        expect( unwindLookupProof ).not.toBeNull();
        expect( unwindLookupProof?.hoistedStages ).toEqual([
            { $unwind: '$items' },
            { $lookup: { from: 'catalog', localField: 'items.sku', foreignField: 'sku', as: 'details' } }
        ]);

        // Rejects $lookup with volatile subpipeline
        const volatileLookupFacet = {
            $facet: {
                a: [
                    {
                        $lookup: {
                            from: 'catalog',
                            pipeline: [ { $sample: { size: 1 } } ],
                            as: 'details'
                        }
                    },
                    { $limit: 5 }
                ],
                b: [
                    {
                        $lookup: {
                            from: 'catalog',
                            pipeline: [ { $sample: { size: 1 } } ],
                            as: 'details'
                        }
                    },
                    { $count: 'total' }
                ]
            }
        };
        expect( proveFacetPrefixHoisting( volatileLookupFacet )).toBeNull();

        // Hoists shared $count and $sortByCount stages
        const countAndSortByCountFacet = {
            $facet: {
                a: [ { $sortByCount: '$category' }, { $limit: 5 } ],
                b: [ { $sortByCount: '$category' }, { $count: 'numCategories' } ]
            }
        };
        const countSortProof = proveFacetPrefixHoisting( countAndSortByCountFacet );
        expect( countSortProof?.hoistedStages ).toEqual([
            { $sortByCount: '$category' }
        ]);
    });

    it('rejects when leading stage is not a plain object or has multiple keys', () =>
    {
        const nonObject = {
            $facet: {
                a: ['not-a-stage'],
                b: ['not-a-stage'],
            },
        };
        expect(proveFacetPrefixHoisting(nonObject)).toBeNull();

        const multiKey = {
            $facet: {
                a: [{ $match: { x: 1 }, extra: true }],
                b: [{ $match: { x: 1 }, extra: true }],
            },
        };
        expect(proveFacetPrefixHoisting(multiKey)).toBeNull();
    });

    it('handles null prototype and custom class objects', () =>
    {
        const nullProtoStage = Object.create(null);
        nullProtoStage.$match = { x: 1 };

        const facetStage = {
            $facet: {
                a: [nullProtoStage],
                b: [{ $match: { x: 1 } }],
            },
        };

        const proof = proveFacetPrefixHoisting(facetStage);
        expect(proof).not.toBeNull();
        expect(proof?.hoistedStages).toHaveLength(1);

        class CustomClass {}
        expect(proveFacetPrefixHoisting(new CustomClass())).toBeNull();
        expect(proveFacetPrefixHoisting({ $facet: new CustomClass() })).toBeNull();
    });

    it('rejects invalid inputs gracefully', () =>
    {
        expect(proveFacetPrefixHoisting(null)).toBeNull();
        expect(proveFacetPrefixHoisting(undefined)).toBeNull();
        expect(proveFacetPrefixHoisting('not-an-object')).toBeNull();
        expect(proveFacetPrefixHoisting([])).toBeNull();
        expect(proveFacetPrefixHoisting({})).toBeNull();
        expect(proveFacetPrefixHoisting({ $match: { x: 1 } })).toBeNull();
        expect(proveFacetPrefixHoisting({ $facet: null })).toBeNull();
        expect(proveFacetPrefixHoisting({ $facet: 'invalid' })).toBeNull();
        expect(proveFacetPrefixHoisting({ $facet: [] })).toBeNull();
        expect(proveFacetPrefixHoisting({ $facet: { a: 'not-an-array', b: [] } })).toBeNull();
        expect(proveFacetPrefixHoisting({ $facet: { a: [{ $match: { x: 1 } }], b: [{}] } })).toBeNull();
        expect(proveFacetPrefixHoisting({ $facet: {}, extra: 1 })).toBeNull();
    });
});

describe('FacetPrefixHoistingPass', () =>
{
    const pass = new FacetPrefixHoistingPass();

    it('has the expected pass name', () =>
    {
        expect(pass.name).toBe('facet-prefix-hoisting');
    });

    it('splices hoisted stages ahead of $facet in pipeline', () =>
    {
        const pipeline = [
            { $limit: 100 },
            {
                $facet: {
                    metrics: [{ $match: { active: true } }, { $count: 'count' }],
                    items: [{ $match: { active: true } }, { $skip: 10 }, { $limit: 10 }],
                },
            },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual([
            { $limit: 100 },
            { $match: { active: true } },
            {
                $facet: {
                    metrics: [{ $count: 'count' }],
                    items: [{ $skip: 10 }, { $limit: 10 }],
                },
            },
        ]);
    });

    it('leaves pipelines without hoistable facets unchanged', () =>
    {
        const pipeline = [
            { $match: { org: 'A' } },
            {
                $facet: {
                    branchA: [{ $sort: { x: 1 } }],
                    branchB: [{ $limit: 5 }],
                },
            },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual(pipeline);
    });

    it('blocks hoisting error-prone stages under strictErrors', () =>
    {
        const pipeline = [
            {
                $facet: {
                    a: [
                        { $addFields: { quotient: { $divide: ['$a', '$b'] } } },
                        { $limit: 10 },
                    ],
                    b: [
                        { $addFields: { quotient: { $divide: ['$a', '$b'] } } },
                        { $skip: 5 },
                    ],
                },
            },
        ];

        // Allowed in default mode
        expect(pass.execute(pipeline, { strictFieldOrder: false, strictErrors: false })).toEqual([
            { $addFields: { quotient: { $divide: ['$a', '$b'] } } },
            {
                $facet: {
                    a: [{ $limit: 10 }],
                    b: [{ $skip: 5 }],
                },
            },
        ]);

        // Blocked under strictErrors
        expect(pass.execute(pipeline, { strictFieldOrder: false, strictErrors: true })).toEqual(pipeline);
    });

    it('prunes dead $facet branches discarded downstream while keeping at least one branch', () =>
    {
        // Prunes branch b when downstream $project only includes branch a
        expect(pass.execute([
            {
                $facet: {
                    a: [ { $limit: 5 } ],
                    b: [ { $count: 'total' } ],
                },
            },
            { $project: { a: 1 } },
        ])).toEqual([
            {
                $facet: {
                    a: [ { $limit: 5 } ],
                },
            },
            { $project: { a: 1 } },
        ]);

        // Keeps at least one branch when all branches are discarded (e.g. $unset all)
        expect(proveFacetDeadBranchPruning(
            {
                $facet: {
                    a: [ { $limit: 5 } ],
                    b: [ { $count: 'total' } ],
                },
            },
            [ { $unset: [ 'a', 'b' ] } ]
        )).toEqual({
            $facet: {
                b: [ { $count: 'total' } ],
            },
        });

        // Tracks intermediate stage reads before downstream discard
        expect(proveFacetDeadBranchPruning(
            {
                $facet: {
                    a: [ { $limit: 5 } ],
                    b: [ { $limit: 10 } ],
                },
            },
            [
                { $match: { 'b.0.active': true } },
                { $project: { a: 1 } },
            ]
        )).toBeNull();

        expect(proveFacetDeadBranchPruning(
            {
                $facet: {
                    a: [ { $limit: 5 } ],
                    b: [ { $limit: 10 } ],
                    c: [ { $limit: 15 } ],
                },
            },
            [
                { $match: { 'a.0.active': true } },
                { $project: { a: 1, b: 1 } },
            ]
        )).toEqual({
            $facet: {
                a: [ { $limit: 5 } ],
                b: [ { $limit: 10 } ],
            },
        });

        // Rejection cases: invalid input, empty suffix, single branch, strictErrors on throwing branch, non-continuable intermediate
        expect(proveFacetDeadBranchPruning({ $match: {} }, [ { $project: { a: 1 } } ])).toBeNull();
        expect(proveFacetDeadBranchPruning({ $facet: { a: [], b: [] } }, [])).toBeNull();
        expect(proveFacetDeadBranchPruning({ $facet: { a: [] } }, [ { $project: { a: 1 } } ])).toBeNull();
        expect(proveFacetDeadBranchPruning(
            {
                $facet: {
                    a: [ { $addFields: { x: { $divide: [ '$a', 0 ] } } } ],
                    b: [ { $addFields: { y: { $divide: [ '$b', 0 ] } } } ],
                },
            },
            [ { $project: { a: 1 } } ],
            { strictFieldOrder: false, strictErrors: true }
        )).toBeNull();
        expect(proveFacetDeadBranchPruning(
            {
                $facet: {
                    a: [ { $limit: 5 } ],
                    b: [ { $limit: 10 } ],
                },
            },
            [ { $limit: 1 } ]
        )).toBeNull();
        expect(proveFacetDeadBranchPruning(
            {
                $facet: {
                    a: [ { $limit: 5 } ],
                    b: [ { $limit: 10 } ],
                },
            },
            [ { $replaceRoot: { newRoot: '$other' } }, { $project: { a: 1 } } ]
        )).toBeNull();
    });

    it('pushes post-$unionWith $match and head $limit / $skip+$limit into $unionWith subpipeline', () =>
    {
        // Post-$unionWith $match pushdown (both string shorthand and object form)
        expect(pass.execute([
            { $unionWith: 'archivedOrders' },
            { $match: { status: 'completed' } },
        ])).toEqual([
            { $match: { status: 'completed' } },
            {
                $unionWith: {
                    coll: 'archivedOrders',
                    pipeline: [ { $match: { status: 'completed' } } ],
                },
            },
        ]);

        // Head $limit pushdown into $unionWith subpipeline (and tightening larger inner $limit)
        expect(pass.execute([
            { $unionWith: { coll: 'archivedOrders', pipeline: [ { $sort: { ts: -1 } } ] } },
            { $limit: 10 },
        ])).toEqual([
            {
                $unionWith: {
                    coll: 'archivedOrders',
                    pipeline: [ { $sort: { ts: -1 } }, { $limit: 10 } ],
                },
            },
            { $limit: 10 },
        ]);

        expect(proveUnionWithPushdown(
            { $unionWith: { coll: 'archivedOrders', pipeline: [ { $limit: 50 } ] } },
            [ { $skip: 5 }, { $limit: 10 } ]
        )).toEqual({
            updatedUnionStage: {
                $unionWith: {
                    coll: 'archivedOrders',
                    pipeline: [ { $limit: 15 } ],
                },
            },
        });

        // Does not re-push when inner $limit is already <= cap
        expect(proveUnionWithPushdown(
            { $unionWith: { coll: 'archivedOrders', pipeline: [ { $limit: 5 } ] } },
            [ { $limit: 10 } ]
        )).toBeNull();

        // Rejection guards
        expect(proveUnionWithPushdown({ $match: {} }, [ { $limit: 5 } ])).toBeNull();
        expect(proveUnionWithPushdown({ $unionWith: 'c' }, [])).toBeNull();
        expect(proveUnionWithPushdown({ $unionWith: null }, [ { $limit: 5 } ])).toBeNull();
        expect(proveUnionWithPushdown(
            { $unionWith: { coll: 'c', pipeline: [ { $addFields: { x: { $divide: [ '$a', 0 ] } } } ] } },
            [ { $limit: 5 } ],
            { strictFieldOrder: false, strictErrors: true }
        )).toBeNull();
        expect(proveUnionWithPushdown(
            { $unionWith: 'c' },
            [ { $skip: 5 }, { $sort: { a: 1 } } ]
        )).toBeNull();
        expect(proveUnionWithPushdown(
            { $unionWith: 'c' },
            [ null ]
        )).toBeNull();
        expect(proveUnionWithPushdown(
            { $unionWith: 'c' },
            [ { $limit: 5 } ]
        )).toEqual({
            updatedUnionStage: {
                $unionWith: {
                    coll: 'c',
                    pipeline: [ { $limit: 5 } ]
                }
            }
        });
        expect(proveUnionWithPushdown(
            { $unionWith: 'c' },
            [ { $match: { status: 'ok' } } ],
            { strictFieldOrder: false, strictErrors: true }
        )).not.toBeNull();
        expect(proveUnionWithPushdown(
            { $unionWith: 'c' },
            [ { $match: { $expr: { $divide: [ '$a', 0 ] } } } ],
            { strictFieldOrder: false, strictErrors: true }
        )).toBeNull();
        expect(proveUnionWithPushdown(
            { $unionWith: 'c' },
            [ { $match: { $expr: { $rand: {} } } } ]
        )).toBeNull();
    });
});

describe('optimizePipeline execution parity for facet prefix hoisting', () =>
{
    const tenantDataset = [
        { _id: 1, orgId: 'org-1', status: 'active', revenue: 100 },
        { _id: 2, orgId: 'org-1', status: 'pending', revenue: 50 },
        { _id: 3, orgId: 'org-1', status: 'active', revenue: 200 },
        { _id: 4, orgId: 'org-2', status: 'active', revenue: 500 },
        { _id: 5, orgId: 'org-1', status: 'active', revenue: 300 },
    ];

    it('hoists common $match out of $facet and preserves execution parity', () =>
    {
        const pipeline = [
            {
                $facet: {
                    activeCount: [
                        { $match: { orgId: 'org-1' } },
                        { $count: 'count' },
                    ],
                    totalRevenue: [
                        { $match: { orgId: 'org-1' } },
                        { $group: { _id: null, sum: { $sum: '$revenue' } } },
                    ],
                },
            },
        ];

        const optimized = optimizePipeline(pipeline);
        // Common match should be hoisted before $facet
        expect(optimized[0]).toEqual({
            $match: {
                orgId: 'org-1',
            },
        });

        const originalResults = runMockPipeline(tenantDataset, pipeline);
        const optimizedResults = runMockPipeline(tenantDataset, optimized);

        expect(optimizedResults).toEqual(originalResults);
        expect(optimizedResults[0].activeCount).toEqual([{ count: 4 }]);
        expect(optimizedResults[0].totalRevenue).toEqual([{ _id: null, sum: 650 }]);
    });
});
