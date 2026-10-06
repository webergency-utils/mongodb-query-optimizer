import { describe, expect, it } from 'vitest';
import { optimizePipeline } from './helpers/pre-gate-optimizer.js';
import {
    optimizePipelineWithCandidateProfile,
} from '../src/passes/registry.js';
import {
    AdjacentAddFieldMergingPass,
} from '../src/passes/adjacent-addfield-merging.js';
import {
    AdjacentProjectMergingPass,
} from '../src/passes/adjacent-project-merging.js';
import {
    UnusedFieldPruningPass,
} from '../src/passes/unused-field-pruning.js';
import {
    candidateSemanticCases,
    productionSemanticCases,
} from './fixtures/semantic-cases.js';
import { structuralFingerprint } from '../src/utils.js';

const ADD_FIELD_MERGING = ['adjacent-add-field-merging'] as const;
const PROJECT_MERGING = ['adjacent-project-merging'] as const;
const UNUSED_FIELD_PRUNING = ['unused-field-pruning'] as const;
const COMPLEX_PROJECTION_DEFERRAL = [
    'complex-projection-deferral',
] as const;
const REDUNDANT_PROJECTION_ELIMINATION = [
    'redundant-projection-elimination',
] as const;

function optimizeWith(
    pipeline: any[],
    transformationIds: readonly string[],
): any[]
{
    return optimizePipelineWithCandidateProfile(
        pipeline,
        transformationIds,
        [],
    );
}

describe('adjacent add-field merging proofs', () =>
{
    it('merges deterministic, error-free, disjoint writes to a fixed point', () =>
    {
        const pipeline = [
            { $addFields: { first: '$source' } },
            { $set: { second: { $eq: ['$other', 1] } } },
            { $addFields: { third: 'constant' } },
        ];

        expect(optimizeWith(pipeline, ADD_FIELD_MERGING)).toEqual([
            {
                $addFields: {
                    first: '$source',
                    second: { $eq: ['$other', 1] },
                    third: 'constant',
                },
            },
        ]);
    });

    it('performs only one adjacent merge per pass execution', () =>
    {
        const pipeline = [
            { $addFields: { first: 1 } },
            { $set: { second: 2 } },
            { $addFields: { third: 3 } },
        ];

        expect(new AdjacentAddFieldMergingPass().execute(pipeline)).toEqual([
            { $addFields: { first: 1, second: 2 } },
            { $addFields: { third: 3 } },
        ]);
    });

    it('blocks every supported way the second stage can read the first write', () =>
    {
        const secondExpressions = [
            '$prior',
            '$$CURRENT.prior',
            '$$ROOT.prior',
            { $getField: 'prior' },
            {
                $getField: {
                    field: 'prior',
                    input: '$$CURRENT',
                },
            },
            '$$CURRENT',
            '$$ROOT',
        ];

        for (const expression of secondExpressions)
        {
            const pipeline = [
                { $addFields: { prior: 1 } },
                { $set: { later: expression } },
            ];

            expect(optimizeWith(pipeline, ADD_FIELD_MERGING)).toEqual(pipeline);
        }
    });

    it('treats ancestor, descendant, invalid, empty, and colliding writes as barriers', () =>
    {
        const pipelines = [
            [
                { $addFields: { profile: { name: 'Ada' } } },
                { $set: { 'profile.name': 'Grace' } },
            ],
            [
                { $addFields: { 'profile.name': 'Ada' } },
                { $set: { profile: { name: 'Grace' } } },
            ],
            [
                { $addFields: {} },
                { $set: { valid: 1 } },
            ],
            [
                { $addFields: { valid: 1 } },
                { $set: {} },
            ],
            [
                { $addFields: { profile: 1, 'profile.name': 2 } },
                { $set: { valid: 1 } },
            ],
            [
                { $addFields: { '$invalid': 1 } },
                { $set: { valid: 1 } },
            ],
        ];

        for (const pipeline of pipelines)
        {
            expect(optimizeWith(pipeline, ADD_FIELD_MERGING)).toEqual(pipeline);
        }
    });

    it('preserves volatile and unknown evaluations in adjacent add-field merging', () =>
    {
        const pipelines = [
            [
                { $addFields: { random: { $rand: {} } } },
                { $set: { stable: 1 } },
            ],
            [
                { $addFields: { value: { $unknownOperator: '$source' } } },
                { $set: { stable: 1 } },
            ],
        ];

        for (const pipeline of pipelines)
        {
            expect(optimizeWith(pipeline, ADD_FIELD_MERGING)).toEqual(pipeline);
        }
    });

    it('merges adjacent add-fields with potentially erroring expressions under relaxed error safety', () =>
    {
        expect(optimizeWith([
            { $addFields: { stable: 1 } },
            { $set: { ratio: { $divide: [1, '$divisor'] } } },
        ], ADD_FIELD_MERGING)).toEqual([
            { $addFields: { stable: 1, ratio: { $divide: [1, '$divisor'] } } },
        ]);

        expect(optimizeWith([
            { $addFields: { sum: { $add: ['$untyped', 1] } } },
            { $set: { stable: 1 } },
        ], ADD_FIELD_MERGING)).toEqual([
            { $addFields: { sum: { $add: ['$untyped', 1] }, stable: 1 } },
        ]);

        expect(optimizeWith([
            { $addFields: { stable: 1 } },
            { $set: { sum: { $add: ['$untyped', 1] } } },
        ], ADD_FIELD_MERGING)).toEqual([
            { $addFields: { stable: 1, sum: { $add: ['$untyped', 1] } } },
        ]);

        expect(optimizeWith([
            { $addFields: { malformed: { $eq: ['$value'] } } },
            { $set: { stable: 1 } },
        ], ADD_FIELD_MERGING)).toEqual([
            { $addFields: { malformed: { $eq: ['$value'] }, stable: 1 } },
        ]);
    });
});

describe('adjacent simple project merging proofs', () =>
{
    it('merges directly proven inclusion and exclusion combinations', () =>
    {
        const cases = [
            {
                pipeline: [
                    { $project: { name: 1, score: true } },
                    { $project: { score: true } },
                ],
                expected: [
                    { $project: { score: true } },
                ],
            },
            {
                pipeline: [
                    { $project: { name: 1, secret: true, _id: false } },
                    { $project: { secret: false } },
                ],
                expected: [
                    { $project: { name: 1, _id: false } },
                ],
            },
            {
                pipeline: [
                    { $project: { secret: 0 } },
                    { $project: { name: true, _id: false } },
                ],
                expected: [
                    { $project: { name: true, _id: false } },
                ],
            },
            {
                pipeline: [
                    { $project: { secret: false } },
                    { $project: { token: 0, _id: false } },
                ],
                expected: [
                    { $project: { secret: false, token: 0, _id: false } },
                ],
            },
        ];

        for (const testCase of cases)
        {
            expect(optimizeWith(testCase.pipeline, PROJECT_MERGING)).toEqual(
                testCase.expected,
            );
        }
    });

    it('preserves _id default, explicit inclusion, and explicit exclusion', () =>
    {
        const cases = [
            {
                pipeline: [
                    { $project: { name: 1, score: 1 } },
                    { $project: { _id: true } },
                ],
                expected: [
                    { $project: { _id: true } },
                ],
            },
            {
                pipeline: [
                    { $project: { name: 1, _id: false } },
                    { $project: { name: true } },
                ],
                expected: [
                    { $project: { name: true, _id: false } },
                ],
            },
            {
                pipeline: [
                    { $project: { name: true, score: 1 } },
                    { $project: { name: 1, _id: false } },
                ],
                expected: [
                    { $project: { name: 1, _id: false } },
                ],
            },
            {
                pipeline: [
                    { $project: { secret: 0, _id: true } },
                    { $project: { token: false } },
                ],
                expected: [
                    { $project: { secret: 0, token: false, _id: true } },
                ],
            },
        ];

        for (const testCase of cases)
        {
            expect(optimizeWith(testCase.pipeline, PROJECT_MERGING)).toEqual(
                testCase.expected,
            );
        }
    });

    it('declines field and explicit _id resurrection', () =>
    {
        const pipelines = [
            [
                { $project: { retained: 1 } },
                { $project: { omitted: 1 } },
            ],
            [
                { $project: { removed: 0 } },
                { $project: { removed: 1, retained: 1 } },
            ],
            [
                { $project: { retained: 1, _id: 0 } },
                { $project: { retained: 1, _id: 1 } },
            ],
            [
                { $project: { retained: 1, other: 1, _id: 0 } },
                { $project: { other: 0, _id: 1 } },
            ],
        ];

        for (const pipeline of pipelines)
        {
            expect(optimizeWith(pipeline, PROJECT_MERGING)).toEqual(pipeline);
        }
    });

    it('declines compositions whose exact output would require an empty project', () =>
    {
        const pipeline = [
            { $project: { only: 1, _id: 0 } },
            { $project: { only: 0 } },
        ];

        expect(optimizeWith(pipeline, PROJECT_MERGING)).toEqual(pipeline);
    });

    it('treats computed, dotted, colliding, mixed, and empty specs as barriers', () =>
    {
        const pipelines = [
            [
                { $project: { name: 1 } },
                { $project: { computed: { $literal: 1 } } },
            ],
            [
                { $project: { 'profile.name': 1 } },
                { $project: { 'profile.name': 1 } },
            ],
            [
                { $project: { 'profile.secret': 0 } },
                { $project: { 'profile.transient': 0 } },
            ],
            [
                { $project: { profile: 0 } },
                { $project: { 'profile.name': 0 } },
            ],
            [
                { $project: { profile: 1, 'profile.name': 1 } },
                { $project: { profile: 1 } },
            ],
            [
                { $project: { visible: 1, hidden: 0 } },
                { $project: { visible: 1 } },
            ],
            [
                { $project: {} },
                { $project: { visible: 1 } },
            ],
            [
                { $project: { visible: 1 } },
                { $project: {} },
            ],
        ];

        for (const pipeline of pipelines)
        {
            expect(optimizeWith(pipeline, PROJECT_MERGING)).toEqual(pipeline);
        }
    });

    it('performs only one adjacent project merge per pass execution', () =>
    {
        const pipeline = [
            { $project: { first: 1, second: 1, third: 1 } },
            { $project: { first: 1, second: 1 } },
            { $project: { first: 1 } },
        ];

        expect(new AdjacentProjectMergingPass().execute(pipeline)).toEqual([
            { $project: { first: 1, second: 1 } },
            { $project: { first: 1 } },
        ]);
        expect(optimizeWith(pipeline, PROJECT_MERGING)).toEqual([
            { $project: { first: 1 } },
        ]);
    });
});

describe('exact dead add-field pruning proofs', () =>
{
    it('prunes deterministic exact top-level writes killed by the next unset', () =>
    {
        expect(optimizeWith([
            {
                $set: {
                    removed: '$source',
                    retained: '$other',
                },
            },
            { $unset: 'removed' },
        ], UNUSED_FIELD_PRUNING)).toEqual([
            { $set: { retained: '$other' } },
            { $unset: 'removed' },
        ]);

        expect(optimizeWith([
            { $addFields: { first: 1, second: 2 } },
            { $unset: ['first', 'second'] },
        ], UNUSED_FIELD_PRUNING)).toEqual([
            { $unset: ['first', 'second'] },
        ]);
    });

    it('prunes exact top-level writes hidden or removed by the next simple project', () =>
    {
        expect(optimizeWith([
            {
                $addFields: {
                    dead: '$source',
                    retained: '$name',
                },
            },
            { $project: { name: 1, retained: 1 } },
        ], UNUSED_FIELD_PRUNING)).toEqual([
            { $addFields: { retained: '$name' } },
            { $project: { name: 1, retained: 1 } },
        ]);

        expect(optimizeWith([
            { $addFields: { dead: 1 } },
            { $project: { dead: 0 } },
        ], UNUSED_FIELD_PRUNING)).toEqual([
            { $project: { dead: 0 } },
        ]);

        expect(optimizeWith([
            { $addFields: { kept: 1 } },
            { $project: { secret: 0 } },
        ], UNUSED_FIELD_PRUNING)).toEqual([
            { $addFields: { kept: 1 } },
            { $project: { secret: 0 } },
        ]);
    });

    it('respects strictErrors and leaves error-prone stages intact', () =>
    {
        const pass = new UnusedFieldPruningPass();
        const errorPronePipeline = [
            { $addFields: { dead: '$val', errorField: { $toInt: '$val' } } },
            { $project: { _id: 1, errorField: 1 } },
        ];

        // Default mode prunes dead field
        expect(pass.execute(errorPronePipeline, { strictFieldOrder: false, strictErrors: false })).toEqual([
            { $addFields: { errorField: { $toInt: '$val' } } },
            { $project: { _id: 1, errorField: 1 } },
        ]);

        // Strict errors mode refuses to touch error-prone stage
        expect(pass.execute(errorPronePipeline, { strictFieldOrder: false, strictErrors: true })).toEqual(
            errorPronePipeline,
        );

        // Proven error-free stage is pruned even in strictErrors mode
        const safePipeline = [
            { $addFields: { dead: '$val' } },
            { $project: { _id: 1 } },
        ];
        expect(pass.execute(safePipeline, { strictFieldOrder: false, strictErrors: true })).toEqual([
            { $project: { _id: 1 } },
        ]);
    });

    it('prunes a dead write after a suffix that does not observe it', () =>
    {
        expect(optimizeWith([
            { $set: { dead: '$source', retained: '$name' } },
            { $sort: { score: -1 } },
            { $unset: 'dead' },
        ], UNUSED_FIELD_PRUNING)).toEqual([
            { $set: { retained: '$name' } },
            { $sort: { score: -1 } },
            { $unset: 'dead' },
        ]);

        expect(optimizeWith([
            { $addFields: { dead: 1 } },
            { $unset: 'temporary' },
            { $unset: 'dead' },
        ], UNUSED_FIELD_PRUNING)).toEqual([
            { $unset: 'temporary' },
            { $unset: 'dead' },
        ]);

        expect(optimizeWith([
            { $addFields: { dead: 1, kept: 2 } },
            { $match: { status: 'active' } },
            { $limit: 2 },
            { $skip: 1 },
            { $set: { other: 3 } },
            { $project: { kept: 1, other: 1 } },
        ], UNUSED_FIELD_PRUNING)).toEqual([
            { $addFields: { kept: 2 } },
            { $match: { status: 'active' } },
            { $limit: 2 },
            { $skip: 1 },
            { $set: { other: 3 } },
            { $project: { kept: 1, other: 1 } },
        ]);

        expect(optimizeWith([
            { $addFields: { dead: 1 } },
            { $unwind: '$items' },
            { $unset: 'dead' },
        ], UNUSED_FIELD_PRUNING)).toEqual([
            { $unwind: '$items' },
            { $unset: 'dead' },
        ]);
    });

    it('does not prune across an observer, exclusion project, or unknown suffix', () =>
    {
        const barriers = [
            [
                { $addFields: { dead: 1 } },
                { $sort: { dead: 1 } },
                { $unset: 'dead' },
            ],
            [
                { $addFields: { dead: 1 } },
                { $match: { dead: 1 } },
                { $unset: 'dead' },
            ],
            [
                { $addFields: { dead: 1 } },
                { $set: { snapshot: '$$ROOT' } },
                { $unset: 'dead' },
            ],
            [
                { $addFields: { dead: 1 } },
                { $set: { copy: '$dead' } },
                { $unset: 'dead' },
            ],
            [
                { $addFields: { dead: 1 } },
                { $project: { secret: 0 } },
                { $unset: 'dead' },
            ],
            [
                { $addFields: { dead: 1 } },
                { $project: { dead: 1, name: 1 } },
                { $unset: 'dead' },
            ],
            [
                { $addFields: { dead: 1 } },
                {
                    $lookup: {
                        from: 'orders',
                        localField: 'dead',
                        foreignField: 'customerId',
                        as: 'orders',
                    },
                },
                { $unset: 'dead' },
            ],
            [
                { $addFields: { dead: 1 } },
                { $unwind: '$dead' },
                { $unset: 'dead' },
            ],
            [
                { $addFields: { dead: 1 } },
                { $group: { _id: '$dead' } },
                { $unset: 'dead' },
            ],
            [
                { $addFields: { dead: 1 } },
                { $facet: { kept: [{ $limit: 1 }] } },
                { $unset: 'dead' },
            ],
            [
                { $addFields: { dead: 1 } },
                { $futureStage: { stable: true } },
                { $unset: 'dead' },
            ],
            [
                { $addFields: { dead: { $rand: {} } } },
                { $sort: { score: -1 } },
                { $unset: 'dead' },
            ],
        ];

        for (const pipeline of barriers)
        {
            expect(optimizeWith(pipeline, UNUSED_FIELD_PRUNING)).toEqual(pipeline);
        }
    });

    it('prunes exact overwrites only when the next stage does not read the field', () =>
    {
        expect(optimizeWith([
            { $addFields: { retained: 1, overwritten: '$source' } },
            { $set: { overwritten: 2, final: 3 } },
        ], UNUSED_FIELD_PRUNING)).toEqual([
            { $addFields: { retained: 1 } },
            { $set: { overwritten: 2, final: 3 } },
        ]);

        expect(optimizeWith([
            { $set: { overwritten: 1 } },
            { $addFields: { overwritten: '$source' } },
        ], UNUSED_FIELD_PRUNING)).toEqual([
            { $addFields: { overwritten: '$source' } },
        ]);
    });

    it('never prunes inclusion or computed project entries', () =>
    {
        const pipelines = [
            [
                { $project: { retained: 1, discarded: 1 } },
                { $unset: 'discarded' },
            ],
            [
                { $project: { computed: { $add: ['$source', 1] } } },
                { $unset: 'computed' },
            ],
        ];

        for (const pipeline of pipelines)
        {
            expect(optimizeWith(pipeline, UNUSED_FIELD_PRUNING)).toEqual(pipeline);
        }
    });

    it('preserves volatile, erroring, getField, and whole-document assignments', () =>
    {
        const expressions = [
            { $rand: {} },
            { $divide: [1, '$zero'] },
            { $add: ['$untyped', 1] },
            { $eq: ['$missingSecondOperand'] },
            {
                $function: {
                    body: 'function (value) { return value; }',
                    args: ['$source'],
                    lang: 'js',
                },
            },
            { $getField: 'source' },
            {
                $getField: {
                    field: 'source',
                    input: '$$CURRENT',
                },
            },
            '$$ROOT',
            '$$CURRENT',
            { $unknownOperator: '$source' },
        ];

        for (const expression of expressions)
        {
            const pipeline = [
                { $addFields: { dead: expression } },
                { $unset: 'dead' },
            ];

            expect(optimizeWith(pipeline, UNUSED_FIELD_PRUNING)).toEqual(pipeline);
        }
    });

    it('treats overwrite-wide dependencies and BSON field order as kill obligations', () =>
    {
        const dependencyBarrier = [
            { $set: { retained: 1, dead: 2 } },
            {
                $set: {
                    snapshot: '$dead',
                    dead: 3,
                },
            },
        ];
        expect(
            optimizeWith(dependencyBarrier, UNUSED_FIELD_PRUNING),
        ).toEqual(dependencyBarrier);

        const orderSafe = [
            {
                $set: {
                    retained: 0,
                    first: 1,
                    second: 2,
                },
            },
            {
                $set: {
                    first: 3,
                    second: 4,
                    final: 5,
                },
            },
        ];
        expect(optimizeWith(orderSafe, UNUSED_FIELD_PRUNING)).toEqual([
            { $set: { retained: 0 } },
            {
                $set: {
                    first: 3,
                    second: 4,
                    final: 5,
                },
            },
        ]);

        const selectiveOrderProof = [
            {
                $set: {
                    retained: 0,
                    first: 1,
                    second: 2,
                },
            },
            {
                $set: {
                    second: 4,
                    first: 3,
                },
            },
        ];
        expect(optimizeWith(selectiveOrderProof, UNUSED_FIELD_PRUNING)).toEqual([
            {
                $set: {
                    retained: 0,
                    first: 1,
                },
            },
            {
                $set: {
                    second: 4,
                    first: 3,
                },
            },
        ]);

        const orderBarrier = [
            {
                $set: {
                    retained: 0,
                    first: 1,
                    second: 2,
                },
            },
            {
                $set: {
                    first: 3,
                    final: 4,
                },
            },
        ];
        expect(optimizeWith(
            orderBarrier,
            UNUSED_FIELD_PRUNING,
        )).toEqual(orderBarrier);
    });

    it('recognizes direct, ROOT/CURRENT, getField, and whole-document overwrite reads', () =>
    {
        const expressions = [
            '$dead',
            '$$CURRENT.dead',
            '$$ROOT.dead',
            { $getField: 'dead' },
            {
                $getField: {
                    field: 'dead',
                    input: '$$ROOT',
                },
            },
            '$$ROOT',
        ];

        for (const expression of expressions)
        {
            const pipeline = [
                { $addFields: { dead: 1, retained: 2 } },
                { $set: { dead: expression } },
            ];

            expect(optimizeWith(pipeline, UNUSED_FIELD_PRUNING)).toEqual(pipeline);
        }
    });

    it('requires an immediate exact top-level kill and valid noncolliding specs', () =>
    {
        const pipelines = [
            [
                { $addFields: { 'profile.name': 'Ada' } },
                { $unset: 'profile.name' },
            ],
            [
                { $addFields: { profile: { name: 'Ada' } } },
                { $unset: 'profile.name' },
            ],
            [
                { $addFields: { 'profile.name': 'Ada' } },
                { $unset: 'profile' },
            ],
            [
                { $addFields: { dead: 1 } },
                { $sort: { dead: 1 } },
                { $unset: 'dead' },
            ],
            [
                { $addFields: { profile: 1, 'profile.name': 2 } },
                { $unset: 'profile' },
            ],
            [
                { $addFields: {} },
                { $unset: 'dead' },
            ],
            [
                { $addFields: { dead: 1 } },
                { $sort: { dead: 1 } },
                { $project: { dead: 0 } },
            ],
            [
                { $addFields: { dead: 1, retained: 2 } },
                { $set: { dead: 3 } },
            ],
            [
                { $addFields: { dead: 1 } },
                { $set: { insertedFirst: 2, dead: 3 } },
            ],
        ];

        for (const pipeline of pipelines)
        {
            expect(optimizeWith(pipeline, UNUSED_FIELD_PRUNING)).toEqual(pipeline);
        }
    });
});

describe('contained projection families', () =>
{
    it('keeps complex projection deferral conservative across every known boundary', () =>
    {
        const intermediateStages = [
            { $limit: 2 },
            { $skip: 1 },
            { $set: { computed: 0 } },
            { $unset: 'source' },
            {
                $lookup: {
                    from: 'orders',
                    localField: '_id',
                    foreignField: 'customerId',
                    as: 'computed',
                },
            },
            { $unionWith: 'archive' },
            {
                $densify: {
                    field: 'sequence',
                    range: { bounds: [0, 2], step: 1 },
                },
            },
            { $unwind: '$items' },
        ];

        for (const intermediateStage of intermediateStages)
        {
            const addFieldsPipeline = [
                { $addFields: { computed: { $add: ['$source', 1] } } },
                intermediateStage,
            ];
            const projectPipeline = [
                { $project: { computed: { $add: ['$source', 1] } } },
                intermediateStage,
            ];

            expect(
                optimizeWith(addFieldsPipeline, COMPLEX_PROJECTION_DEFERRAL),
            ).toEqual(addFieldsPipeline);
            expect(
                optimizeWith(projectPipeline, COMPLEX_PROJECTION_DEFERRAL),
            ).toEqual(projectPipeline);
        }

        expect(optimizeWith([
            { $addFields: { computed: { $add: ['$source', 1] } } },
            { $sort: { score: -1 } },
        ], COMPLEX_PROJECTION_DEFERRAL)).toEqual([
            { $sort: { score: -1 } },
            { $addFields: { computed: { $add: ['$source', 1] } } },
        ]);

        expect(optimizeWith([
            { $addFields: { computed: { $rand: {} } } },
            { $sort: { score: -1 } },
        ], COMPLEX_PROJECTION_DEFERRAL)).toEqual([
            { $addFields: { computed: { $rand: {} } } },
            { $sort: { score: -1 } },
        ]);

        const colliding = [
            { $set: { profile: 1, 'profile.name': 2 } },
            { $sort: { score: -1 } },
        ];
        expect(optimizeWith(
            colliding,
            COMPLEX_PROJECTION_DEFERRAL,
        )).toEqual(colliding);
    });

    it('keeps redundant projection elimination conservative for unsafe duplicates', () =>
    {
        const pipelines = [
            [
                { $project: { value: { $add: ['$value', 1] } } },
                { $project: { value: { $add: ['$value', 1] } } },
            ],
            [
                { $addFields: { value: { $add: ['$value', 1] } } },
                { $addFields: { value: { $add: ['$value', 1] } } },
            ],
            [
                { $project: { name: 1, _id: 0 } },
                { $project: { name: 1, _id: 0 } },
            ],
        ];

        for (const pipeline of pipelines)
        {
            expect(
                optimizeWith(pipeline, REDUNDANT_PROJECTION_ELIMINATION),
            ).toEqual(pipeline);
        }
    });

    it('keeps every projection-family profile immutable and idempotent', () =>
    {
        const cases = [
            {
                ids: ADD_FIELD_MERGING,
                pipeline: [
                    { $addFields: { first: 1 } },
                    { $set: { second: 2 } },
                ],
            },
            {
                ids: PROJECT_MERGING,
                pipeline: [
                    { $project: { first: 1, second: 1 } },
                    { $project: { first: 1 } },
                ],
            },
            {
                ids: UNUSED_FIELD_PRUNING,
                pipeline: [
                    { $set: { dead: '$source', retained: 1 } },
                    { $unset: 'dead' },
                ],
            },
            {
                ids: COMPLEX_PROJECTION_DEFERRAL,
                pipeline: [
                    { $set: { computed: { $add: ['$source', 1] } } },
                    { $sort: { score: -1 } },
                ],
            },
            {
                ids: REDUNDANT_PROJECTION_ELIMINATION,
                pipeline: [
                    { $project: { first: 1 } },
                    { $project: { first: 1 } },
                ],
            },
        ];

        for (const testCase of cases)
        {
            const snapshot = structuredClone(testCase.pipeline);
            const once = optimizeWith(testCase.pipeline, testCase.ids);
            const twice = optimizeWith(once, testCase.ids);

            expect(testCase.pipeline).toEqual(snapshot);
            expect(twice).toEqual(once);
        }
    });
});

describe('projection production integration and scheduling', () =>
{
    it('owns the U9 dead-write error, dependency, and field-order fixtures', () =>
    {
        const classifications = Object.fromEntries(
            productionSemanticCases
                .filter((testCase) => testCase.id.startsWith('u9-dead-write-'))
                .map((testCase) =>
                {
                    expect(testCase.kind).toBe('pipeline');
                    if (testCase.kind !== 'pipeline')
                    {
                        return [testCase.id, 'invalid-test-fixture'];
                    }

                    const optimized = optimizePipeline(testCase.pipeline as any[]);
                    return [
                        testCase.id,
                        structuralFingerprint(optimized)
                            === structuralFingerprint(testCase.pipeline)
                            ? 'barrier'
                            : 'rewrite',
                    ];
                }),
        );

        expect(classifications).toEqual({
            'u9-dead-write-add-type-error-barrier': 'barrier',
            'u9-dead-write-overwrite-dependency-barrier': 'rewrite',
            'u9-dead-write-overwrite-field-order': 'rewrite',
        });
    });

    it('registers each U6 server fixture as a rewrite or structural barrier', () =>
    {
        const classifications: Record<string, 'rewrite' | 'barrier'> = {};
        for (const testCase of productionSemanticCases)
        {
            if (testCase.kind !== 'pipeline' || !testCase.id.startsWith('u6-'))
            {
                continue;
            }

            const optimized = optimizePipeline(testCase.pipeline as any[]);
            classifications[testCase.id] = JSON.stringify(optimized)
                === JSON.stringify(testCase.pipeline)
                ? 'barrier'
                : 'rewrite';
        }

        expect(classifications).toEqual({
            'u6-add-set-merge-top-level': 'rewrite',
            'u6-project-merge-inclusion-top-level': 'rewrite',
            'u6-project-merge-id-only': 'rewrite',
            'u6-project-merge-exclusion-top-level': 'rewrite',
            'u6-dead-write-unset-top-level': 'rewrite',
            'u6-dead-write-overwrite-top-level': 'rewrite',
            'u6-nested-facet-safe-rewrites': 'rewrite',
            'u6-add-set-current-getfield-barrier': 'barrier',
            'u6-project-resurrection-empty-output-barrier': 'barrier',
            'u6-volatile-dead-write-barrier': 'barrier',
            'u6-erroring-dead-write-barrier': 'barrier',
            'u6-nested-evaluation-barriers': 'barrier',
            'u6-dead-write-inclusion-project-top-level': 'rewrite',
            'u6-dead-write-transparent-suffix-unset': 'rewrite',
            'u6-add-field-deferral-sort': 'rewrite',
        });

        const candidateBarriers = candidateSemanticCases.filter(
            (testCase) => testCase.id.startsWith('u6-candidate-'),
        );
        expect(candidateBarriers).toHaveLength(2);
        for (const testCase of candidateBarriers)
        {
            expect(testCase.kind).toBe('pipeline');
            if (testCase.kind === 'pipeline')
            {
                expect(optimizeWith(
                    testCase.pipeline as any[],
                    testCase.candidateTransformationIds ?? [],
                )).toEqual(testCase.pipeline);
            }
        }
    });

    it('enables only the proven nontrivial projection rewrites', () =>
    {
        expect(optimizePipeline([
            { $addFields: { dead: '$source' } },
            { $unset: 'dead' },
            { $project: { name: 1, score: 1 } },
            { $project: { name: 1 } },
            { $addFields: { first: 1 } },
            { $set: { second: 2 } },
        ])).toEqual([
            { $unset: 'dead' },
            { $project: { name: 1 } },
            { $addFields: { first: 1, second: 2 } },
        ]);

        expect(optimizePipeline([
            { $sort: { score: -1 } },
            { $project: { name: 1, score: 1 } },
        ])).toEqual([
            { $project: { name: 1, score: 1 } },
            { $sort: { score: -1 } },
        ]);

        const deferral = [
            { $addFields: { computed: { $add: ['$source', 1] } } },
            { $sort: { score: -1 } },
        ];
        expect(optimizePipeline(deferral)).toEqual([
            { $sort: { score: -1 } },
            { $addFields: { computed: { $add: ['$source', 1] } } },
        ]);
        expect(optimizePipeline([
            { $addFields: { label: '$name' } },
            { $sort: { score: -1 } },
        ])).toEqual([
            { $sort: { score: -1 } },
            { $addFields: { label: '$name' } },
        ]);
    });

    it('applies proven rewrites inside facet, lookup, and union pipelines', () =>
    {
        const pipeline = [
            {
                $facet: {
                    branch: [
                        { $addFields: { first: 1 } },
                        { $set: { second: 2 } },
                    ],
                },
            },
            {
                $lookup: {
                    from: 'orders',
                    pipeline: [
                        { $project: { paid: 1, amount: 1 } },
                        { $project: { paid: 1 } },
                    ],
                    as: 'orders',
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        { $set: { dead: 1 } },
                        { $unset: 'dead' },
                    ],
                },
            },
        ];

        expect(optimizePipeline(pipeline)).toEqual([
            {
                $facet: {
                    branch: [
                        { $addFields: { first: 1, second: 2 } },
                    ],
                },
            },
            {
                $lookup: {
                    from: 'orders',
                    pipeline: [
                        { $project: { paid: 1 } },
                    ],
                    as: 'orders',
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        { $unset: 'dead' },
                    ],
                },
            },
        ]);
    });

    it('converges with movement passes without mutating caller input', () =>
    {
        const pipeline = [
            { $project: { name: 1, score: 1 } },
            { $project: { name: 1 } },
            { $match: { name: 'Ada' } },
            { $addFields: { first: 1 } },
            { $set: { second: 2 } },
            { $limit: 1 },
        ];
        const snapshot = structuredClone(pipeline);

        const once = optimizePipeline(pipeline);
        const twice = optimizePipeline(once);

        expect(pipeline).toEqual(snapshot);
        expect(once).toEqual([
            { $match: { name: 'Ada' } },
            { $limit: 1 },
            { $project: { name: 1 } },
            { $addFields: { first: 1, second: 2 } },
        ]);
        expect(twice).toEqual(once);
    });

    it('keeps production counterexamples as structural barriers', () =>
    {
        const pipelines = [
            [
                { $addFields: { prior: 1 } },
                { $set: { later: '$$ROOT' } },
            ],
            [
                { $project: { retained: 1 } },
                { $project: { omitted: 1 } },
            ],
            [
                { $set: { dead: { $rand: {} } } },
                { $unset: 'dead' },
            ],
            [
                { $project: { computed: { $add: ['$source', 1] } } },
                { $sort: { source: 1 } },
            ],
        ];

        for (const pipeline of pipelines)
        {
            expect(optimizePipeline(pipeline)).toEqual(pipeline);
        }
    });
});
