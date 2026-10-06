import { describe, expect, it } from 'vitest';
import { optimizePipeline } from './helpers/pre-gate-optimizer.js';
import {
    optimizePipelineWithCandidateProfile,
} from '../src/passes/registry.js';
import { StagePriorityReorderPass } from '../src/passes/stage-priority-reorder.js';
import {
    type PipelineSemanticCase,
    productionSemanticCases,
} from './fixtures/semantic-cases.js';

const MATCH_PUSHDOWN = ['match-pushdown'] as const;
const LIMIT_ADVANCE = ['limit-advance'] as const;
const STAGE_PRIORITY = ['stage-priority-reorder'] as const;

function optimizeMatches(pipeline: any[]): any[]
{
    return optimizePipelineWithCandidateProfile(
        pipeline,
        MATCH_PUSHDOWN,
        [],
    );
}

function optimizeLimits(pipeline: any[]): any[]
{
    return optimizePipelineWithCandidateProfile(
        pipeline,
        LIMIT_ADVANCE,
        [],
    );
}

function optimizePriority(pipeline: any[]): any[]
{
    return optimizePipelineWithCandidateProfile(
        pipeline,
        STAGE_PRIORITY,
        [],
    );
}

describe('match pushdown proofs', () =>
{
    it('moves a direct-field match through visible projections and a sort', () =>
    {
        const pipeline = [
            { $project: { _id: 0, name: 1, score: 1 } },
            { $sort: { score: -1 } },
            { $match: { name: 'Ada' } },
        ];

        expect(optimizeMatches(pipeline)).toEqual([
            { $match: { name: 'Ada' } },
            { $project: { _id: 0, name: 1, score: 1 } },
            { $sort: { score: -1 } },
        ]);
    });

    it('moves through only path-disjoint unset and add-field writes', () =>
    {
        expect(optimizeMatches([
            { $unset: 'secret' },
            { $match: { status: 'active' } },
        ])).toEqual([
            { $match: { status: 'active' } },
            { $unset: 'secret' },
        ]);

        expect(optimizeMatches([
            { $addFields: { label: 'constant' } },
            { $match: { status: 'active' } },
        ])).toEqual([
            { $match: { status: 'active' } },
            { $addFields: { label: 'constant' } },
        ]);

        for (const pipeline of [
            [
                { $unset: 'profile.name' },
                { $match: { profile: { $exists: true } } },
            ],
            [
                { $set: { profile: { name: 'Ada' } } },
                { $match: { 'profile.name': 'Ada' } },
            ],
        ])
        {
            expect(optimizeMatches(pipeline)).toEqual(pipeline);
        }
    });

    it('rewrites direct aliases in query keys and expression references', () =>
    {
        const pipeline = [
            {
                $project: {
                    _id: 0,
                    renamed: '$source',
                },
            },
            {
                $match: {
                    renamed: { $gt: 1 },
                    $expr: {
                        $and: [
                            { $eq: ['$renamed', '$$ROOT.renamed'] },
                            { $eq: ['$$CURRENT.renamed', 2] },
                        ],
                    },
                },
            },
        ];

        expect(optimizeMatches(pipeline)).toEqual([
            {
                $match: {
                    source: { $gt: 1 },
                    $expr: {
                        $and: [
                            { $eq: ['$source', '$$ROOT.source'] },
                            { $eq: ['$$CURRENT.source', 2] },
                        ],
                    },
                },
            },
            {
                $project: {
                    _id: 0,
                    renamed: '$source',
                },
            },
        ]);
    });

    it('rewrites add-field aliases without changing mixed conjunctions', () =>
    {
        const pipeline = [
            {
                $addFields: {
                    renamed: '$source',
                },
            },
            {
                $match: {
                    renamed: 1,
                    $and: [
                        { renamed: { $gt: 0 } },
                        { status: 'active' },
                    ],
                },
            },
        ];

        expect(optimizeMatches(pipeline)).toEqual([
            {
                $match: {
                    source: 1,
                    $and: [
                        { source: { $gt: 0 } },
                        { status: 'active' },
                    ],
                },
            },
            {
                $addFields: {
                    renamed: '$source',
                },
            },
        ]);
    });

    it('keeps elemMatch keys element-relative while rewriting its root alias', () =>
    {
        const pipeline = [
            {
                $project: {
                    _id: 0,
                    renamedItems: '$items',
                    status: '$rootStatus',
                },
            },
            {
                $match: {
                    renamedItems: {
                        $elemMatch: {
                            status: 'active',
                            score: { $gt: 5 },
                        },
                    },
                },
            },
        ];

        expect(optimizeMatches(pipeline)).toEqual([
            {
                $match: {
                    items: {
                        $elemMatch: {
                            status: 'active',
                            score: { $gt: 5 },
                        },
                    },
                },
            },
            {
                $project: {
                    _id: 0,
                    renamedItems: '$items',
                    status: '$rootStatus',
                },
            },
        ]);
    });

    it('requires every project dependency to remain definitely visible', () =>
    {
        const barriers = [
            [
                { $project: { _id: 0, 'profile.name': 1 } },
                { $match: { profile: { $exists: true } } },
            ],
            [
                { $project: { _id: 0, visible: 1 } },
                { $match: { omitted: { $exists: false } } },
            ],
            [
                { $project: { _id: 0, score: { $add: ['$rawScore', 1] } } },
                { $match: { score: { $gt: 10 } } },
            ],
        ];

        for (const pipeline of barriers)
        {
            expect(optimizeMatches(pipeline)).toEqual(pipeline);
        }

        expect(optimizeMatches([
            { $project: { _id: 0, profile: 1 } },
            { $match: { 'profile.name': 'Ada' } },
        ])).toEqual([
            { $match: { 'profile.name': 'Ada' } },
            { $project: { _id: 0, profile: 1 } },
        ]);
    });

    it('rejects colliding, dynamic, unknown, and partial alias rewrites', () =>
    {
        const barriers = [
            [
                { $project: { _id: 0, alias: '$source', source: 1 } },
                { $match: { alias: 1, source: 2 } },
            ],
            [
                { $project: { _id: 0, alias: '$source', source: 1 } },
                {
                    $match: {
                        $and: [
                            { alias: 1, source: 2 },
                        ],
                    },
                },
            ],
            [
                { $project: { _id: 0, alias: '$source' } },
                {
                    $match: {
                        $expr: {
                            $eq: [
                                '$alias',
                                {
                                    $getField: {
                                        field: '$dynamicField',
                                        input: '$$CURRENT',
                                    },
                                },
                            ],
                        },
                    },
                },
            ],
            [
                { $project: { _id: 0, alias: '$source' } },
                { $match: { $expr: { $eq: ['$alias', '$$unknown.value'] } } },
            ],
            [
                { $project: { _id: 0, alias: '$source' } },
                { $match: { $expr: { $unknownOperator: '$alias' } } },
            ],
            [
                {
                    $project: {
                        _id: 0,
                        alias: '$source',
                        computed: { $add: ['$source', 1] },
                    },
                },
                { $match: { alias: 1, computed: 2 } },
            ],
        ];

        for (const pipeline of barriers)
        {
            expect(optimizeMatches(pipeline)).toEqual(pipeline);
        }
    });

    it('treats malformed, colliding, unknown, and whole-document forms as barriers', () =>
    {
        const barriers = [
            [
                { $futureStage: { value: '$status' } },
                { $match: { status: 'active' } },
            ],
            [
                { $project: { profile: 1, 'profile.name': 1 } },
                { $match: { 'profile.name': 'Ada' } },
            ],
            [
                { $project: { _id: 0, name: 1 } },
                { $match: { $expr: { $eq: ['$$ROOT', { name: 'Ada' }] } } },
            ],
            [
                { $project: { _id: 0, name: 1 } },
                { $match: { $jsonSchema: { required: ['name'] } } },
            ],
            [
                { $sort: { score: -1 } },
                { $match: null },
            ],
        ];

        for (const pipeline of barriers)
        {
            expect(optimizeMatches(pipeline)).toEqual(pipeline);
        }
    });

    it('does not change evaluation count for volatile or malformed forms', () =>
    {
        const barriers = [
            [
                { $addFields: { probe: { $rand: {} } } },
                { $match: { status: 'active' } },
            ],
            [
                { $sort: { score: -1 } },
                { $match: { $expr: { $gt: [{ $rand: {} }, 0.5] } } },
            ],
        ];

        for (const pipeline of barriers)
        {
            expect(optimizeMatches(pipeline)).toEqual(pipeline);
        }
    });

    it('pushes matches before stages with potentially erroring expressions under relaxed error safety', () =>
    {
        expect(optimizeMatches([
            { $addFields: { probe: { $divide: [1, '$zero'] } } },
            { $match: { status: 'active' } },
        ])).toEqual([
            { $match: { status: 'active' } },
            { $addFields: { probe: { $divide: [1, '$zero'] } } },
        ]);

        expect(optimizeMatches([
            { $addFields: { probe: { $add: ['$untyped', 1] } } },
            { $match: { status: 'active' } },
        ])).toEqual([
            { $match: { status: 'active' } },
            { $addFields: { probe: { $add: ['$untyped', 1] } } },
        ]);

        expect(optimizeMatches([
            { $sort: { score: -1 } },
            { $match: { $expr: { $gt: [{ $divide: [1, '$zero'] }, 0] } } },
        ])).toEqual([
            { $match: { $expr: { $gt: [{ $divide: [1, '$zero'] }, 0] } } },
            { $sort: { score: -1 } },
        ]);

        expect(optimizeMatches([
            { $sort: { score: -1 } },
            { $match: { $expr: { $add: ['$untyped', 1] } } },
        ])).toEqual([
            { $match: { $expr: { $add: ['$untyped', 1] } } },
            { $sort: { score: -1 } },
        ]);

        expect(optimizeMatches([
            { $sort: { score: -1 } },
            { $match: { $expr: { $eq: ['$missingSecondOperand'] } } },
        ])).toEqual([
            { $match: { $expr: { $eq: ['$missingSecondOperand'] } } },
            { $sort: { score: -1 } },
        ]);
    });

    it( 'blocks moving matches across error-prone stages when strictErrors is enabled', () =>
    {
        const pipeline = [
            { $addFields: { parsed: { $toInt: '$x' } } },
            { $match: { status: 'active' } }
        ];

        expect( optimizePipelineWithCandidateProfile( pipeline, MATCH_PUSHDOWN, [], { strictErrors: true } ) ).toEqual( pipeline );
    });

    it('never crosses cardinality, order, child, or provenance barriers', () =>
    {
        const precedingStages = [
            { $limit: 2 },
            { $skip: 1 },
            { $sample: { size: 1 } },
            { $unwind: '$status' },
            { $group: { _id: '$status' } },
            { $count: 'total' },
            {
                $lookup: {
                    from: 'orders',
                    localField: '_id',
                    foreignField: 'customerId',
                    as: 'orders',
                },
            },
            {
                $facet: {
                    selected: [{ $match: { status: 'active' } }],
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [{ $match: { archived: false } }],
                },
            },
        ];

        for (const precedingStage of precedingStages)
        {
            const pipeline = [
                precedingStage,
                { $match: { status: 'active' } },
            ];
            expect(optimizeMatches(pipeline)).toEqual(pipeline);
        }
    });

    it('never duplicates null or missing-sensitive predicates around unwind', () =>
    {
        for (const condition of [
            { items: null },
            { items: { $exists: false } },
            { 'items.status': 'active' },
        ])
        {
            const pipeline = [
                {
                    $unwind: {
                        path: '$items',
                        preserveNullAndEmptyArrays: true,
                    },
                },
                { $match: condition },
            ];

            expect(optimizeMatches(pipeline)).toEqual(pipeline);
        }
    });

    it('pushes disjoint matches before $unwind and continues through preceding sort', () =>
    {
        const pipeline = [
            { $sort: { createdAt: -1 } },
            { $unwind: '$items' },
            { $match: { status: 'active' } },
        ];
        expect(optimizeMatches(pipeline)).toEqual([
            { $match: { status: 'active' } },
            { $sort: { createdAt: -1 } },
            { $unwind: '$items' },
        ]);
    });

    it('splits mixed match across $unwind into pushable and residual match stages', () =>
    {
        const pipeline = [
            { $unwind: '$items' },
            { $match: { status: 'active', 'items.qty': { $gt: 5 } } },
        ];
        expect(optimizeMatches(pipeline)).toEqual([
            { $match: { status: 'active' } },
            { $unwind: '$items' },
            { $match: { 'items.qty': { $gt: 5 } } },
        ]);
    });

    it('splits mixed match with colliding pushable conjuncts into $and', () =>
    {
        const pipeline = [
            { $unwind: '$items' },
            {
                $match: {
                    $and: [
                        { status: 'active' },
                        { status: { $ne: 'deleted' } },
                    ],
                    'items.qty': { $gt: 5 },
                },
            },
        ];
        expect(optimizeMatches(pipeline)).toEqual([
            {
                $match: {
                    $and: [
                        { status: 'active' },
                        { status: { $ne: 'deleted' } },
                    ],
                },
            },
            { $unwind: '$items' },
            { $match: { 'items.qty': { $gt: 5 } } },
        ]);
    });

    it('treats unwind indexField as barrier for match conditions on index', () =>
    {
        const pipeline = [
            { $unwind: { path: '$items', includeArrayIndex: 'itemIndex' } },
            { $match: { itemIndex: { $gt: 0 } } },
        ];
        expect(optimizeMatches(pipeline)).toEqual(pipeline);
    });

    it('splits mixed match with multiple non-colliding pushable conjuncts', () =>
    {
        const pipeline = [
            { $unwind: '$items' },
            { $match: { status: 'active', category: 'electronics', 'items.qty': { $gt: 5 } } },
        ];
        expect(optimizeMatches(pipeline)).toEqual([
            { $match: { status: 'active', category: 'electronics' } },
            { $unwind: '$items' },
            { $match: { 'items.qty': { $gt: 5 } } },
        ]);
    });

    it('handles $and branches with empty object when splitting across unwind', () =>
    {
        const pipeline = [
            { $unwind: '$items' },
            {
                $match: {
                    $and: [
                        {},
                        { status: 'active' },
                    ],
                    'items.qty': { $gt: 5 },
                },
            },
        ];
        expect(optimizeMatches(pipeline)).toEqual([
            {
                $match: {
                    status: 'active',
                },
            },
            { $unwind: '$items' },
            { $match: { 'items.qty': { $gt: 5 } } },
        ]);
    });

    it('leaves mixed match untouched when $and branch is not a plain object', () =>
    {
        const pipeline = [
            { $unwind: '$items' },
            {
                $match: {
                    $and: [
                        'invalid-branch',
                        { status: 'active' },
                    ],
                    'items.qty': { $gt: 5 },
                },
            },
        ];
        expect(optimizeMatches(pipeline)).toEqual(pipeline);
    });
});

describe('limit and skip advancement proofs', () =>
{
    it('advances limit and skip across deterministic passive stages', () =>
    {
        for (const terminalStage of [
            { $limit: 2 },
            { $skip: 2 },
        ])
        {
            const pipeline = [
                { $project: { _id: 0, score: 1 } },
                { $addFields: { label: 'stable' } },
                { $set: { copy: '$score' } },
                { $unset: 'secret' },
                terminalStage,
            ];

            expect(optimizeLimits(pipeline)).toEqual([
                terminalStage,
                { $project: { _id: 0, score: 1 } },
                { $addFields: { label: 'stable' } },
                { $set: { copy: '$score' } },
                { $unset: 'secret' },
            ]);
        }
    });

    it('blocks volatile, malformed, whole-document, and colliding passive stages', () =>
    {
        const precedingStages = [
            { $addFields: { probe: { $rand: {} } } },
            { $project: { snapshot: '$$ROOT' } },
            { $project: { profile: 1, 'profile.name': 1 } },
        ];

        for (const precedingStage of precedingStages)
        {
            for (const terminalStage of [
                { $limit: 1 },
                { $skip: 1 },
            ])
            {
                const pipeline = [precedingStage, terminalStage];
                expect(optimizeLimits(pipeline)).toEqual(pipeline);
            }
        }
    });

    it('advances limits and skips across passive stages with potentially erroring expressions', () =>
    {
        const precedingStages = [
            { $project: { probe: { $divide: [1, '$zero'] } } },
            { $set: { probe: { $add: ['$untyped', 1] } } },
            { $project: { probe: { $eq: ['$missingSecondOperand'] } } },
        ];

        for (const precedingStage of precedingStages)
        {
            for (const terminalStage of [
                { $limit: 1 },
                { $skip: 1 },
            ])
            {
                expect(optimizeLimits([precedingStage, terminalStage])).toEqual([
                    terminalStage,
                    precedingStage,
                ]);
            }
        }
    });

    it('never advances across active, order, cardinality, child, or provenance stages', () =>
    {
        const precedingStages = [
            { $sort: { score: -1 } },
            { $match: { active: true } },
            { $sample: { size: 1 } },
            { $unwind: '$items' },
            { $group: { _id: '$status' } },
            { $count: 'total' },
            {
                $lookup: {
                    from: 'orders',
                    localField: '_id',
                    foreignField: 'customerId',
                    as: 'orders',
                },
            },
            {
                $facet: {
                    selected: [{ $match: { active: true } }],
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [{ $match: { archived: false } }],
                },
            },
            { $futureStage: { stable: true } },
        ];

        for (const precedingStage of precedingStages)
        {
            for (const terminalStage of [
                { $limit: 1 },
                { $skip: 1 },
            ])
            {
                const pipeline = [precedingStage, terminalStage];
                expect(optimizeLimits(pipeline)).toEqual(pipeline);
            }
        }
    });
});

describe('movement containment and scheduling', () =>
{
    it('keeps unsafe generic-priority leak cases fixed in place', () =>
    {
        const barriers = [
            [
                { $addFields: { transient: '$source' } },
                { $unset: 'transient' },
            ],
            [
                { $addFields: { transient: '$source' } },
                { $project: { _id: 0, source: 1 } },
            ],
            [
                { $addFields: { transient: '$source' } },
                { $count: 'total' },
            ],
            [
                {
                    $lookup: {
                        from: 'orders',
                        localField: '_id',
                        foreignField: 'customerId',
                        as: 'orders',
                    },
                },
                { $project: { _id: 0, name: 1 } },
            ],
        ];

        for (const pipeline of barriers)
        {
            expect(optimizePriority(pipeline)).toEqual(pipeline);
        }
    });

    it('performs at most one priority swap per pass execution', () =>
    {
        const pipeline = [
            { $project: { _id: 0, name: 1, score: 1 } },
            { $sort: { score: -1 } },
            { $match: { name: 'Ada' } },
        ];
        const pass = new StagePriorityReorderPass();

        expect(pass.execute(pipeline)).toEqual([
            { $project: { _id: 0, name: 1, score: 1 } },
            { $match: { name: 'Ada' } },
            { $sort: { score: -1 } },
        ]);
        expect(optimizePriority(pipeline)).toEqual([
            { $match: { name: 'Ada' } },
            { $project: { _id: 0, name: 1, score: 1 } },
            { $sort: { score: -1 } },
        ]);
    });

    it('applies the same safe proofs inside supported child pipelines', () =>
    {
        const pipeline = [
            {
                $facet: {
                    selected: [
                        { $project: { _id: 0, status: 1 } },
                        { $match: { status: 'active' } },
                    ],
                    barrier: [
                        { $limit: 1 },
                        { $match: { status: 'active' } },
                    ],
                },
            },
            {
                $lookup: {
                    from: 'orders',
                    pipeline: [
                        { $unset: 'secret' },
                        { $match: { paid: true } },
                    ],
                    as: 'orders',
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        { $addFields: { stable: true } },
                        { $limit: 2 },
                    ],
                },
            },
        ];

        expect(optimizePipelineWithCandidateProfile(
            pipeline,
            ['match-pushdown', 'limit-advance'],
            [],
        )).toEqual([
            {
                $facet: {
                    selected: [
                        { $match: { status: 'active' } },
                        { $project: { _id: 0, status: 1 } },
                    ],
                    barrier: [
                        { $limit: 1 },
                        { $match: { status: 'active' } },
                    ],
                },
            },
            {
                $lookup: {
                    from: 'orders',
                    pipeline: [
                        { $match: { paid: true } },
                        { $unset: 'secret' },
                    ],
                    as: 'orders',
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        { $limit: 2 },
                        { $addFields: { stable: true } },
                    ],
                },
            },
        ]);
    });

    it('does not mutate input and reaches a one-call fixed point', () =>
    {
        const pipeline = [
            { $project: { _id: 0, name: 1, score: 1 } },
            { $sort: { score: -1 } },
            { $match: { name: 'Ada' } },
            { $set: { stable: true } },
            { $limit: 2 },
        ];
        const snapshot = structuredClone(pipeline);

        const once = optimizePipelineWithCandidateProfile(
            pipeline,
            ['match-pushdown', 'limit-advance'],
            [],
        );
        const twice = optimizePipelineWithCandidateProfile(
            once,
            ['match-pushdown', 'limit-advance'],
            [],
        );

        expect(pipeline).toEqual(snapshot);
        expect(once).not.toBe(pipeline);
        expect(twice).toEqual(once);
    });

    it('enables only proven movement passes in production', () =>
    {
        expect(optimizePipeline([
            { $project: { _id: 0, name: 1 } },
            { $match: { name: 'Ada' } },
        ])).toEqual([
            { $match: { name: 'Ada' } },
            { $project: { _id: 0, name: 1 } },
        ]);

        expect(optimizePipeline([
            { $set: { stable: true } },
            { $limit: 1 },
        ])).toEqual([
            { $limit: 1 },
            { $set: { stable: true } },
        ]);

        const lookupThenLimit = [
            {
                $lookup: {
                    from: 'orders',
                    localField: '_id',
                    foreignField: 'customerId',
                    as: 'orders',
                },
            },
            { $limit: 1 },
        ];
        expect(optimizePipeline(lookupThenLimit)).toEqual([
            { $limit: 1 },
            lookupThenLimit[0],
        ]);

        const sortThenProject = [
            { $sort: { score: -1 } },
            { $project: { _id: 0, score: 1 } },
        ];
        expect(optimizePipeline(sortThenProject)).toEqual([
            { $project: { _id: 0, score: 1 } },
            { $sort: { score: -1 } },
        ]);

        const sortKeyDropped = [
            { $sort: { score: -1 } },
            { $project: { _id: 0, name: 1 } },
        ];
        expect(optimizePipeline(sortKeyDropped)).toEqual(sortKeyDropped);

        const unwindThenLimit = [
            { $unwind: '$items' },
            { $limit: 1 },
        ];
        expect(optimizePipeline(unwindThenLimit)).toEqual(unwindThenLimit);
    });

    it('optimizes U9 expression type-error fixtures under relaxed error safety', () =>
    {
        const fixtures = productionSemanticCases.filter((testCase): testCase is PipelineSemanticCase =>
            testCase.id.startsWith('u9-expression-add-'),
        );
        expect(fixtures.map((testCase) => testCase.id)).toEqual([
            'u9-expression-add-match-type-error-barrier-top-level',
            'u9-expression-add-skip-type-error-barrier-top-level',
            'u9-expression-add-match-type-error-barrier-nested',
            'u9-expression-add-dead-write-type-error-barrier-nested',
        ]);

        expect(optimizePipeline(fixtures[0]!.pipeline as any[])).toEqual([
            { $match: { status: 'active' } },
            { $set: { computed: { $add: ['$untyped', 1] } } },
        ]);
        expect(optimizePipeline(fixtures[1]!.pipeline as any[])).toEqual([
            { $skip: 1 },
            { $set: { computed: { $add: ['$untyped', 1] } } },
        ]);
        expect(optimizePipeline(fixtures[2]!.pipeline as any[])).toEqual([
            {
                $facet: {
                    selected: [
                        { $match: { status: 'active' } },
                        { $set: { computed: { $add: ['$untyped', 1] } } },
                    ],
                },
            },
        ]);
        expect(optimizePipeline(fixtures[3]!.pipeline as any[])).toEqual(
            fixtures[3]!.pipeline,
        );
    });
});
