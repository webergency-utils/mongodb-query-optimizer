import { describe, expect, it } from 'vitest';
import { analyzeStage } from '../src/analyzer/semantics.js';
import { optimizePipeline } from './helpers/pre-gate-optimizer.js';
import {
    proveLookupDelayAcrossStage,
    proveLookupMatchSplit,
    proveLookupSubpipelinePushdown,
} from '../src/passes/movement-proofs.js';
import { LookupDelayPass } from '../src/passes/lookup-delay.js';
import {
    optimizePipelineWithCandidateProfile,
} from '../src/passes/registry.js';
import { runMockPipeline } from './helpers/mock-engine.js';
import {
    candidateSemanticCases,
    productionSemanticCases,
} from './fixtures/semantic-cases.js';

const LOOKUP_DELAY = ['lookup-delay'] as const;
const REDUNDANT_LOOKUP = ['redundant-lookup-elimination'] as const;
const BOTH_LOOKUP_PASSES = [
    'lookup-delay',
    'redundant-lookup-elimination',
] as const;

function makeLookup(
    overrides: Record<string, unknown> = {},
): any
{
    return {
        $lookup: {
            from: 'orders',
            localField: 'customerId',
            foreignField: 'customerId',
            as: 'orders',
            ...overrides,
        },
    };
}

function optimizeLookups(pipeline: any[]): any[]
{
    return optimizePipelineWithCandidateProfile(
        pipeline,
        LOOKUP_DELAY,
        [],
    );
}

function expectCandidatePassesContained(pipeline: any[]): void
{
    for (const transformationIds of [
        LOOKUP_DELAY,
        REDUNDANT_LOOKUP,
        BOTH_LOOKUP_PASSES,
    ])
    {
        expect(optimizePipelineWithCandidateProfile(
            pipeline,
            transformationIds,
            [],
        )).toEqual(pipeline);
    }
}

describe('redundant lookup elimination', () =>
{
    it('retains lookup, preserving unwind, and alias discard without uniqueness metadata', () =>
    {
        const pipeline = [
            {
                $lookup: {
                    from: 'orders',
                    localField: 'customerId',
                    foreignField: 'customerId',
                    as: 'orders',
                },
            },
            {
                $unwind: {
                    path: '$orders',
                    preserveNullAndEmptyArrays: true,
                },
            },
            { $project: { _id: 0, name: 1 } },
        ];

        expectCandidatePassesContained(pipeline);
    });

    it.each([0, 1, 3])(
        'does not infer lookup uniqueness when unwind may expand %i foreign rows',
        () =>
        {
            const pipeline = [
                makeLookup(),
                {
                    $unwind: {
                        path: '$orders',
                        preserveNullAndEmptyArrays: true,
                    },
                },
                { $project: { _id: 0, name: 1 } },
            ];

            expectCandidatePassesContained(pipeline);
        },
    );

    it('eliminates a simple lookup whose alias is dropped by the next project', () =>
    {
        const pipeline = [
            makeLookup(),
            { $project: { _id: 0, name: 1 } },
        ];

        expect(optimizePipelineWithCandidateProfile(
            pipeline,
            REDUNDANT_LOOKUP,
            [],
        )).toEqual([
            { $project: { _id: 0, name: 1 } },
        ]);
        expect(optimizePipeline(pipeline)).toEqual([
            { $project: { _id: 0, name: 1 } },
        ]);
    });

    it('eliminates a simple lookup whose alias is unset next', () =>
    {
        expect(optimizePipelineWithCandidateProfile(
            [makeLookup(), { $unset: 'orders' }],
            REDUNDANT_LOOKUP,
            [],
        )).toEqual([
            { $unset: 'orders' },
        ]);
    });

    it('retains non-preserving unwind and graph lookup even when aliases disappear', () =>
    {
        const lookupPipeline = [
            makeLookup(),
            { $unwind: '$orders' },
            { $project: { _id: 0, name: 1 } },
        ];
        const graphPipeline = [
            {
                $graphLookup: {
                    from: 'employees',
                    startWith: '$managerId',
                    connectFromField: 'managerId',
                    connectToField: '_id',
                    as: 'reports',
                },
            },
            { $project: { _id: 0, name: 1 } },
        ];

        expectCandidatePassesContained(lookupPipeline);
        expectCandidatePassesContained(graphPipeline);
    });
});

describe('lookup delay proofs', () =>
{
    it('rejects non-simple lookup forms and alias-overlapping followers', () =>
    {
        expect(proveLookupDelayAcrossStage(null, { $sort: { score: -1 } })).toBe(false);
        expect(proveLookupDelayAcrossStage(
            { $lookup: makeLookup().$lookup, $limit: 1 },
            { $sort: { score: -1 } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            { $lookup: 'orders' },
            { $sort: { score: -1 } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            { $lookup: { from: 'orders', localField: 'customerId', as: 'orders' } },
            { $sort: { score: -1 } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            {
                $lookup: {
                    from: '',
                    localField: 'customerId',
                    foreignField: 'customerId',
                    as: 'orders',
                },
            },
            { $sort: { score: -1 } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            {
                $lookup: {
                    from: 'orders',
                    localField: 'customerId',
                    foreignField: '',
                    as: 'orders',
                },
            },
            { $sort: { score: -1 } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            {
                $lookup: {
                    from: 'orders',
                    localField: '',
                    foreignField: 'customerId',
                    as: 'orders',
                },
            },
            { $sort: { score: -1 } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            {
                $lookup: {
                    from: 1,
                    localField: 'customerId',
                    foreignField: 'customerId',
                    as: 'orders',
                },
            },
            { $sort: { score: -1 } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            {
                $lookup: {
                    from: 'orders',
                    localField: 'customerId',
                    foreignField: 1,
                    as: 'orders',
                },
            },
            { $sort: { score: -1 } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            {
                $lookup: {
                    from: 'orders',
                    localField: 'customerId',
                    foreignField: 'customerId',
                    as: '',
                },
            },
            { $sort: { score: -1 } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            makeLookup({ let: { id: '$customerId' } }),
            { $sort: { score: -1 } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            makeLookup(),
            { $sort: { score: 'desc' } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            makeLookup(),
            { $match: { $where: 'return true' } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            makeLookup(),
            { $set: { 'orders.total': 1 } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            makeLookup(),
            { $match: { orders: { $ne: [] } } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            makeLookup(),
            { $addFields: { orders: [] } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            makeLookup(),
            { $unset: 'orders.total' },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            makeLookup(),
            { $group: { _id: '$status' } },
        )).toBe(false);
        expect(proveLookupDelayAcrossStage(
            makeLookup(),
            { $limit: '1' },
        )).toBe(false);
    });

    it('accepts alias-independent match, sort, limit, and skip', () =>
    {
        expect(proveLookupDelayAcrossStage(
            makeLookup(),
            { $match: { status: 'active' } },
        )).toBe(true);
        expect(proveLookupDelayAcrossStage(
            makeLookup(),
            { $sort: { score: -1 } },
        )).toBe(true);
        expect(proveLookupDelayAcrossStage(makeLookup(), { $limit: 2 })).toBe(true);
        expect(proveLookupDelayAcrossStage(makeLookup(), { $skip: 1 })).toBe(true);
    });
});

describe('lookup delay', () =>
{
    it('keeps pipeline-form lookup contained', () =>
    {
        const pipeline = [
            {
                $lookup: {
                    ...makeLookup().$lookup,
                    pipeline: [],
                },
            },
            { $sort: { score: -1 } },
        ];

        expect(optimizePipelineWithCandidateProfile(
            pipeline,
            LOOKUP_DELAY,
            [],
        )).toEqual(pipeline);
    });

    it('keeps malformed and extended lookup forms contained', () =>
    {
        const invalidSpecifications = [
            { from: 'orders', foreignField: 'customerId', as: 'orders' },
            { ...makeLookup().$lookup, from: '' },
            { ...makeLookup().$lookup, localField: '' },
            { ...makeLookup().$lookup, foreignField: '' },
            { ...makeLookup().$lookup, as: '' },
            { ...makeLookup().$lookup, from: 1 },
            { ...makeLookup().$lookup, let: { id: '$customerId' } },
            { ...makeLookup().$lookup, pipeline: [] },
            { ...makeLookup().$lookup, extraOption: true },
        ];

        for (const specification of invalidSpecifications)
        {
            const pipeline = [
                { $lookup: specification },
                { $sort: { score: -1 } },
            ];
            expect(optimizeLookups(pipeline)).toEqual(pipeline);
        }
    });

    it.each([
        ['unset', { $unset: ['temporary', 'metadata.debug'] }],
        ['project', { $project: { customerId: 1, orders: 1 } }],
        ['addFields', { $addFields: { stable: true } }],
        ['set', { $set: { stable: true } }],
        ['unwind', { $unwind: '$items' }],
        ['cardinality', { $group: { _id: '$status' } }],
        ['provenance', { $unionWith: 'archive' }],
        ['nested provenance', {
            $facet: {
                selected: [{ $match: { active: true } }],
            },
        }],
        ['unknown', { $futureStage: { stable: true } }],
    ])('keeps candidate lookup passes no-op across %s', (_name, followingStage) =>
    {
        const pipeline = [
            makeLookup(),
            followingStage,
        ];

        expectCandidatePassesContained(pipeline);
    });

    it.each([
        ['match', { $match: { status: 'active' } }],
        ['sort', { $sort: { score: -1 } }],
        ['limit', { $limit: 2 }],
        ['skip', { $skip: 1 }],
    ])('delays a simple lookup past alias-independent %s', (_name, followingStage) =>
    {
        const pipeline = [
            makeLookup(),
            followingStage,
        ];

        expect(optimizeLookups(pipeline)).toEqual([
            followingStage,
            makeLookup(),
        ]);
    });

    it('delays a lookup past sort and then stops at unset', () =>
    {
        const pipeline = [
            makeLookup(),
            { $sort: { score: -1 } },
            { $unset: 'temporary' },
        ];

        expect(new LookupDelayPass().execute(pipeline)).toEqual([
            { $sort: { score: -1 } },
            makeLookup(),
            { $unset: 'temporary' },
        ]);
        expect(optimizeLookups(pipeline)).toEqual([
            { $sort: { score: -1 } },
            makeLookup(),
            { $unset: 'temporary' },
        ]);
    });

    it('blocks exact, ancestor, descendant, expression, and whole-document alias consumers', () =>
    {
        const barriers = [
            [makeLookup(), { $match: { orders: { $ne: [] } } }],
            [makeLookup(), { $match: { 'orders.total': { $gt: 0 } } }],
            [
                makeLookup({ as: 'orders.items' }),
                { $match: { orders: { $exists: true } } },
            ],
            [
                makeLookup(),
                { $match: { $expr: { $gt: ['$orders.total', 0] } } },
            ],
            [
                makeLookup(),
                { $match: { $expr: { $eq: ['$$ROOT.orders', []] } } },
            ],
            [
                makeLookup(),
                { $match: { $expr: { $eq: ['$$CURRENT.orders', []] } } },
            ],
            [
                makeLookup(),
                {
                    $match: {
                        $expr: {
                            $eq: [{ $getField: 'orders' }, []],
                        },
                    },
                },
            ],
            [
                makeLookup(),
                { $match: { $expr: { $eq: ['$$ROOT', {}] } } },
            ],
            [
                makeLookup(),
                { $match: { $jsonSchema: { required: ['orders'] } } },
            ],
            [makeLookup(), { $sort: { 'orders.total': -1 } }],
        ];

        for (const pipeline of barriers)
        {
            expect(optimizeLookups(pipeline)).toEqual(pipeline);
        }
    });

    it('blocks removal of the alias or any ancestor or descendant join-key path', () =>
    {
        const barriers = [
            [makeLookup(), { $unset: 'orders' }],
            [makeLookup(), { $unset: 'orders.total' }],
            [makeLookup(), { $unset: 'customerId' }],
            [
                makeLookup({ localField: 'customer.id' }),
                { $unset: 'customer' },
            ],
            [makeLookup(), { $unset: 'customerId.value' }],
        ];

        for (const pipeline of barriers)
        {
            expect(optimizeLookups(pipeline)).toEqual(pipeline);
        }
    });

    it('keeps noncanonical and overlapping unset forms contained', () =>
    {
        const barriers = [
            [
                makeLookup(),
                { $unset: ['temporary', 'temporary.child'] },
            ],
            [
                makeLookup(),
                { $unset: '$temporary' },
            ],
        ];

        for (const pipeline of barriers)
        {
            expect(optimizeLookups(pipeline)).toEqual(pipeline);
        }
    });

    it('blocks every field-shape-changing project, add, and set stage', () =>
    {
        const followingStages = [
            { $project: { _id: 0, customerId: 1, orders: 1 } },
            { $project: { secret: 0 } },
            { $project: { copied: '$status' } },
            { $addFields: { stable: true } },
            { $set: { copied: '$status' } },
        ];

        for (const followingStage of followingStages)
        {
            const pipeline = [makeLookup(), followingStage];
            expect(optimizeLookups(pipeline)).toEqual(pipeline);
        }
    });

    it('blocks cardinality, provenance, join, graph, and unknown stages', () =>
    {
        const followingStages = [
            { $unwind: '$items' },
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $facet: { selected: [{ $match: { active: true } }] } },
            { $unionWith: 'archive' },
            {
                $densify: {
                    field: 'sequence',
                    range: { bounds: [0, 10], step: 1 },
                },
            },
            { $sample: { size: 1 } },
            { $count: 'total' },
            makeLookup({ as: 'otherOrders' }),
            {
                $graphLookup: {
                    from: 'employees',
                    startWith: '$managerId',
                    connectFromField: 'managerId',
                    connectToField: '_id',
                    as: 'reports',
                },
            },
            { $futureStage: { stable: true } },
        ];

        for (const followingStage of followingStages)
        {
            const pipeline = [makeLookup(), followingStage];
            expect(optimizeLookups(pipeline)).toEqual(pipeline);
        }
    });

    it('blocks volatile, wildcard, and unsupported match evaluation', () =>
    {
        const followingStages = [
            {
                $match: {
                    $expr: { $gt: [{ $rand: {} }, 0.5] },
                },
            },
            { $match: { $where: 'return true' } },
            { $match: { $unknownPredicate: '$status' } },
        ];

        for (const followingStage of followingStages)
        {
            const pipeline = [makeLookup(), followingStage];
            expect(optimizeLookups(pipeline)).toEqual(pipeline);
        }
    });

    it('delays lookup past match with potentially erroring expression', () =>
    {
        const matchStage = {
            $match: {
                $expr: { $gt: [{ $divide: [1, '$zero'] }, 0] },
            },
        };
        const pipeline = [makeLookup(), matchStage];
        expect(optimizeLookups(pipeline)).toEqual([matchStage, makeLookup()]);
    });

    it('never delays graph lookup or a lookup paired with unwind', () =>
    {
        const graphPipeline = [
            {
                $graphLookup: {
                    from: 'employees',
                    startWith: '$managerId',
                    connectFromField: 'managerId',
                    connectToField: '_id',
                    as: 'reports',
                },
            },
            { $sort: { score: -1 } },
        ];
        const pairedPipeline = [
            makeLookup(),
            {
                $unwind: {
                    path: '$orders',
                    preserveNullAndEmptyArrays: true,
                },
            },
            { $sort: { score: -1 } },
        ];

        expectCandidatePassesContained(graphPipeline);
        expectCandidatePassesContained(pairedPipeline);
    });

    it('does not assume BSON-order safety across disjoint unset', () =>
    {
        const pipeline = [
            makeLookup(),
            { $unset: ['temporary', 'metadata.debug'] },
        ];
        const lookupKeyOrder = Object.keys(pipeline[0].$lookup);

        const optimized = optimizeLookups(pipeline);

        expect(optimized).toEqual(pipeline);
        expect(Object.keys(optimized[0].$lookup)).toEqual(lookupKeyOrder);
    });

    it('delays nested lookups past sort and keeps unset as a barrier', () =>
    {
        const pipeline = [
            {
                $facet: {
                    selected: [
                        makeLookup({ from: 'facetOrders' }),
                        { $sort: { score: -1 } },
                    ],
                },
            },
            {
                $lookup: {
                    from: 'accounts',
                    pipeline: [
                        makeLookup({ from: 'lookupOrders' }),
                        { $unset: 'temporary' },
                    ],
                    as: 'accounts',
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        makeLookup({ from: 'unionOrders' }),
                        { $sort: { score: -1 } },
                    ],
                },
            },
        ];

        expect(optimizeLookups(pipeline)).toEqual([
            {
                $facet: {
                    selected: [
                        { $sort: { score: -1 } },
                        makeLookup({ from: 'facetOrders' }),
                    ],
                },
            },
            {
                $lookup: {
                    from: 'accounts',
                    pipeline: [
                        makeLookup({ from: 'lookupOrders' }),
                        { $unset: 'temporary' },
                    ],
                    as: 'accounts',
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        { $sort: { score: -1 } },
                        makeLookup({ from: 'unionOrders' }),
                    ],
                },
            },
        ]);
    });

    it('converges with adjacent matching without mutating input', () =>
    {
        const pipeline = [
            makeLookup(),
            { $sort: { score: -1 } },
            { $unset: 'temporary' },
            { $match: { active: true } },
            { $match: { region: 'eu' } },
        ];
        const snapshot = structuredClone(pipeline);

        const once = optimizePipelineWithCandidateProfile(
            pipeline,
            ['adjacent-match-merging', 'lookup-delay'],
            ['merge-conjunctions'],
        );
        const twice = optimizePipelineWithCandidateProfile(
            once,
            ['adjacent-match-merging', 'lookup-delay'],
            ['merge-conjunctions'],
        );

        expect(pipeline).toEqual(snapshot);
        expect(once).toEqual([
            { $sort: { score: -1 } },
            makeLookup(),
            { $unset: 'temporary' },
            { $match: { active: true, region: 'eu' } },
        ]);
        expect(twice).toEqual(once);
    });
});

describe('lookup analyzer scope', () =>
{
    it('separates outer local and let dependencies from foreign child fields', () =>
    {
        const summary = analyzeStage({
            $lookup: {
                from: 'orders',
                localField: 'tenantId',
                foreignField: 'tenantId',
                let: {
                    customer: '$customer',
                },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $eq: ['$customerId', '$$customer.id'],
                            },
                        },
                    },
                ],
                as: 'orders',
            },
        });

        expect(summary.dependencies.local).toEqual(new Set([
            'tenantId',
            'customer',
            'customer.id',
        ]));
        expect(summary.dependencies.foreign).toEqual(new Set([
            'tenantId',
            'customerId',
        ]));
        expect(summary.children[0]!.outerDependencies).toEqual(new Set([
            'customer.id',
        ]));
        expect(summary.children[0]!.foreignDependencies).toEqual(new Set([
            'customerId',
        ]));
    });

    it('keeps graph traversal fields foreign and nests depth under the alias', () =>
    {
        const summary = analyzeStage({
            $graphLookup: {
                from: 'employees',
                startWith: '$managerId',
                connectFromField: 'managerId',
                connectToField: '_id',
                restrictSearchWithMatch: { active: true },
                as: 'reports',
                depthField: 'depth',
            },
        });

        expect(summary.dependencies.local).toEqual(new Set(['managerId']));
        expect(summary.dependencies.foreign).toEqual(new Set([
            'managerId',
            '_id',
            'active',
        ]));
        expect(summary.writes).toEqual(new Set([
            'reports',
            'reports.depth',
        ]));
        expect(summary.writes.has('depth')).toBe(false);
    });
});

describe('production lookup profile', () =>
{
    it('delays simple lookups past sort and eliminates only unused aliases', () =>
    {
        const delayed = [
            makeLookup(),
            { $sort: { score: -1 } },
            { $unset: 'temporary' },
        ];
        expect(optimizePipeline(delayed)).toEqual([
            { $sort: { score: -1 } },
            makeLookup(),
            { $unset: 'temporary' },
        ]);
        expect(optimizePipeline([
            makeLookup(),
            { $project: { _id: 0, name: 1 } },
        ])).toEqual([
            { $project: { _id: 0, name: 1 } },
        ]);

        const noElimination = [
            makeLookup(),
            {
                $unwind: {
                    path: '$orders',
                    preserveNullAndEmptyArrays: true,
                },
            },
            { $project: { _id: 0, name: 1 } },
        ];
        expect(optimizePipeline(noElimination)).toEqual(noElimination);

        const graphLookup = [
            {
                $graphLookup: {
                    from: 'employees',
                    startWith: '$managerId',
                    connectFromField: 'managerId',
                    connectToField: '_id',
                    as: 'reports',
                },
            },
            { $sort: { score: -1 } },
        ];
        expect(optimizePipeline(graphLookup)).toEqual(graphLookup);
    });
});

describe('lookup semantic fixtures', () =>
{
    it('classifies U7 fixtures as alias-safe rewrites or remaining barriers', () =>
    {
        const expected = {
            'u7-lookup-delay-sort-unset-resource-barrier': 'rewrite',
            'u7-lookup-delay-match-error-timing-barrier': 'rewrite',
            'u7-lookup-delay-limit-error-timing-barrier': 'rewrite',
            'u7-lookup-delay-skip-error-timing-barrier': 'rewrite',
            'u7-lookup-delay-inclusion-project-barrier': 'barrier',
            'u7-graph-lookup-delay-barrier': 'barrier',
            'u7-lookup-delay-nested-resource-barriers': 'rewrite',
            'u7-lookup-delay-nested-barriers': 'rewrite',
            'u7-redundant-lookup-discarded-project': 'rewrite',
        };
        const fixtures = productionSemanticCases.filter(
            (testCase) => testCase.id.startsWith('u7-'),
        );

        expect(fixtures.map((testCase) => testCase.id)).toEqual(
            Object.keys(expected),
        );
        for (const fixture of fixtures)
        {
            expect(fixture.kind).toBe('pipeline');
            if (fixture.kind !== 'pipeline')
            {
                continue;
            }

            const optimized = optimizePipeline(fixture.pipeline as any[]);
            expect(
                JSON.stringify(optimized) === JSON.stringify(fixture.pipeline)
                    ? 'barrier'
                    : 'rewrite',
            ).toBe(expected[fixture.id as keyof typeof expected]);
        }
    });

    it('keeps the multiplicity candidate fixture unchanged', () =>
    {
        const fixture = candidateSemanticCases.find(
            (testCase) =>
                testCase.id === 'u7-candidate-redundant-lookup-noop-multiplicity',
        );

        expect(fixture?.kind).toBe('pipeline');
        if (!fixture || fixture.kind !== 'pipeline')
        {
            return;
        }

        expect(optimizePipelineWithCandidateProfile(
            fixture.pipeline as any[],
            fixture.candidateTransformationIds ?? [],
            fixture.candidateRuleIds,
        )).toEqual(fixture.pipeline);
    });
});

describe('proveLookupMatchSplit', () =>
{
    it('returns null for non-simple lookup stages', () =>
    {
        expect(proveLookupMatchSplit(null, { $match: { a: 1 } })).toBeNull();
        expect(proveLookupMatchSplit({ $lookup: 'not-object' }, { $match: { a: 1 } })).toBeNull();
        expect(proveLookupMatchSplit({ $other: {} }, { $match: { a: 1 } })).toBeNull();
    });

    it('returns null for non-match or unsafe match followers', () =>
    {
        const lookup = makeLookup();
        expect(proveLookupMatchSplit(lookup, null)).toBeNull();
        expect(proveLookupMatchSplit(lookup, { $sort: { a: 1 } })).toBeNull();
        expect(proveLookupMatchSplit(lookup, { $match: 'invalid' })).toBeNull();
        expect(proveLookupMatchSplit(lookup, { $match: { $where: 'sleep(100)' } })).toBeNull();
    });

    it('returns null when match is already fully disjoint from alias', () =>
    {
        const lookup = makeLookup({ as: 'orders' });
        const match = { $match: { status: 'active', age: { $gt: 20 } } };
        expect(proveLookupMatchSplit(lookup, match)).toBeNull();
    });

    it('returns null when match cannot be split into pushable conjuncts', () =>
    {
        const lookup = makeLookup({ as: 'orders' });
        expect(proveLookupMatchSplit(lookup, { $match: { 'orders.total': { $gt: 100 } } })).toBeNull();
        expect(proveLookupMatchSplit(lookup, {
            $match: {
                'orders.total': { $gt: 100 },
                'orders.status': 'completed',
            },
        })).toBeNull();
    });

    it('splits mixed match into pushable disjoint and residual alias conjuncts', () =>
    {
        const lookup = makeLookup({ as: 'orders' });
        const match = {
            $match: {
                status: 'active',
                'orders.total': { $gt: 100 },
            },
        };

        const proof = proveLookupMatchSplit(lookup, match);
        expect(proof).not.toBeNull();
        expect(proof?.pushableStage).toEqual({
            $match: {
                status: 'active',
            },
        });
        expect(proof?.residualStage).toEqual({
            $match: {
                'orders.total': { $gt: 100 },
            },
        });
    });

    it('combines multiple pushable conjuncts with key collision into $and', () =>
    {
        const lookup = makeLookup({ as: 'orders' });
        const match = {
            $match: {
                $and: [
                    { score: { $gte: 10 } },
                    { score: { $lte: 50 } },
                    { 'orders.status': 'completed' },
                ],
            },
        };

        const proof = proveLookupMatchSplit(lookup, match);
        expect(proof).not.toBeNull();
        expect(proof?.pushableStage).toEqual({
            $match: {
                $and: [
                    { score: { $gte: 10 } },
                    { score: { $lte: 50 } },
                ],
            },
        });
        expect(proof?.residualStage).toEqual({
            $match: {
                'orders.status': 'completed',
            },
        });
    });
});

describe('proveLookupSubpipelinePushdown', () =>
{
    it('returns null on invalid lookup stages', () =>
    {
        expect(proveLookupSubpipelinePushdown(null, { $unwind: '$orders' }, { $match: { 'orders.a': 1 } })).toBeNull();
        expect(proveLookupSubpipelinePushdown({ $lookup: 123 }, { $unwind: '$orders' }, { $match: { 'orders.a': 1 } })).toBeNull();
        expect(proveLookupSubpipelinePushdown({ $lookup: {}, extra: 1 }, { $unwind: '$orders' }, { $match: { 'orders.a': 1 } })).toBeNull();
        expect(proveLookupSubpipelinePushdown({ $lookup: { as: 123, pipeline: [] } }, { $unwind: '$orders' }, { $match: { 'orders.a': 1 } })).toBeNull();
        expect(proveLookupSubpipelinePushdown({ $lookup: { as: '', pipeline: [] } }, { $unwind: '$orders' }, { $match: { 'orders.a': 1 } })).toBeNull();
        expect(proveLookupSubpipelinePushdown({ $lookup: { as: 'orders', pipeline: 'not-array' } }, { $unwind: '$orders' }, { $match: { 'orders.a': 1 } })).toBeNull();
    });

    it('returns null on invalid unwind stages', () =>
    {
        const lookup = { $lookup: { as: 'orders', pipeline: [] } };
        expect(proveLookupSubpipelinePushdown(lookup, null, { $match: { 'orders.a': 1 } })).toBeNull();
        expect(proveLookupSubpipelinePushdown(lookup, { $unwind: 123 }, { $match: { 'orders.a': 1 } })).toBeNull();
        expect(proveLookupSubpipelinePushdown(lookup, { $unwind: 'not-dollar' }, { $match: { 'orders.a': 1 } })).toBeNull();
        expect(proveLookupSubpipelinePushdown(lookup, { $unwind: '$' }, { $match: { 'orders.a': 1 } })).toBeNull();
        expect(proveLookupSubpipelinePushdown(lookup, { $unwind: { path: 'not-dollar' } }, { $match: { 'orders.a': 1 } })).toBeNull();
        expect(proveLookupSubpipelinePushdown(lookup, { $unwind: { path: '$' } }, { $match: { 'orders.a': 1 } })).toBeNull();
        expect(proveLookupSubpipelinePushdown(lookup, { $unwind: { path: '$orders', preserveNullAndEmptyArrays: true } }, { $match: { 'orders.a': 1 } })).toBeNull();
        expect(proveLookupSubpipelinePushdown(lookup, { $unwind: { path: 123 } }, { $match: { 'orders.a': 1 } })).toBeNull();
        expect(proveLookupSubpipelinePushdown(lookup, { $unwind: '$other' }, { $match: { 'orders.a': 1 } })).toBeNull();
        expect(proveLookupSubpipelinePushdown(lookup, { $unwind: '$orders', extra: 1 }, { $match: { 'orders.a': 1 } })).toBeNull();
    });

    it('returns null on invalid match stages', () =>
    {
        const lookup = { $lookup: { as: 'orders', pipeline: [] } };
        const unwind = { $unwind: '$orders' };
        expect(proveLookupSubpipelinePushdown(lookup, unwind, null)).toBeNull();
        expect(proveLookupSubpipelinePushdown(lookup, unwind, { $match: 'not-object' })).toBeNull();
        expect(proveLookupSubpipelinePushdown(lookup, unwind, { $match: { $where: 'sleep(100)' } })).toBeNull();
        expect(proveLookupSubpipelinePushdown(lookup, unwind, { $match: { status: 'active' } })).toBeNull();
    });

    it('pushes filter into subpipeline without residual when all conditions target alias', () =>
    {
        const lookup = {
            $lookup: {
                from: 'orders',
                as: 'orders',
                pipeline: [{ $sort: { date: -1 } }],
            },
        };
        const unwind = { $unwind: { path: '$orders' } };
        const match = {
            $match: {
                'orders.status': 'completed',
                'orders.total': { $gt: 50 },
            },
        };

        const proof = proveLookupSubpipelinePushdown(lookup, unwind, match);
        expect(proof).not.toBeNull();
        expect(proof?.residualStage).toBeUndefined();
        expect(proof?.lookupStage).toEqual({
            $lookup: {
                from: 'orders',
                as: 'orders',
                pipeline: [
                    { $sort: { date: -1 } },
                    {
                        $match: {
                            status: 'completed',
                            total: { $gt: 50 },
                        },
                    },
                ],
            },
        });
    });

    it('pushes subpipeline filter and retains residual for non-alias conditions and includeArrayIndex', () =>
    {
        const lookup = {
            $lookup: {
                from: 'orders',
                as: 'orders',
                pipeline: [],
            },
        };
        const unwind = {
            $unwind: {
                path: '$orders',
                includeArrayIndex: 'orderIdx',
            },
        };
        const match = {
            $match: {
                'orders.status': 'completed',
                customerActive: true,
                orderIdx: 0,
            },
        };

        const proof = proveLookupSubpipelinePushdown(lookup, unwind, match);
        expect(proof).not.toBeNull();
        expect(proof?.lookupStage).toEqual({
            $lookup: {
                from: 'orders',
                as: 'orders',
                pipeline: [
                    { $match: { status: 'completed' } },
                ],
            },
        });
        expect(proof?.residualStage).toEqual({
            $match: {
                customerActive: true,
                orderIdx: 0,
            },
        });
    });

    it('pushes $elemMatch on alias into subpipeline', () =>
    {
        const lookup = {
            $lookup: {
                from: 'orders',
                as: 'orders',
                pipeline: [],
            },
        };
        const unwind = { $unwind: '$orders' };
        const match = {
            $match: {
                orders: { $elemMatch: { status: 'completed', total: { $gt: 50 } } },
            },
        };

        const proof = proveLookupSubpipelinePushdown(lookup, unwind, match);
        expect(proof).not.toBeNull();
        expect(proof?.lookupStage).toEqual({
            $lookup: {
                from: 'orders',
                as: 'orders',
                pipeline: [
                    {
                        $match: {
                            status: 'completed',
                            total: { $gt: 50 },
                        },
                    },
                ],
            },
        });
        expect(proof?.residualStage).toBeUndefined();
    });

    it('retains conditions directly on alias field when not a valid $elemMatch', () =>
    {
        const lookup = {
            $lookup: {
                from: 'orders',
                as: 'orders',
                pipeline: [],
            },
        };
        const unwind = { $unwind: '$orders' };

        const match1 = { $match: { orders: 5, 'orders.status': 'completed' } };
        const proof1 = proveLookupSubpipelinePushdown(lookup, unwind, match1);
        expect(proof1).not.toBeNull();
        expect(proof1?.residualStage).toEqual({ $match: { orders: 5 } });

        const match2 = { $match: { orders: { $size: 3 }, 'orders.status': 'completed' } };
        const proof2 = proveLookupSubpipelinePushdown(lookup, unwind, match2);
        expect(proof2).not.toBeNull();
        expect(proof2?.residualStage).toEqual({ $match: { orders: { $size: 3 } } });
    });
});

describe('LookupDelayPass mixed match splitting and subpipeline pushdown', () =>
{
    const pass = new LookupDelayPass();

    it('splits mixed match across simple equality lookup in pass execution', () =>
    {
        const pipeline = [
            makeLookup({ as: 'orders' }),
            {
                $match: {
                    status: 'active',
                    'orders.total': { $gt: 100 },
                },
            },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual([
            { $match: { status: 'active' } },
            makeLookup({ as: 'orders' }),
            { $match: { 'orders.total': { $gt: 100 } } },
        ]);
    });

    it('pushes filter into subpipeline across unwind and removes match when fully pushed', () =>
    {
        const pipeline = [
            {
                $lookup: {
                    from: 'orders',
                    as: 'orders',
                    pipeline: [{ $sort: { date: -1 } }],
                },
            },
            { $unwind: '$orders' },
            { $match: { 'orders.status': 'completed' } },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual([
            {
                $lookup: {
                    from: 'orders',
                    as: 'orders',
                    pipeline: [
                        { $sort: { date: -1 } },
                        { $match: { status: 'completed' } },
                    ],
                },
            },
            { $unwind: '$orders' },
        ]);
    });

    it('pushes filter into subpipeline and leaves residual for other fields', () =>
    {
        const pipeline = [
            {
                $lookup: {
                    from: 'orders',
                    as: 'orders',
                    pipeline: [],
                },
            },
            { $unwind: '$orders' },
            {
                $match: {
                    'orders.status': 'completed',
                    country: 'US',
                },
            },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual([
            {
                $lookup: {
                    from: 'orders',
                    as: 'orders',
                    pipeline: [{ $match: { status: 'completed' } }],
                },
            },
            { $unwind: '$orders' },
            { $match: { country: 'US' } },
        ]);
    });

    it('pushes filter into subpipeline when match stage precedes unwind', () =>
    {
        const pipeline = [
            {
                $lookup: {
                    from: 'orders',
                    as: 'orders',
                    pipeline: [{ $sort: { date: -1 } }],
                },
            },
            {
                $match: {
                    orders: { $elemMatch: { status: 'completed' } },
                },
            },
            { $unwind: '$orders' },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual([
            {
                $lookup: {
                    from: 'orders',
                    as: 'orders',
                    pipeline: [
                        { $sort: { date: -1 } },
                        { $match: { status: 'completed' } },
                    ],
                },
            },
            { $unwind: '$orders' },
        ]);
    });

    it('pushes filter into subpipeline when match stage precedes unwind and leaves residual', () =>
    {
        const pipeline = [
            {
                $lookup: {
                    from: 'orders',
                    as: 'orders',
                    pipeline: [],
                },
            },
            {
                $match: {
                    orders: { $elemMatch: { status: 'completed' } },
                    country: 'US',
                },
            },
            { $unwind: '$orders' },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual([
            {
                $lookup: {
                    from: 'orders',
                    as: 'orders',
                    pipeline: [{ $match: { status: 'completed' } }],
                },
            },
            { $match: { country: 'US' } },
            { $unwind: '$orders' },
        ]);
    });
});

describe('optimizePipeline end-to-end for lookup enhancements', () =>
{
    const customers = [
        { _id: 1, name: 'Alice', status: 'active', tier: 'gold' },
        { _id: 2, name: 'Bob', status: 'inactive', tier: 'silver' },
        { _id: 3, name: 'Charlie', status: 'active', tier: 'silver' },
    ];

    const orders = [
        { _id: 101, customerId: 1, total: 150, status: 'completed' },
        { _id: 102, customerId: 1, total: 50, status: 'pending' },
        { _id: 103, customerId: 2, total: 200, status: 'completed' },
        { _id: 104, customerId: 3, total: 80, status: 'completed' },
    ];

    it('optimizes mixed match across simple equality lookup and preserves execution parity', () =>
    {
        const pipeline = [
            {
                $lookup: {
                    from: 'orders',
                    localField: '_id',
                    foreignField: 'customerId',
                    as: 'orders',
                },
            },
            {
                $match: {
                    status: 'active',
                    'orders.total': { $gt: 100 },
                },
            },
        ];

        const optimized = optimizePipeline(pipeline);

        expect(optimized[0]).toEqual({
            $match: {
                status: 'active',
            },
        });
        expect(optimized[1]).toEqual({
            $lookup: {
                from: 'orders',
                localField: '_id',
                foreignField: 'customerId',
                as: 'orders',
            },
        });
        expect(optimized[2]).toEqual({
            $match: {
                'orders.total': { $gt: 100 },
            },
        });

        const originalResults = runMockPipeline(customers, pipeline, { orders });
        const optimizedResults = runMockPipeline(customers, optimized, { orders });

        expect(optimizedResults).toEqual(originalResults);
        expect(optimizedResults).toHaveLength(1);
        expect(optimizedResults[0]._id).toBe(1);
    });

    it('optimizes subpipeline filter pushdown across unwind in full optimizePipeline', () =>
    {
        const pipeline = [
            {
                $lookup: {
                    from: 'orders',
                    as: 'orders',
                    pipeline: [{ $sort: { total: -1 } }],
                },
            },
            { $unwind: '$orders' },
            {
                $match: {
                    'orders.status': 'completed',
                },
            },
        ];

        const optimized = optimizePipeline(pipeline);

        expect(optimized[0]).toEqual({
            $lookup: {
                from: 'orders',
                as: 'orders',
                pipeline: [
                    { $match: { status: 'completed' } },
                    { $sort: { total: -1 } },
                ],
            },
        });
        expect(optimized[1]).toEqual({
            $unwind: '$orders',
        });
        expect(optimized).toHaveLength(2);
    });
});
