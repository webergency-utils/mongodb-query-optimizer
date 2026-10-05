import {
    Decimal128,
    Int32,
    Long,
    ObjectId,
    type AggregateOptions,
    type Document,
    type FindOptions,
} from 'mongodb';
import type {
    LogicalCollectionFixture,
    ObservationMode,
} from '../helpers/mongodb-oracle.js';

interface SemanticCaseBase
{
    readonly id: string;
    readonly mainCollectionId: string;
    readonly collections: Readonly<Record<string, LogicalCollectionFixture>>;
    readonly observation: ObservationMode;
    readonly affectedTransformationIds: readonly string[];
}

export interface FilterSemanticCase extends SemanticCaseBase
{
    readonly kind: 'filter';
    readonly filter: Document;
    readonly options?: FindOptions;
    readonly candidateRuleIds?: readonly string[];
    readonly optimizedFilterOverride?: Document;
    readonly expectedEquivalent: boolean;
}

export interface PipelineSemanticCase extends SemanticCaseBase
{
    readonly kind: 'pipeline';
    readonly pipeline: readonly Document[];
    readonly options?: AggregateOptions;
    readonly candidateTransformationIds?: readonly string[];
    readonly candidateRuleIds?: readonly string[];
    readonly expectedEquivalent: boolean;
}

export type SemanticCase = FilterSemanticCase | PipelineSemanticCase;

const scalarDocuments: readonly Document[] = [
    { _id: 1, a: 1, status: 'active', tags: [1, 2], name: 'CAFE' },
    { _id: 2, a: 2, status: 'inactive', tags: [2, 3], name: 'cafe' },
    { _id: 3, status: 'active', tags: [1, 3], name: 'other' },
];

export const productionSemanticCases: readonly SemanticCase[] = [
    {
        id: 'filter-match-all-or-contained',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        filter: {
            $or: [{}, { a: 1 }],
        },
        options: {
            sort: { _id: 1 },
        },
        observation: 'ordered-bson',
        affectedTransformationIds: ['simplify-disjunction-identities'],
        expectedEquivalent: true,
    },
    {
        id: 'u4-filter-match-all-or-with-sibling',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        filter: {
            status: 'active',
            $or: [{}, { a: 2 }],
        },
        options: {
            sort: { _id: 1 },
        },
        observation: 'ordered-bson',
        affectedTransformationIds: ['simplify-disjunction-identities'],
        expectedEquivalent: true,
    },
    {
        id: 'filter-logical-field-order-contained',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        filter: {
            $and: [{ a: 1 }],
            a: 2,
        },
        options: {
            sort: { _id: 1 },
        },
        observation: 'ordered-bson',
        affectedTransformationIds: ['merge-conjunctions'],
        expectedEquivalent: true,
    },
    {
        id: 'u4-filter-field-logical-order',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        filter: {
            a: 2,
            $and: [{ a: 1 }],
        },
        options: {
            sort: { _id: 1 },
        },
        observation: 'ordered-bson',
        affectedTransformationIds: ['merge-conjunctions'],
        expectedEquivalent: true,
    },
    {
        id: 'filter-explicit-regex-equality-contained',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, value: /active/i },
                    { _id: 2, value: 'active' },
                ],
            },
        },
        filter: {
            value: {
                $eq: /active/i,
            },
        },
        options: {
            sort: { _id: 1 },
        },
        observation: 'ordered-bson',
        affectedTransformationIds: ['simplify-equality'],
        expectedEquivalent: true,
    },
    {
        id: 'u4-filter-explicit-operator-document-equality',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, value: { $gt: 1 } },
                    { _id: 2, value: 2 },
                    { _id: 3, value: { $gt: 2 } },
                ],
            },
        },
        filter: {
            value: {
                $eq: { $gt: 1 },
            },
        },
        options: {
            sort: { _id: 1 },
        },
        observation: 'ordered-bson',
        affectedTransformationIds: ['simplify-equality'],
        expectedEquivalent: true,
    },
    {
        id: 'u4-filter-explicit-bson-equality-barrier',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: new ObjectId('000000000000000000000001') },
                    { _id: new ObjectId('000000000000000000000002') },
                ],
            },
        },
        filter: {
            _id: {
                $eq: new ObjectId('000000000000000000000001'),
            },
        },
        observation: 'structural-barrier',
        affectedTransformationIds: ['simplify-equality'],
        expectedEquivalent: true,
    },
    {
        id: 'u4-filter-singleton-in-exotic-values',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    {
                        _id: 1,
                        regexValue: /active/i,
                        documentValue: { $gt: 1 },
                    },
                    {
                        _id: 2,
                        regexValue: 'active',
                        documentValue: 2,
                    },
                    {
                        _id: 3,
                        regexValue: /inactive/i,
                        documentValue: { $gt: 2 },
                    },
                ],
            },
        },
        filter: {
            $or: [
                { regexValue: { $in: [/active/i] } },
                { documentValue: { $in: [{ $gt: 1 }] } },
            ],
        },
        options: {
            sort: { _id: 1 },
        },
        observation: 'structural-barrier',
        affectedTransformationIds: ['simplify-singleton-in'],
        expectedEquivalent: true,
    },
    {
        id: 'filter-multikey-conjunction-contained',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        filter: {
            $and: [
                { tags: { $in: [1] } },
                { tags: { $in: [2] } },
            ],
        },
        options: {
            sort: { _id: 1 },
        },
        observation: 'ordered-bson',
        affectedTransformationIds: ['merge-conjunctions'],
        expectedEquivalent: true,
    },
    {
        id: 'u4-filter-distinct-regex-conjunction',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, value: 'alpha' },
                    { _id: 2, value: 'alphabet' },
                    { _id: 3, value: 'bet' },
                ],
            },
        },
        filter: {
            $and: [
                { value: /^a/ },
                { value: /bet$/ },
            ],
        },
        options: {
            sort: { _id: 1 },
        },
        observation: 'ordered-bson',
        affectedTransformationIds: ['deduplicate-conjunctions'],
        expectedEquivalent: true,
    },
    {
        id: 'u4-filter-multikey-embedded-document-order',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    {
                        _id: 1,
                        values: [
                            { first: 1, second: 2 },
                            { second: 2, first: 1 },
                        ],
                    },
                    {
                        _id: 2,
                        values: [
                            { first: 1, second: 2 },
                        ],
                    },
                ],
            },
        },
        filter: {
            $and: [
                { values: { $in: [{ first: 1, second: 2 }] } },
                { values: { $in: [{ second: 2, first: 1 }] } },
            ],
        },
        options: {
            sort: { _id: 1 },
        },
        observation: 'ordered-bson',
        affectedTransformationIds: [
            'deduplicate-conjunctions',
            'merge-conjunctions',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'u4-filter-valid-logical-flattening',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        filter: {
            $and: [
                { status: 'active' },
                {
                    $and: [
                        { tags: 1 },
                        { a: { $eq: 1 } },
                    ],
                },
            ],
        },
        options: {
            sort: { _id: 1 },
        },
        observation: 'ordered-bson',
        affectedTransformationIds: [
            'flatten-conjunctions',
            'simplify-equality',
            'merge-conjunctions',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'u4-filter-invalid-empty-and',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        filter: {
            $and: [],
        },
        observation: 'acceptance-error',
        affectedTransformationIds: [
            'flatten-conjunctions',
            'simplify-conjunction-identities',
            'merge-conjunctions',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'u4-filter-invalid-empty-or',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        filter: {
            $or: [],
        },
        observation: 'acceptance-error',
        affectedTransformationIds: [
            'flatten-disjunctions',
            'simplify-disjunction-identities',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'filter-collation-contained',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        filter: {
            name: {
                $eq: 'cafe',
            },
        },
        options: {
            sort: { _id: 1 },
            collation: {
                locale: 'en',
                strength: 1,
            },
        },
        observation: 'ordered-bson',
        affectedTransformationIds: ['simplify-equality'],
        expectedEquivalent: true,
    },
    {
        id: 'pipeline-write-remove-contained',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, a: 1 },
                    { _id: 2, a: 2 },
                ],
            },
        },
        pipeline: [
            { $addFields: { b: '$a' } },
            { $unset: 'b' },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: [
            'stage-priority-reorder',
            'unused-field-pruning',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'pipeline-lookup-multiplicity-contained',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, customerId: 'customer-1' },
                ],
            },
            orders: {
                documents: [
                    { _id: 10, customerId: 'customer-1', value: 1 },
                    { _id: 11, customerId: 'customer-1', value: 2 },
                ],
            },
        },
        pipeline: [
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
            { $unset: 'orders' },
        ],
        observation: 'multiset',
        affectedTransformationIds: ['redundant-lookup-elimination'],
        expectedEquivalent: true,
    },
    {
        id: 'pipeline-invalid-empty-logical-array-contained',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        pipeline: [
            {
                $match: {
                    $or: [],
                },
            },
        ],
        observation: 'acceptance-error',
        affectedTransformationIds: ['filter-optimization'],
        expectedEquivalent: true,
    },
    {
        id: 'u4-pipeline-top-level-filter-rules',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        pipeline: [
            { $match: { status: { $in: ['active'] } } },
            { $match: { a: { $eq: 1 } } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: [
            'filter-optimization',
            'adjacent-match-merging',
            'simplify-equality',
            'simplify-singleton-in',
            'merge-conjunctions',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'u4-pipeline-adjacent-multikey-matches',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        pipeline: [
            { $match: { tags: { $in: [1] } } },
            { $match: { tags: { $in: [2] } } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: [
            'adjacent-match-merging',
            'merge-conjunctions',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'u4-pipeline-nested-facet-filters',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        pipeline: [
            {
                $facet: {
                    selected: [
                        { $match: { status: { $in: ['active'] } } },
                        { $match: { a: { $eq: 1 } } },
                        { $sort: { _id: 1 } },
                    ],
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: [
            'filter-optimization',
            'adjacent-match-merging',
            'simplify-equality',
            'simplify-singleton-in',
            'merge-conjunctions',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'u4-pipeline-nested-lookup-filters',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, customerId: 'customer-1' },
                ],
            },
            orders: {
                documents: [
                    { _id: 10, paid: true, archived: false },
                    { _id: 11, paid: true, archived: true },
                    { _id: 12, paid: false, archived: false },
                ],
            },
        },
        pipeline: [
            {
                $lookup: {
                    from: 'orders',
                    pipeline: [
                        { $match: { paid: { $in: [true] } } },
                        { $match: { archived: { $eq: false } } },
                        { $sort: { _id: 1 } },
                    ],
                    as: 'orders',
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: [
            'filter-optimization',
            'adjacent-match-merging',
            'simplify-equality',
            'simplify-singleton-in',
            'merge-conjunctions',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'u4-pipeline-nested-union-filters',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, source: 'main' },
                ],
            },
            archive: {
                documents: [
                    { _id: 2, source: 'archive', active: true, region: 'eu' },
                    { _id: 3, source: 'archive', active: true, region: 'us' },
                    { _id: 4, source: 'archive', active: false, region: 'eu' },
                ],
            },
        },
        pipeline: [
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        { $match: { active: { $eq: true } } },
                        { $match: { region: { $in: ['eu'] } } },
                    ],
                },
            },
        ],
        observation: 'multiset',
        affectedTransformationIds: [
            'filter-optimization',
            'adjacent-match-merging',
            'simplify-equality',
            'simplify-singleton-in',
            'merge-conjunctions',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'u5-match-project-alias-top-level',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    {
                        _id: 1,
                        profile: { state: 'active' },
                        score: 8,
                        minimum: 5,
                    },
                    {
                        _id: 2,
                        profile: { state: 'inactive' },
                        score: 9,
                        minimum: 5,
                    },
                    {
                        _id: 3,
                        profile: { state: 'active' },
                        score: 3,
                        minimum: 5,
                    },
                ],
            },
        },
        pipeline: [
            {
                $project: {
                    state: '$profile.state',
                    score: 1,
                    minimum: 1,
                },
            },
            {
                $match: {
                    state: 'active',
                    $expr: {
                        $gt: ['$score', '$minimum'],
                    },
                },
            },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['match-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'u5-match-elemmatch-alias-top-level',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    {
                        _id: 1,
                        items: [
                            { status: 'active', score: 8 },
                            { status: 'inactive', score: 2 },
                        ],
                        rootStatus: 'inactive',
                    },
                    {
                        _id: 2,
                        items: [{ status: 'active', score: 3 }],
                        rootStatus: 'active',
                    },
                    {
                        _id: 3,
                        items: [{ status: 'inactive', score: 9 }],
                        rootStatus: 'active',
                    },
                ],
            },
        },
        pipeline: [
            {
                $project: {
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
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['match-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'u5-limit-passive-top-level',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, status: 'active', score: 30, unused: 'first' },
                    { _id: 2, status: 'inactive', score: 20, unused: 'second' },
                    { _id: 3, status: 'active', score: 10, unused: 'third' },
                ],
            },
        },
        pipeline: [
            { $sort: { score: -1 } },
            { $project: { _id: 1, status: 1, score: 1 } },
            { $set: { label: 'stable' } },
            { $unset: 'unused' },
            { $limit: 2 },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['limit-advance'],
        expectedEquivalent: true,
    },
    {
        id: 'u5-skip-passive-top-level',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, status: 'active', score: 30 },
                    { _id: 2, status: 'inactive', score: 20 },
                    { _id: 3, status: 'active', score: 10 },
                ],
            },
        },
        pipeline: [
            { $sort: { score: -1 } },
            { $project: { _id: 1, status: 1, score: 1 } },
            { $addFields: { stable: true } },
            { $skip: 1 },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['limit-advance'],
        expectedEquivalent: true,
    },
    {
        id: 'u5-match-parent-projection-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, profile: { name: 'Ada', age: 37 } },
                    { _id: 2, profile: { age: 20 } },
                    { _id: 3, other: true },
                ],
            },
        },
        pipeline: [
            { $project: { 'profile.name': 1 } },
            { $match: { profile: { $exists: true } } },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['match-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'u5-match-preserving-unwind-null-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, items: [] },
                    { _id: 2 },
                    { _id: 3, items: null },
                    { _id: 4, items: [{ status: 'active' }] },
                ],
            },
        },
        pipeline: [
            {
                $unwind: {
                    path: '$items',
                    preserveNullAndEmptyArrays: true,
                },
            },
            { $match: { items: null } },
            { $sort: { _id: 1 } },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['match-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'u5-match-lookup-provenance-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, status: 'active', customerId: 'customer-1' },
                    { _id: 2, status: 'inactive', customerId: 'customer-2' },
                ],
            },
            orders: {
                documents: [
                    { _id: 10, customerId: 'customer-1', total: 5 },
                    { _id: 11, customerId: 'customer-2', total: 9 },
                ],
            },
        },
        pipeline: [
            {
                $lookup: {
                    from: 'orders',
                    localField: 'customerId',
                    foreignField: 'customerId',
                    as: 'orders',
                },
            },
            { $match: { 'orders.total': 5 } },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['match-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'u5-limit-sort-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, score: 10 },
                    { _id: 2, score: 30 },
                    { _id: 3, score: 20 },
                ],
            },
        },
        pipeline: [
            { $sort: { score: -1 } },
            { $limit: 2 },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['limit-advance'],
        expectedEquivalent: true,
    },
    {
        id: 'u5-match-whole-document-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, name: 'Ada', hidden: 'removed' },
                    { _id: 2, name: 'Grace', hidden: 'removed' },
                ],
            },
        },
        pipeline: [
            { $project: { name: 1 } },
            {
                $match: {
                    $expr: {
                        $eq: [
                            '$$ROOT',
                            { _id: 1, name: 'Ada' },
                        ],
                    },
                },
            },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['match-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'u5-match-volatile-evaluation-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, status: 'active' },
                    { _id: 2, status: 'inactive' },
                ],
            },
        },
        pipeline: [
            { $set: { random: { $rand: {} } } },
            { $match: { status: 'active' } },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['match-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'u5-match-erroring-evaluation-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, status: 'active', divisor: 1 },
                    { _id: 2, status: 'inactive', divisor: 0 },
                ],
            },
        },
        pipeline: [
            { $set: { ratio: { $divide: [1, '$divisor'] } } },
            { $match: { status: 'active' } },
        ],
        observation: 'acceptance-error',
        affectedTransformationIds: ['match-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'u5-match-nested-facet-safe',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, status: 'active', hidden: 'first' },
                    { _id: 2, status: 'inactive', hidden: 'second' },
                    { _id: 3, status: 'active', hidden: 'third' },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    selected: [
                        { $project: { status: 1 } },
                        { $match: { status: 'active' } },
                        { $sort: { _id: 1 } },
                    ],
                    all: [
                        { $sort: { _id: 1 } },
                    ],
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['match-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'u5-limit-nested-lookup-safe',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, customerId: 'customer-1' },
                    { _id: 2, customerId: 'customer-2' },
                ],
            },
            orders: {
                documents: [
                    { _id: 10, customerId: 'customer-1', paid: true, amount: 30 },
                    { _id: 11, customerId: 'customer-1', paid: false, amount: 20 },
                    { _id: 12, customerId: 'customer-1', paid: true, amount: 10 },
                    { _id: 13, customerId: 'customer-2', paid: false, amount: 5 },
                ],
            },
        },
        pipeline: [
            {
                $lookup: {
                    from: 'orders',
                    let: { customerId: '$customerId' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $eq: ['$customerId', '$$customerId'],
                                },
                            },
                        },
                        { $sort: { amount: -1 } },
                        { $project: { _id: 1, paid: 1, amount: 1 } },
                        { $set: { stable: true } },
                        { $skip: 1 },
                    ],
                    as: 'orders',
                },
            },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['limit-advance'],
        expectedEquivalent: true,
    },
    {
        id: 'u5-match-nested-union-projection-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, profile: { name: 'main' } },
                ],
            },
            archive: {
                documents: [
                    { _id: 2, profile: { name: 'Ada', age: 37 } },
                    { _id: 3, profile: { age: 20 } },
                    { _id: 4, other: true },
                ],
            },
        },
        pipeline: [
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        { $project: { 'profile.name': 1 } },
                        { $match: { profile: { $exists: true } } },
                    ],
                },
            },
            { $sort: { _id: 1 } },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['match-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'u6-add-set-merge-top-level',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    {
                        _id: 1,
                        source: 'alpha',
                        optional: null,
                        status: 'active',
                    },
                    {
                        _id: 2,
                        source: null,
                        optional: 'present',
                        status: 'inactive',
                    },
                    {
                        _id: 3,
                        status: 'active',
                    },
                ],
            },
        },
        pipeline: [
            { $addFields: { copied: '$source' } },
            {
                $set: {
                    label: {
                        $ifNull: ['$optional', 'fallback'],
                    },
                },
            },
            { $match: { status: 'active' } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: [
            'adjacent-add-field-merging',
            'match-pushdown',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'u6-project-merge-inclusion-top-level',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, name: 'Ada', score: 9, secret: 'first' },
                    { _id: 2, name: null, score: 5, secret: 'second' },
                    { _id: 3, score: 1, secret: 'third' },
                ],
            },
        },
        pipeline: [
            { $project: { name: 1, score: true, _id: false } },
            { $project: { name: true } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['adjacent-project-merging'],
        expectedEquivalent: true,
    },
    {
        id: 'u6-project-merge-id-only',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, name: 'Ada', score: 9 },
                    { _id: 2, name: null, score: 5 },
                    { _id: 3, score: 1 },
                ],
            },
        },
        pipeline: [
            { $project: { name: 1, score: true } },
            { $project: { _id: true } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['adjacent-project-merging'],
        expectedEquivalent: true,
    },
    {
        id: 'u6-project-merge-exclusion-top-level',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    {
                        _id: 1,
                        name: 'Ada',
                        secret: 'first',
                        nullable: null,
                    },
                    {
                        _id: 2,
                        name: 'Grace',
                        transient: 'second',
                    },
                    {
                        _id: 3,
                        name: 'Linus',
                    },
                ],
            },
        },
        pipeline: [
            { $project: { secret: false } },
            { $project: { transient: 0 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['adjacent-project-merging'],
        expectedEquivalent: true,
    },
    {
        id: 'u6-dead-write-unset-top-level',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, source: 'alpha', status: 'active' },
                    { _id: 2, source: null, status: 'inactive' },
                    { _id: 3, status: 'active' },
                ],
            },
        },
        pipeline: [
            {
                $set: {
                    dead: '$source',
                    retained: {
                        $ifNull: ['$source', 'missing'],
                    },
                },
            },
            { $unset: 'dead' },
            { $match: { status: 'active' } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: [
            'unused-field-pruning',
            'match-pushdown',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'u6-dead-write-overwrite-top-level',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, source: 'old', replacement: 'new' },
                    { _id: 2, source: null, replacement: null },
                    { _id: 3, source: 'present' },
                ],
            },
        },
        pipeline: [
            { $addFields: { retained: true, dead: '$source' } },
            { $set: { dead: '$replacement' } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['unused-field-pruning'],
        expectedEquivalent: true,
    },
    {
        id: 'u6-nested-facet-safe-rewrites',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    {
                        _id: 1,
                        source: 'alpha',
                        optional: null,
                        status: 'active',
                    },
                    {
                        _id: 2,
                        source: null,
                        optional: 'present',
                        status: 'inactive',
                    },
                    {
                        _id: 3,
                        status: 'active',
                    },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    merged: [
                        { $addFields: { first: '$source' } },
                        { $set: { second: '$optional' } },
                    ],
                    projected: [
                        { $project: { status: 1, optional: true, _id: false } },
                        { $project: { status: true, _id: false } },
                    ],
                    pruned: [
                        {
                            $set: {
                                dead: '$source',
                                retained: '$optional',
                            },
                        },
                        { $unset: 'dead' },
                    ],
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: [
            'adjacent-add-field-merging',
            'adjacent-project-merging',
            'unused-field-pruning',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'u6-add-set-current-getfield-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, source: 'alpha' },
                    { _id: 2, source: null },
                    { _id: 3 },
                ],
            },
        },
        pipeline: [
            { $addFields: { prior: '$source' } },
            { $set: { observed: { $getField: 'prior' } } },
            { $sort: { _id: 1 } },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['adjacent-add-field-merging'],
        expectedEquivalent: true,
    },
    {
        id: 'u6-project-resurrection-empty-output-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, retained: 'yes', omitted: 'first' },
                    { _id: 2, retained: null },
                    { _id: 3, omitted: null },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    resurrection: [
                        { $project: { retained: 1 } },
                        { $project: { omitted: 1 } },
                    ],
                    emptyOutput: [
                        { $project: { retained: 1, _id: 0 } },
                        { $project: { retained: 0 } },
                    ],
                    nestedExclusion: [
                        { $project: { 'profile.secret': 0 } },
                        { $project: { 'profile.transient': 0 } },
                    ],
                },
            },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['adjacent-project-merging'],
        expectedEquivalent: true,
    },
    {
        id: 'u6-volatile-dead-write-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, status: 'active' },
                    { _id: 2, status: 'inactive' },
                    { _id: 3 },
                ],
            },
        },
        pipeline: [
            { $set: { dead: { $rand: {} } } },
            { $unset: 'dead' },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['unused-field-pruning'],
        expectedEquivalent: true,
    },
    {
        id: 'u6-erroring-dead-write-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, divisor: 1 },
                    { _id: 2, divisor: 0 },
                    { _id: 3, divisor: null },
                ],
            },
        },
        pipeline: [
            { $set: { dead: { $divide: [1, '$divisor'] } } },
            { $unset: 'dead' },
        ],
        observation: 'acceptance-error',
        affectedTransformationIds: ['unused-field-pruning'],
        expectedEquivalent: true,
    },
    {
        id: 'u6-nested-evaluation-barriers',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    {
                        _id: 1,
                        source: 'alpha',
                        profile: { name: 'Ada', secret: 'hidden' },
                    },
                    {
                        _id: 2,
                        source: null,
                        profile: null,
                    },
                    { _id: 3 },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    wholeDocumentRead: [
                        { $addFields: { prior: '$source' } },
                        { $set: { snapshot: '$$ROOT' } },
                    ],
                    getFieldDeadWrite: [
                        { $set: { dead: { $getField: 'source' } } },
                        { $unset: 'dead' },
                    ],
                    dottedProject: [
                        { $project: { 'profile.name': 1 } },
                        { $project: { 'profile.name': 1 } },
                    ],
                },
            },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: [
            'adjacent-add-field-merging',
            'adjacent-project-merging',
            'unused-field-pruning',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'u6-dead-write-inclusion-project-top-level',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, name: 'Ada', source: 'alpha', score: 2 },
                    { _id: 2, name: 'Grace', source: null, score: 1 },
                    { _id: 3, name: 'Linus', score: 3 },
                ],
            },
        },
        pipeline: [
            {
                $addFields: {
                    dead: '$source',
                    retained: '$name',
                },
            },
            { $project: { _id: 1, name: 1, score: 1, retained: 1 } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['unused-field-pruning'],
        expectedEquivalent: true,
    },
    {
        id: 'u6-dead-write-transparent-suffix-unset',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, name: 'Ada', source: 'alpha', score: 2, temporary: 'keep' },
                    { _id: 2, name: 'Grace', source: null, score: 1, temporary: 'drop' },
                    { _id: 3, name: 'Linus', score: 3 },
                ],
            },
        },
        pipeline: [
            {
                $set: {
                    dead: '$source',
                    retained: '$name',
                },
            },
            { $unset: 'temporary' },
            { $sort: { score: -1, _id: 1 } },
            { $unset: 'dead' },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['unused-field-pruning'],
        expectedEquivalent: true,
    },
    {
        id: 'u5-sort-project-retained-keys',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, name: 'Charlie', age: 30, hidden: 'first' },
                    { _id: 2, name: 'Alice', age: 20, hidden: 'second' },
                    { _id: 3, name: 'Bob', age: 25 },
                ],
            },
        },
        pipeline: [
            { $sort: { age: 1 } },
            { $project: { name: 1, age: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['sort-project-commute'],
        expectedEquivalent: true,
    },
    {
        id: 'u6-add-field-deferral-sort',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, name: 'Ada', source: 'alpha', score: 2 },
                    { _id: 2, name: 'Grace', source: null, score: 1 },
                    { _id: 3, name: 'Linus', score: 3 },
                ],
            },
        },
        pipeline: [
            { $addFields: { label: '$name' } },
            { $sort: { score: -1, _id: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['complex-projection-deferral'],
        expectedEquivalent: true,
    },
    // Lookup delay assumes the join itself does not error. It may move past
    // match, sort, limit, and skip when those stages do not read the alias.
    {
        id: 'u7-lookup-delay-sort-unset-resource-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    {
                        _id: 1,
                        orders: 'stale-zero',
                        customerId: 'customer-zero',
                        status: 'active',
                        score: 30,
                        temporary: 'remove',
                    },
                    {
                        _id: 2,
                        orders: 'stale-one',
                        customerId: 'customer-one',
                        status: 'active',
                        score: 20,
                        temporary: 'remove',
                    },
                    {
                        _id: 3,
                        orders: 'stale-many',
                        customerId: 'customer-many',
                        status: 'active',
                        score: 10,
                        temporary: 'remove',
                    },
                    {
                        _id: 4,
                        orders: 'stale-filtered',
                        customerId: 'customer-many',
                        status: 'inactive',
                        score: 40,
                        temporary: 'remove',
                    },
                ],
            },
            orders: {
                documents: [
                    { _id: 10, customerId: 'customer-one', total: 5 },
                    { _id: 20, customerId: 'customer-many', total: 7 },
                    { _id: 21, customerId: 'customer-many', total: 9 },
                ],
            },
        },
        pipeline: [
            {
                $lookup: {
                    from: 'orders',
                    localField: 'customerId',
                    foreignField: 'customerId',
                    as: 'orders',
                },
            },
            { $sort: { score: -1 } },
            { $unset: 'temporary' },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['lookup-delay'],
        expectedEquivalent: true,
    },
    {
        id: 'u7-lookup-delay-match-error-timing-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    {
                        _id: 1,
                        customerId: 'customer-one',
                        status: 'active',
                    },
                    {
                        _id: 2,
                        customerId: 'customer-many',
                        status: 'inactive',
                    },
                ],
            },
            orders: {
                documents: [
                    { _id: 10, customerId: 'customer-one', total: 5 },
                    { _id: 20, customerId: 'customer-many', total: 7 },
                    { _id: 21, customerId: 'customer-many', total: 9 },
                ],
            },
        },
        pipeline: [
            {
                $lookup: {
                    from: 'orders',
                    localField: 'customerId',
                    foreignField: 'customerId',
                    as: 'orders',
                },
            },
            { $match: { status: 'active' } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['lookup-delay'],
        expectedEquivalent: true,
    },
    {
        id: 'u7-lookup-delay-limit-error-timing-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, customerId: 'customer-one' },
                    { _id: 2, customerId: 'customer-many' },
                ],
            },
            orders: {
                documents: [
                    { _id: 10, customerId: 'customer-one', total: 5 },
                    { _id: 20, customerId: 'customer-many', total: 7 },
                    { _id: 21, customerId: 'customer-many', total: 9 },
                ],
            },
        },
        pipeline: [
            {
                $lookup: {
                    from: 'orders',
                    localField: 'customerId',
                    foreignField: 'customerId',
                    as: 'orders',
                },
            },
            { $limit: 1 },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['lookup-delay'],
        expectedEquivalent: true,
    },
    {
        id: 'u7-lookup-delay-skip-error-timing-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, customerId: 'customer-one' },
                    { _id: 2, customerId: 'customer-many' },
                ],
            },
            orders: {
                documents: [
                    { _id: 10, customerId: 'customer-one', total: 5 },
                    { _id: 20, customerId: 'customer-many', total: 7 },
                    { _id: 21, customerId: 'customer-many', total: 9 },
                ],
            },
        },
        pipeline: [
            {
                $lookup: {
                    from: 'orders',
                    localField: 'customerId',
                    foreignField: 'customerId',
                    as: 'orders',
                },
            },
            { $skip: 1 },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['lookup-delay'],
        expectedEquivalent: true,
    },
    {
        id: 'u7-lookup-delay-inclusion-project-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, customerId: 'customer-one', name: 'Ada' },
                    { _id: 2, customerId: 'customer-zero', name: 'Grace' },
                ],
            },
            orders: {
                documents: [
                    { _id: 10, customerId: 'customer-one', total: 5 },
                ],
            },
        },
        pipeline: [
            {
                $lookup: {
                    from: 'orders',
                    localField: 'customerId',
                    foreignField: 'customerId',
                    as: 'orders',
                },
            },
            { $project: { _id: 0, name: 1, orders: 1 } },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['lookup-delay'],
        expectedEquivalent: true,
    },
    {
        id: 'u7-graph-lookup-delay-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    {
                        _id: 'employee-one',
                        managerId: 'employee-two',
                        name: 'One',
                    },
                    {
                        _id: 'employee-two',
                        managerId: null,
                        name: 'Two',
                    },
                ],
            },
            employees: {
                documents: [
                    {
                        _id: 'employee-one',
                        managerId: 'employee-two',
                        active: true,
                    },
                    {
                        _id: 'employee-two',
                        managerId: null,
                        active: true,
                    },
                ],
            },
        },
        pipeline: [
            {
                $graphLookup: {
                    from: 'employees',
                    startWith: '$managerId',
                    connectFromField: 'managerId',
                    connectToField: '_id',
                    restrictSearchWithMatch: { active: true },
                    as: 'reports',
                    depthField: 'depth',
                },
            },
            { $limit: 1 },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['lookup-delay'],
        expectedEquivalent: true,
    },
    {
        id: 'u7-lookup-delay-nested-resource-barriers',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    {
                        _id: 1,
                        customerId: 'customer-one',
                        active: true,
                        score: 20,
                    },
                    {
                        _id: 2,
                        customerId: 'customer-many',
                        active: false,
                        score: 10,
                    },
                ],
            },
            accounts: {
                documents: [
                    {
                        _id: 100,
                        customerId: 'customer-one',
                        active: true,
                    },
                    {
                        _id: 101,
                        customerId: 'customer-zero',
                        active: false,
                    },
                ],
            },
            archive: {
                documents: [
                    {
                        _id: 200,
                        customerId: 'customer-many',
                        score: 30,
                    },
                    {
                        _id: 201,
                        customerId: 'customer-zero',
                        score: 5,
                    },
                ],
            },
            orders: {
                documents: [
                    { _id: 10, customerId: 'customer-one', total: 5 },
                    { _id: 20, customerId: 'customer-many', total: 7 },
                    { _id: 21, customerId: 'customer-many', total: 9 },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    facetChild: [
                        {
                            $lookup: {
                                from: 'orders',
                                localField: 'customerId',
                                foreignField: 'customerId',
                                as: 'joined',
                            },
                        },
                        { $sort: { score: -1 } },
                    ],
                    lookupChild: [
                        {
                            $lookup: {
                                from: 'accounts',
                                pipeline: [
                                    {
                                        $lookup: {
                                            from: 'orders',
                                            localField: 'customerId',
                                            foreignField: 'customerId',
                                            as: 'joined',
                                        },
                                    },
                                    { $unset: 'temporary' },
                                ],
                                as: 'accounts',
                            },
                        },
                    ],
                    unionChild: [
                        {
                            $unionWith: {
                                coll: 'archive',
                                pipeline: [
                                    {
                                        $lookup: {
                                            from: 'orders',
                                            localField: 'customerId',
                                            foreignField: 'customerId',
                                            as: 'joined',
                                        },
                                    },
                                    { $sort: { score: -1 } },
                                ],
                            },
                        },
                    ],
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['lookup-delay'],
        expectedEquivalent: true,
    },
    {
        id: 'u7-lookup-delay-nested-barriers',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    {
                        _id: 1,
                        customerId: 'customer-many',
                        managerId: 'employee-two',
                        name: 'Ada',
                    },
                ],
            },
            orders: {
                documents: [
                    { _id: 20, customerId: 'customer-many', total: 7 },
                    { _id: 21, customerId: 'customer-many', total: 9 },
                ],
            },
            employees: {
                documents: [
                    {
                        _id: 'employee-two',
                        managerId: null,
                        active: true,
                    },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    aliasConsumer: [
                        {
                            $lookup: {
                                from: 'orders',
                                localField: 'customerId',
                                foreignField: 'customerId',
                                as: 'joined',
                            },
                        },
                        { $match: { 'joined.total': { $gt: 0 } } },
                    ],
                    errorTimingMatch: [
                        {
                            $lookup: {
                                from: 'orders',
                                localField: 'customerId',
                                foreignField: 'customerId',
                                as: 'joined',
                            },
                        },
                        { $match: { name: 'Ada' } },
                    ],
                    errorTimingLimit: [
                        {
                            $lookup: {
                                from: 'orders',
                                localField: 'customerId',
                                foreignField: 'customerId',
                                as: 'joined',
                            },
                        },
                        { $limit: 1 },
                    ],
                    errorTimingSkip: [
                        {
                            $lookup: {
                                from: 'orders',
                                localField: 'customerId',
                                foreignField: 'customerId',
                                as: 'joined',
                            },
                        },
                        { $skip: 1 },
                    ],
                    inclusionProject: [
                        {
                            $lookup: {
                                from: 'orders',
                                localField: 'customerId',
                                foreignField: 'customerId',
                                as: 'joined',
                            },
                        },
                        { $project: { name: 1, joined: 1 } },
                    ],
                    preservingUnwind: [
                        {
                            $lookup: {
                                from: 'orders',
                                localField: 'customerId',
                                foreignField: 'customerId',
                                as: 'joined',
                            },
                        },
                        {
                            $unwind: {
                                path: '$joined',
                                preserveNullAndEmptyArrays: true,
                            },
                        },
                        { $unset: 'joined' },
                    ],
                    graphLookup: [
                        {
                            $graphLookup: {
                                from: 'employees',
                                startWith: '$managerId',
                                connectFromField: 'managerId',
                                connectToField: '_id',
                                as: 'reports',
                                depthField: 'depth',
                            },
                        },
                        { $limit: 1 },
                    ],
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: [
            'lookup-delay',
            'redundant-lookup-elimination',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'u7-redundant-lookup-discarded-project',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, customerId: 'customer-one', name: 'Ada' },
                    { _id: 2, customerId: 'customer-zero', name: 'Grace' },
                    { _id: 3, customerId: 'customer-many', name: 'Linus' },
                ],
            },
            orders: {
                documents: [
                    { _id: 10, customerId: 'customer-one', total: 5 },
                    { _id: 20, customerId: 'customer-many', total: 7 },
                    { _id: 21, customerId: 'customer-many', total: 9 },
                ],
            },
        },
        pipeline: [
            {
                $lookup: {
                    from: 'orders',
                    localField: 'customerId',
                    foreignField: 'customerId',
                    as: 'orders',
                },
            },
            { $project: { _id: 0, name: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['redundant-lookup-elimination'],
        expectedEquivalent: true,
    },
    {
        id: 'u9-expression-add-match-type-error-barrier-top-level',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, untyped: 'not-a-number', status: 'inactive' },
                    { _id: 2, untyped: 2, status: 'active' },
                ],
            },
        },
        pipeline: [
            { $set: { computed: { $add: ['$untyped', 1] } } },
            { $match: { status: 'active' } },
        ],
        observation: 'acceptance-error',
        affectedTransformationIds: ['match-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'u9-expression-add-skip-type-error-barrier-top-level',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, untyped: 'not-a-number' },
                    { _id: 2, untyped: 2 },
                ],
            },
        },
        pipeline: [
            { $set: { computed: { $add: ['$untyped', 1] } } },
            { $skip: 1 },
        ],
        observation: 'acceptance-error',
        affectedTransformationIds: ['limit-advance'],
        expectedEquivalent: true,
    },
    {
        id: 'u9-expression-add-match-type-error-barrier-nested',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, untyped: 'not-a-number', status: 'inactive' },
                    { _id: 2, untyped: 2, status: 'active' },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    selected: [
                        { $set: { computed: { $add: ['$untyped', 1] } } },
                        { $match: { status: 'active' } },
                    ],
                },
            },
        ],
        observation: 'acceptance-error',
        affectedTransformationIds: ['match-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'u9-expression-add-dead-write-type-error-barrier-nested',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, untyped: 'not-a-number' },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    selected: [
                        { $set: { dead: { $add: ['$untyped', 1] } } },
                        { $unset: 'dead' },
                    ],
                },
            },
        ],
        observation: 'acceptance-error',
        affectedTransformationIds: ['unused-field-pruning'],
        expectedEquivalent: true,
    },
    {
        id: 'u9-dead-write-add-type-error-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, source: 2 },
                    { _id: 2, source: 'not-a-number' },
                    { _id: 3 },
                ],
            },
        },
        pipeline: [
            { $set: { dead: { $add: ['$source', 1] } } },
            { $unset: 'dead' },
        ],
        observation: 'acceptance-error',
        affectedTransformationIds: ['unused-field-pruning'],
        expectedEquivalent: true,
    },
    {
        id: 'u9-dead-write-overwrite-dependency-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, source: 'alpha' },
                    { _id: 2, source: null },
                    { _id: 3 },
                ],
            },
        },
        pipeline: [
            { $set: { retained: true, dead: '$source' } },
            { $set: { snapshot: '$dead', dead: 'replacement' } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: [
            'unused-field-pruning',
            'complex-projection-deferral',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'u9-dead-write-overwrite-field-order',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, source: 'alpha' },
                    { _id: 2, source: null },
                    { _id: 3 },
                ],
            },
        },
        pipeline: [
            { $set: { retained: 0, first: 1, second: 2 } },
            { $set: { first: 3, second: 4, final: 5 } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['unused-field-pruning'],
        expectedEquivalent: true,
    },
    {
        id: 'u9-limit-skip-safe-top-level',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, nullable: null, ordered: { first: 1, second: 2 } },
                    { _id: 2, nullable: 'present', ordered: { first: 2, second: 1 } },
                    { _id: 3, ordered: { first: 3, second: 3 } },
                    { _id: 4, nullable: null, ordered: { first: 4, second: 4 } },
                ],
            },
        },
        pipeline: [
            { $sort: { _id: 1 } },
            { $skip: 0 },
            { $skip: 1 },
            { $limit: 3 },
            { $limit: 2 },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['limit-skip-coalescing'],
        expectedEquivalent: true,
    },
    {
        id: 'u9-limit-skip-safe-nested',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, nullable: null },
                    { _id: 2 },
                ],
            },
            foreign: {
                documents: [
                    { _id: 10, nullable: null },
                    { _id: 11 },
                    { _id: 12, nullable: 'present' },
                ],
            },
            archive: {
                documents: [
                    { _id: 20, nullable: null },
                    { _id: 21 },
                    { _id: 22, nullable: 'present' },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    limited: [
                        { $sort: { _id: 1 } },
                        { $limit: 3 },
                        { $limit: 2 },
                    ],
                },
            },
            {
                $lookup: {
                    from: 'foreign',
                    pipeline: [
                        { $sort: { _id: 1 } },
                        { $skip: 0 },
                        { $skip: 1 },
                    ],
                    as: 'joined',
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        { $limit: 3 },
                        { $limit: 1 },
                    ],
                },
            },
        ],
        observation: 'multiset',
        affectedTransformationIds: ['limit-skip-coalescing'],
        expectedEquivalent: true,
    },
    {
        id: 'u9-limit-skip-preservation-barriers',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, nullable: null },
                    { _id: 2 },
                ],
            },
        },
        pipeline: [
            { $sort: { _id: 1 } },
            { $skip: Number.MAX_SAFE_INTEGER },
            { $skip: 1 },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['limit-skip-coalescing'],
        expectedEquivalent: true,
    },
    {
        id: 'u9-limit-skip-invalid-value-barriers',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1 },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    stringLimit: [{ $limit: '2' }, { $limit: 1 }],
                    zeroLimit: [{ $limit: 0 }, { $limit: 1 }],
                    fractionalLimit: [{ $limit: 1.5 }, { $limit: 1 }],
                    negativeLimit: [{ $limit: -1 }, { $limit: 1 }],
                    nonfiniteLimit: [
                        { $limit: Number.POSITIVE_INFINITY },
                        { $limit: 1 },
                    ],
                    bigintLimit: [{ $limit: 2n }, { $limit: 1 }],
                    longLimit: [{ $limit: Long.fromNumber(2) }, { $limit: 1 }],
                    decimalLimit: [
                        { $limit: Decimal128.fromString('2') },
                        { $limit: 1 },
                    ],
                    int32Skip: [{ $skip: new Int32(2) }, { $skip: 1 }],
                    malformed: [
                        { $limit: 2, $skip: 1 },
                        { $limit: 1 },
                    ],
                },
            },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['limit-skip-coalescing'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-expr-match-normalization-focused',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, score: 100 },
                    { _id: 2, score: 50 },
                ],
            },
        },
        pipeline: [
            { $match: { $expr: { $eq: ['$score', 100] } } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['expr-match-normalization'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-expr-match-normalization-interaction',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, score: 100, active: true },
                    { _id: 2, score: 100, active: false },
                ],
            },
        },
        pipeline: [
            { $match: { active: true } },
            { $match: { $expr: { $eq: ['$score', 100] } } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['expr-match-normalization'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-expr-match-normalization-nested',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, score: 100 },
                    { _id: 2, score: 50 },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    scores: [{ $match: { $expr: { $eq: ['$score', 100] } } }],
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['expr-match-normalization'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-expr-match-normalization-oracle',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, score: 100 },
                    { _id: 2, score: 50 },
                ],
            },
        },
        pipeline: [
            { $match: { $expr: { $gt: ['$score', 75] } } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['expr-match-normalization'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-group-filter-pushdown-focused',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, dept: 'Sales', amount: 10 },
                    { _id: 2, dept: 'Eng', amount: 20 },
                ],
            },
        },
        pipeline: [
            { $group: { _id: '$dept', total: { $sum: '$amount' } } },
            { $match: { _id: 'Sales' } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['group-filter-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-group-filter-pushdown-interaction',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, dept: 'Sales', amount: 10 },
                    { _id: 2, dept: 'Sales', amount: 5 },
                    { _id: 3, dept: 'Eng', amount: 20 },
                ],
            },
        },
        pipeline: [
            { $group: { _id: '$dept', total: { $sum: '$amount' } } },
            { $match: { _id: 'Sales', total: { $gt: 12 } } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['group-filter-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-group-filter-pushdown-nested',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, dept: 'Sales', amount: 10 },
                    { _id: 2, dept: 'Eng', amount: 20 },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    sales: [
                        { $group: { _id: '$dept', total: { $sum: '$amount' } } },
                        { $match: { _id: 'Sales' } },
                    ],
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['group-filter-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-group-filter-pushdown-oracle',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, dept: 'Sales', amount: 10 },
                    { _id: 2, dept: 'Eng', amount: 20 },
                ],
            },
        },
        pipeline: [
            { $group: { _id: '$dept', total: { $sum: '$amount' } } },
            { $match: { _id: 'Sales' } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['group-filter-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-unwind-prefilter-focused',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, items: [{ qty: 10 }, { qty: 2 }] },
                    { _id: 2, items: [{ qty: 1 }] },
                ],
            },
        },
        pipeline: [
            { $unwind: '$items' },
            { $match: { 'items.qty': { $gt: 5 } } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['unwind-prefilter'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-unwind-prefilter-interaction',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, active: true, items: [{ qty: 10 }] },
                    { _id: 2, active: false, items: [{ qty: 10 }] },
                ],
            },
        },
        pipeline: [
            { $match: { active: true } },
            { $unwind: '$items' },
            { $match: { 'items.qty': { $gt: 5 } } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['unwind-prefilter'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-unwind-prefilter-nested',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, items: [{ qty: 10 }] },
                    { _id: 2, items: [{ qty: 2 }] },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    highQty: [
                        { $unwind: '$items' },
                        { $match: { 'items.qty': { $gt: 5 } } },
                    ],
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['unwind-prefilter'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-unwind-prefilter-oracle',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, items: [{ qty: 10 }] },
                    { _id: 2, items: [{ qty: 2 }] },
                ],
            },
        },
        pipeline: [
            { $unwind: '$items' },
            { $match: { 'items.qty': { $gt: 5 } } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['unwind-prefilter'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-facet-prefix-hoisting-focused',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, status: 'active', score: 10 },
                    { _id: 2, status: 'pending', score: 20 },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    topScores: [
                        { $match: { status: 'active' } },
                        { $sort: { score: -1 } },
                    ],
                    total: [
                        { $match: { status: 'active' } },
                        { $count: 'count' },
                    ],
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['facet-prefix-hoisting'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-facet-prefix-hoisting-interaction',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, status: 'active', orgId: '123' },
                    { _id: 2, status: 'active', orgId: '456' },
                ],
            },
        },
        pipeline: [
            { $match: { orgId: '123' } },
            {
                $facet: {
                    branchA: [
                        { $match: { status: 'active' } },
                        { $limit: 1 },
                    ],
                    branchB: [
                        { $match: { status: 'active' } },
                        { $count: 'c' },
                    ],
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['facet-prefix-hoisting'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-facet-prefix-hoisting-nested',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, status: 'active' },
                    { _id: 2, status: 'pending' },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    outer: [
                        {
                            $facet: {
                                inner1: [{ $match: { status: 'active' } }, { $limit: 1 }],
                                inner2: [{ $match: { status: 'active' } }, { $count: 'c' }],
                            },
                        },
                    ],
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['facet-prefix-hoisting'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-facet-prefix-hoisting-oracle',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, status: 'active', score: 10 },
                    { _id: 2, status: 'pending', score: 20 },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    topScores: [
                        { $match: { status: 'active' } },
                        { $sort: { score: -1 } },
                    ],
                    total: [
                        { $match: { status: 'active' } },
                        { $count: 'count' },
                    ],
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['facet-prefix-hoisting'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-bucket-filter-pushdown-focused',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, year: 1995, score: 80 },
                    { _id: 2, year: 2005, score: 90 },
                    { _id: 3, year: 2015, score: 70 },
                ],
            },
        },
        pipeline: [
            {
                $bucket: {
                    groupBy: '$year',
                    boundaries: [1990, 2000, 2010, 2020],
                    default: 'other',
                    output: { count: { $sum: 1 } },
                },
            },
            { $match: { _id: 1990 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['bucket-filter-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-bucket-filter-pushdown-interaction',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, year: 1995, score: 80 },
                    { _id: 2, year: 1998, score: 60 },
                    { _id: 3, year: 2005, score: 90 },
                ],
            },
        },
        pipeline: [
            {
                $bucket: {
                    groupBy: '$year',
                    boundaries: [1990, 2000, 2010, 2020],
                    default: 'other',
                    output: { count: { $sum: 1 } },
                },
            },
            { $match: { _id: 1990, count: { $gte: 2 } } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['bucket-filter-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-bucket-filter-pushdown-nested',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, year: 1995 },
                    { _id: 2, year: 2005 },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    nineties: [
                        {
                            $bucket: {
                                groupBy: '$year',
                                boundaries: [1990, 2000, 2010],
                                default: 'other',
                                output: { count: { $sum: 1 } },
                            },
                        },
                        { $match: { _id: 1990 } },
                    ],
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['bucket-filter-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-bucket-filter-pushdown-oracle',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, year: 1995, score: 80 },
                    { _id: 2, year: 2005, score: 90 },
                    { _id: 3, year: 2015, score: 70 },
                ],
            },
        },
        pipeline: [
            {
                $bucket: {
                    groupBy: '$year',
                    boundaries: [1990, 2000, 2010, 2020],
                    default: 'other',
                    output: { count: { $sum: 1 } },
                },
            },
            { $match: { _id: 1990 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['bucket-filter-pushdown'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-redundant-sort-elimination-focused',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, a: 10, b: 2 },
                    { _id: 2, a: 5, b: 1 },
                    { _id: 3, a: 20, b: 3 },
                ],
            },
        },
        pipeline: [
            { $sort: { a: 1 } },
            { $sort: { b: -1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['redundant-sort-elimination'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-redundant-sort-elimination-interaction',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, dept: 'Sales', val: 10 },
                    { _id: 2, dept: 'Sales', val: 20 },
                    { _id: 3, dept: 'Eng', val: 30 },
                ],
            },
        },
        pipeline: [
            { $sort: { val: -1 } },
            { $group: { _id: '$dept', total: { $sum: '$val' } } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['redundant-sort-elimination'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-redundant-sort-elimination-nested',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, a: 1, b: 2 },
                    { _id: 2, a: 2, b: 1 },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    sorted: [
                        { $sort: { a: 1 } },
                        { $sort: { b: 1 } },
                    ],
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['redundant-sort-elimination'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-redundant-sort-elimination-oracle',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, a: 10, b: 2 },
                    { _id: 2, a: 5, b: 1 },
                ],
            },
        },
        pipeline: [
            { $sort: { a: 1 } },
            { $sort: { b: -1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['redundant-sort-elimination'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-sort-by-count-simplification-focused',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, tag: 'tech' },
                    { _id: 2, tag: 'news' },
                    { _id: 3, tag: 'tech' },
                ],
            },
        },
        pipeline: [
            { $group: { _id: '$tag', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['sort-by-count-simplification'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-sort-by-count-simplification-interaction',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, tag: 'tech', score: 10 },
                    { _id: 2, tag: 'news', score: 20 },
                    { _id: 3, tag: 'tech', score: 30 },
                ],
            },
        },
        pipeline: [
            { $sort: { score: 1 } },
            { $group: { _id: '$tag', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: [
            'redundant-sort-elimination',
            'sort-by-count-simplification',
        ],
        expectedEquivalent: true,
    },
    {
        id: 'feat-sort-by-count-simplification-nested',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, tag: 'tech' },
                    { _id: 2, tag: 'news' },
                ],
            },
        },
        pipeline: [
            {
                $facet: {
                    tagCounts: [
                        { $group: { _id: '$tag', count: { $sum: 1 } } },
                        { $sort: { count: -1 } },
                    ],
                },
            },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['sort-by-count-simplification'],
        expectedEquivalent: true,
    },
    {
        id: 'feat-sort-by-count-simplification-oracle',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, tag: 'tech' },
                    { _id: 2, tag: 'news' },
                    { _id: 3, tag: 'tech' },
                ],
            },
        },
        pipeline: [
            { $group: { _id: '$tag', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: ['sort-by-count-simplification'],
        expectedEquivalent: true,
    },
];

export const candidateSemanticCases: readonly SemanticCase[] = [
    {
        id: 'u4-candidate-filter-match-all-or',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        filter: {
            $or: [{}, { a: 1 }],
        },
        options: {
            sort: { _id: 1 },
        },
        observation: 'ordered-bson',
        affectedTransformationIds: ['simplify-disjunction-identities'],
        candidateRuleIds: ['simplify-disjunction-identities'],
        expectedEquivalent: true,
    },
    {
        id: 'u4-candidate-filter-multikey-merge-barrier',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        filter: {
            $and: [
                { tags: { $in: [1] } },
                { tags: { $in: [2] } },
            ],
        },
        options: {
            sort: { _id: 1 },
        },
        observation: 'ordered-bson',
        affectedTransformationIds: ['merge-conjunctions'],
        candidateRuleIds: ['merge-conjunctions'],
        expectedEquivalent: true,
    },
    {
        id: 'u4-candidate-pipeline-adjacent-match',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        pipeline: [
            { $match: { status: 'active' } },
            { $match: { a: 1 } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        affectedTransformationIds: [
            'adjacent-match-merging',
            'merge-conjunctions',
        ],
        candidateTransformationIds: ['adjacent-match-merging'],
        candidateRuleIds: ['merge-conjunctions'],
        expectedEquivalent: true,
    },
    {
        id: 'u6-candidate-complex-deferral-unset-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, source: 2, score: 30 },
                    { _id: 2, source: null, score: 20 },
                    { _id: 3, score: 10 },
                ],
            },
        },
        pipeline: [
            { $set: { computed: { $add: ['$source', 1] } } },
            { $unset: 'source' },
            { $sort: { score: -1 } },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['complex-projection-deferral'],
        candidateTransformationIds: ['complex-projection-deferral'],
        expectedEquivalent: true,
    },
    {
        id: 'u6-candidate-redundant-computed-project-barrier',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, value: 1, hidden: 'first' },
                    { _id: 2, value: null, hidden: 'second' },
                    { _id: 3, hidden: 'third' },
                ],
            },
        },
        pipeline: [
            {
                $project: {
                    value: { $add: ['$value', 1] },
                    _id: 0,
                },
            },
            {
                $project: {
                    value: { $add: ['$value', 1] },
                    _id: 0,
                },
            },
        ],
        observation: 'structural-barrier',
        affectedTransformationIds: ['redundant-projection-elimination'],
        candidateTransformationIds: ['redundant-projection-elimination'],
        expectedEquivalent: true,
    },
    {
        id: 'u7-candidate-redundant-lookup-noop-multiplicity',
        kind: 'pipeline',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    {
                        _id: 1,
                        customerId: 'customer-zero',
                        name: 'Zero',
                    },
                    {
                        _id: 2,
                        customerId: 'customer-one',
                        name: 'One',
                    },
                    {
                        _id: 3,
                        customerId: 'customer-many',
                        name: 'Many',
                    },
                ],
            },
            orders: {
                documents: [
                    { _id: 10, customerId: 'customer-one', total: 5 },
                    { _id: 20, customerId: 'customer-many', total: 7 },
                    { _id: 21, customerId: 'customer-many', total: 9 },
                ],
            },
        },
        pipeline: [
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
            { $unset: 'orders' },
        ],
        observation: 'multiset',
        affectedTransformationIds: ['redundant-lookup-elimination'],
        candidateTransformationIds: ['redundant-lookup-elimination'],
        expectedEquivalent: true,
    },
];

export const unsafeCandidateCases: readonly SemanticCase[] = [
    {
        id: 'unsafe-filter-match-all-or',
        kind: 'filter',
        mainCollectionId: 'main',
        collections: {
            main: { documents: scalarDocuments },
        },
        filter: {
            $or: [{}, { a: 1 }],
        },
        optimizedFilterOverride: {
            a: 1,
        },
        options: {
            sort: { _id: 1 },
        },
        observation: 'ordered-bson',
        affectedTransformationIds: ['simplify-disjunction-identities'],
        expectedEquivalent: false,
    },
];
