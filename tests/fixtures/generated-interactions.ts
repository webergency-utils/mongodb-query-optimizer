import type { Document } from 'mongodb';
import type { FilterRuleId } from '../../src/filter-rule-registry.js';
import type {
    PipelineTransformationId,
} from '../../src/passes/registry.js';
import type { SemanticCase } from './semantic-cases.js';
import { MIXED_SHAPE_CATALOG } from './mixed-shapes.js';

export const GENERATED_INTERACTION_SEED = 0x5eed_2026;
export const GENERATED_INTERACTION_CASE_COUNT = 54;

interface InteractionDescriptor
{
    readonly pipelineId: PipelineTransformationId;
    readonly filterId: FilterRuleId;
}

const interactionDescriptors: readonly InteractionDescriptor[] = Object.freeze([
    {
        pipelineId: 'filter-optimization',
        filterId: 'simplify-equality',
    },
    {
        pipelineId: 'adjacent-match-merging',
        filterId: 'simplify-singleton-in',
    },
    {
        pipelineId: 'limit-skip-coalescing',
        filterId: 'flatten-conjunctions',
    },
    {
        pipelineId: 'expression-simplification',
        filterId: 'flatten-conjunctions',
    },
    {
        pipelineId: 'match-pushdown',
        filterId: 'flatten-disjunctions',
    },
    {
        pipelineId: 'heuristic-match-pushdown',
        filterId: 'flatten-disjunctions',
    },
    {
        pipelineId: 'limit-advance',
        filterId: 'simplify-conjunction-identities',
    },
    {
        pipelineId: 'unused-field-pruning',
        filterId: 'simplify-disjunction-identities',
    },
    {
        pipelineId: 'adjacent-project-merging',
        filterId: 'deduplicate-conjunctions',
    },
    {
        pipelineId: 'adjacent-add-field-merging',
        filterId: 'merge-conjunctions',
    },
    {
        pipelineId: 'lookup-delay',
        filterId: 'simplify-equality',
    },
    {
        pipelineId: 'redundant-lookup-elimination',
        filterId: 'simplify-singleton-in',
    },
    {
        pipelineId: 'sort-project-commute',
        filterId: 'flatten-conjunctions',
    },
    {
        pipelineId: 'complex-projection-deferral',
        filterId: 'flatten-disjunctions',
    },
    {
        pipelineId: 'expr-match-normalization',
        filterId: 'simplify-equality',
    },
    {
        pipelineId: 'group-filter-pushdown',
        filterId: 'simplify-singleton-in',
    },
    {
        pipelineId: 'bucket-filter-pushdown',
        filterId: 'simplify-singleton-in',
    },
    {
        pipelineId: 'unwind-prefilter',
        filterId: 'flatten-conjunctions',
    },
    {
        pipelineId: 'redundant-sort-elimination',
        filterId: 'simplify-equality',
    },
    {
        pipelineId: 'sort-by-count-simplification',
        filterId: 'merge-conjunctions',
    },
    {
        pipelineId: 'facet-prefix-hoisting',
        filterId: 'flatten-disjunctions',
    },
    {
        pipelineId: 'add-field-pushdown',
        filterId: 'simplify-equality',
    },
    {
        pipelineId: 'top-k-pushdown',
        filterId: 'simplify-equality',
    },
]);

export function seededRandom(seed: number): () => number
{
    let state = seed >>> 0;

    return () =>
    {
        state += 0x6d2b_79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
}

function randomInteger(
    random: () => number,
    minimum: number,
    maximum: number,
): number
{
    return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function makeDocuments(
    random: () => number,
    activeScore: number,
): readonly Document[]
{
    const secondaryScore = randomInteger( random, 13, 21 );

    return [
        {
            _id: 1,
            status: 'active',
            score: activeScore,
            marker: true,
            tenant: 'acme',
            nullable: null,
            ordered: { first: 1, second: 2 },
            secret: 'first',
            items: [ { score: activeScore } ],
            polymorphic: MIXED_SHAPE_CATALOG[1].createValue( 1 ),
        },
        {
            _id: 2,
            status: 'inactive',
            score: secondaryScore,
            marker: true,
            tenant: 'acme',
            nullable: 'present',
            ordered: { first: 2, second: 1 },
            secret: 'second',
            items: [ { score: secondaryScore } ],
            polymorphic: MIXED_SHAPE_CATALOG[2].createValue( 2 ),
        },
        {
            _id: 3,
            status: 'active',
            score: activeScore,
            marker: false,
            tenant: 'other',
            ordered: { first: 3, second: 3 },
            items: [ { score: activeScore } ],
            polymorphic: MIXED_SHAPE_CATALOG[3].createValue( 3 ),
        },
    ];
}

function makeFilter(
    id: FilterRuleId,
    score: number,
): Document
{
    switch (id)
    {
        case 'simplify-equality':
            return { status: { $eq: 'active' } };
        case 'simplify-singleton-in':
            return { score: { $in: [score] } };
        case 'flatten-conjunctions':
            return {
                $and: [
                    { status: 'active' },
                    {
                        $and: [
                            { marker: true },
                            { score: { $gte: 0 } },
                        ],
                    },
                ],
            };
        case 'flatten-disjunctions':
            return {
                $or: [
                    { status: 'active' },
                    {
                        $or: [
                            { score },
                            { nullable: null },
                        ],
                    },
                ],
            };
        case 'simplify-conjunction-identities':
            return {
                $and: [
                    {},
                    { status: 'active' },
                ],
            };
        case 'simplify-disjunction-identities':
            return {
                tenant: 'acme',
                $or: [
                    {},
                    { score },
                ],
            };
        case 'deduplicate-conjunctions':
            return {
                $and: [
                    { status: 'active' },
                    { status: 'active' },
                    { marker: true },
                ],
            };
        case 'merge-conjunctions':
            return {
                $and: [
                    { status: 'active' },
                    { marker: true },
                ],
            };
    }
}

function makeInteractionPipeline(
    id: PipelineTransformationId,
    filter: Document,
    random: () => number,
): readonly Document[]
{
    const firstLimit = randomInteger(random, 2, 3);
    const secondLimit = randomInteger(random, 1, 2);

    switch (id)
    {
        case 'filter-optimization':
            return [
                { $match: filter },
                { $sort: { _id: 1 } },
            ];
        case 'adjacent-match-merging':
            return [
                { $match: filter },
                { $match: { marker: true } },
                { $sort: { _id: 1 } },
            ];
        case 'limit-skip-coalescing':
            return [
                { $match: filter },
                { $sort: { _id: 1 } },
                { $limit: firstLimit },
                { $limit: secondLimit },
            ];
        case 'expression-simplification':
            return [
                { $match: filter },
                {
                    $addFields: {
                        total: {
                            $size: {
                                $filter: {
                                    input: '$items',
                                    cond: { $and: [ {}, {} ] },
                                },
                            },
                        },
                    },
                },
                { $sort: { _id: 1 } },
            ];
        case 'match-pushdown':
            return [
                {
                    $project: {
                        status: 1,
                        score: 1,
                        marker: 1,
                        tenant: 1,
                        nullable: 1,
                        ordered: 1,
                    },
                },
                { $match: filter },
                { $sort: { _id: 1 } },
            ];
        case 'heuristic-match-pushdown':
            return [
                {
                    $lookup: {
                        from: 'foreign',
                        localField: 'foreignId',
                        foreignField: '_id',
                        as: 'joined',
                    },
                },
                { $addFields: { k: { $size: { $ifNull: [ '$joined', [] ] } } } },
                { $match: { $and: [ filter, { k: { $gte: 0 } } ] } },
                { $sort: { _id: 1 } },
            ];
        case 'limit-advance':
            return [
                { $match: filter },
                { $sort: { _id: 1 } },
                { $addFields: { stable: firstLimit } },
                { $limit: secondLimit },
            ];
        case 'unused-field-pruning':
            return [
                { $match: filter },
                {
                    $set: {
                        retained: '$nullable',
                        dead: '$score',
                    },
                },
                { $unset: 'dead' },
                { $sort: { _id: 1 } },
            ];
        case 'adjacent-project-merging':
            return [
                { $match: filter },
                {
                    $project: {
                        status: 1,
                        score: 1,
                        marker: 1,
                        nullable: 1,
                        ordered: 1,
                    },
                },
                {
                    $project: {
                        status: 1,
                        nullable: 1,
                        ordered: 1,
                    },
                },
                { $sort: { _id: 1 } },
            ];
        case 'adjacent-add-field-merging':
            return [
                { $match: filter },
                { $addFields: { first: '$score' } },
                { $set: { second: '$nullable' } },
                { $sort: { _id: 1 } },
            ];
        case 'lookup-delay':
            return [
                {
                    $lookup: {
                        from: 'foreign',
                        localField: 'tenant',
                        foreignField: 'tenant',
                        as: 'joined',
                    },
                },
                { $match: filter },
                { $sort: { _id: 1 } },
            ];
        case 'redundant-lookup-elimination':
            return [
                {
                    $lookup: {
                        from: 'foreign',
                        localField: 'tenant',
                        foreignField: 'tenant',
                        as: 'joined',
                    },
                },
                {
                    $project: {
                        status: 1,
                        score: 1,
                        marker: 1,
                        tenant: 1,
                        nullable: 1,
                        ordered: 1,
                    },
                },
                { $match: filter },
                { $sort: { _id: 1 } },
            ];
        case 'sort-project-commute':
            return [
                { $match: filter },
                { $sort: { score: -1, _id: 1 } },
                {
                    $project: {
                        status: 1,
                        score: 1,
                        marker: 1,
                        tenant: 1,
                        nullable: 1,
                        ordered: 1,
                    },
                },
            ];
        case 'complex-projection-deferral':
            return [
                { $match: filter },
                { $addFields: { label: '$status' } },
                { $sort: { score: -1, _id: 1 } },
            ];
        case 'expr-match-normalization':
            return [
                { $match: { $expr: { $eq: ['$status', 'active'] } } },
                { $match: filter },
                { $sort: { _id: 1 } },
            ];
        case 'group-filter-pushdown':
            return [
                { $match: filter },
                {
                    $group: {
                        _id: '$tenant',
                        total: { $sum: 1 },
                    },
                },
                { $match: { _id: 'acme' } },
                { $sort: { _id: 1 } },
            ];
        case 'bucket-filter-pushdown':
            return [
                { $match: filter },
                {
                    $bucket: {
                        groupBy: '$score',
                        boundaries: [0, 50, 100],
                        default: 'other',
                        output: { count: { $sum: 1 } },
                    },
                },
                { $match: { _id: 0 } },
            ];
        case 'unwind-prefilter':
            return [
                { $match: filter },
                { $unwind: '$items' },
                { $match: { 'items.score': 10 } },
                { $sort: { _id: 1 } },
            ];
        case 'redundant-sort-elimination':
            return [
                { $match: filter },
                { $sort: { score: 1 } },
                { $sort: { score: -1, _id: 1 } },
            ];
        case 'sort-by-count-simplification':
            return [
                { $match: filter },
                {
                    $group: {
                        _id: '$tenant',
                        count: { $sum: 1 },
                    },
                },
                { $sort: { count: -1 } },
            ];
        case 'facet-prefix-hoisting':
            return [
                {
                    $facet: {
                        pipelineA: [
                            { $match: filter },
                            { $sort: { _id: 1 } },
                            { $limit: firstLimit },
                        ],
                        pipelineB: [
                            { $match: filter },
                            { $sort: { _id: 1 } },
                            { $limit: firstLimit + secondLimit },
                        ],
                    },
                },
            ];
        case 'add-field-pushdown':
            return [
                { $match: filter },
                {
                    $lookup: {
                        from: 'foreign',
                        localField: 'tenant',
                        foreignField: 'tenant',
                        as: 'foreignItems',
                    },
                },
                { $addFields: { computedScore: { $add: [ '$score', 1 ] } } },
                // Keep _id tie-breaker because generated documents have non-unique score values; removing $replaceWith only.
                { $sort: { computedScore: 1, _id: 1 } },
                { $limit: firstLimit },
            ];
        case 'top-k-pushdown':
            return [
                { $match: filter },
                { $addFields: { tag: 'active' } },
                { $sort: { score: -1, _id: 1 } },
                { $limit: firstLimit },
            ];
        default:
            throw new Error(`Generated interaction cannot use contained pass: ${id}`);
    }
}

function makeCollections(random: () => number): Readonly<Record<string, {
    readonly documents: readonly Document[];
}>>
{
    const activeScore = randomInteger(random, 4, 12);

    return {
        main: {
            documents: makeDocuments(random, activeScore),
        },
        foreign: {
            documents: makeDocuments(random, activeScore),
        },
        archive: {
            documents: makeDocuments(random, activeScore),
        },
    };
}

function makeNestedPipeline(
    childPipeline: readonly Document[],
    index: number,
    wrapperOffset: number,
): {
    readonly pipeline: readonly Document[];
    readonly observation: "ordered-bson" | "multiset";
}
{
    const hasFacet = childPipeline.some((stage) => "$facet" in stage);
    const choice = hasFacet
        ? ((index + wrapperOffset) % 2) + 1
        : (index + wrapperOffset) % 3;

    switch (choice)
    {
        case 0:
            return {
                pipeline: [
                    {
                        $facet: {
                            generated: childPipeline,
                        },
                    },
                ],
                observation: "ordered-bson",
            };
        case 1:
            return {
                pipeline: [
                    {
                        $lookup: {
                            from: "foreign",
                            pipeline: childPipeline,
                            as: "joined",
                        },
                    },
                    { $sort: { _id: 1 } },
                ],
                observation: "ordered-bson",
            };
        default:
            return {
                pipeline: [
                    {
                        $unionWith: {
                            coll: "archive",
                            pipeline: childPipeline,
                        },
                    },
                ],
                observation: "multiset",
            };
    }
}

export function generateInteractionSemanticCases(
    seed: number,
): readonly SemanticCase[]
{
    const random = seededRandom(seed);
    const cases: SemanticCase[] = [];
    const wrapperOffset = randomInteger(random, 0, 2);

    const emittedFilterIds = new Set<FilterRuleId>();
    for (const descriptor of interactionDescriptors)
    {
        if (emittedFilterIds.has(descriptor.filterId))
        {
            continue;
        }

        emittedFilterIds.add(descriptor.filterId);
        const collections = makeCollections(random);
        const score = collections.main.documents[0]!.score as number;

        cases.push({
            id: `u9-generated-filter-${descriptor.filterId}`,
            kind: "filter",
            mainCollectionId: "main",
            collections,
            filter: makeFilter(descriptor.filterId, score),
            options: {
                sort: { _id: 1 },
            },
            observation: "ordered-bson",
            affectedTransformationIds: [descriptor.filterId],
            expectedEquivalent: true,
        });
    }

    interactionDescriptors.forEach((descriptor, index) =>
    {
        const collections = makeCollections(random);
        const score = collections.main.documents[0]!.score as number;
        const filter = makeFilter(descriptor.filterId, score);
        const pipeline = makeInteractionPipeline(
            descriptor.pipelineId,
            filter,
            random,
        );

        cases.push({
            id: `u9-generated-top-level-${descriptor.pipelineId}`,
            kind: "pipeline",
            mainCollectionId: "main",
            collections,
            pipeline,
            observation: index === 1 ? "multiset" : "ordered-bson",
            affectedTransformationIds: [
                descriptor.pipelineId,
                descriptor.filterId,
            ],
            expectedEquivalent: true,
        });
    });

    interactionDescriptors.forEach((descriptor, index) =>
    {
        const collections = makeCollections(random);
        const score = collections.foreign.documents[0]!.score as number;
        const childPipeline = makeInteractionPipeline(
            descriptor.pipelineId,
            makeFilter(descriptor.filterId, score),
            random,
        );
        const nested = makeNestedPipeline(
            childPipeline,
            index,
            wrapperOffset,
        );

        cases.push({
            id: `u9-generated-nested-${descriptor.pipelineId}`,
            kind: "pipeline",
            mainCollectionId: "main",
            collections,
            pipeline: nested.pipeline,
            observation: nested.observation,
            affectedTransformationIds: [
                descriptor.pipelineId,
                descriptor.filterId,
            ],
            expectedEquivalent: true,
        });
    });

    if (cases.length !== GENERATED_INTERACTION_CASE_COUNT)
    {
        throw new Error(
            `Generated ${cases.length} interactions; expected ${GENERATED_INTERACTION_CASE_COUNT}`,
        );
    }

    return Object.freeze(cases);
}

export const generatedInteractionSemanticCases =
    generateInteractionSemanticCases(GENERATED_INTERACTION_SEED);
