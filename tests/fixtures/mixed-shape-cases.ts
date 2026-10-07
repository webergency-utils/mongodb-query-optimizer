import type { Document } from 'mongodb';
import type {
    ExpectedOriginalOutcome,
    LogicalCollectionFixture,
    ObservationMode,
} from '../helpers/mongodb-oracle.js';
import { buildMixedShapeDocuments } from './mixed-shapes.js';

export interface MixedShapeDifferentialCase
{
    readonly id: string;
    readonly description: string;
    readonly passId: string;
    readonly mainCollectionId: string;
    readonly collections: Readonly<Record<string, LogicalCollectionFixture>>;
    readonly pipeline: readonly Document[];
    readonly observation: ObservationMode;
    readonly expectedOriginalOutcome: ExpectedOriginalOutcome;
    readonly knownBugModes?: readonly ( 'default' | 'strictFieldOrder' | 'strictErrors' )[];
}

const standardMixedShapeDocs = buildMixedShapeDocuments( {
    fieldPath: 'val',
    extraFields: ( index ) => ( {
        status: index % 2 === 0 ? 'active' : 'inactive',
        rank: index,
        foreignId: 100 + ( index % 3 ),
    } ),
} );

const foreignLookupDocs: readonly Document[] = [
    { _id: 100, title: 'Item 100' },
    { _id: 101, title: 'Item 101' },
    { _id: 102, title: 'Item 102' },
];

export const mixedShapeDifferentialCases: readonly MixedShapeDifferentialCase[] = [
    // AE1: Sibling field reads hoisted field (known bug in add-field-pushdown until U7)
    {
        id: 'mixed-shape-ae1-sibling-read',
        description: 'AE1: Sibling field reads a hoisted field across $lookup',
        passId: 'add-field-pushdown',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, score: 10, foreignId: 100 },
                    { _id: 2, score: 30, foreignId: 101 },
                ],
            },
            foreign: {
                documents: foreignLookupDocs,
            },
        },
        pipeline: [
            {
                $lookup: {
                    from: 'foreign',
                    localField: 'foreignId',
                    foreignField: '_id',
                    as: 'foreignDocs',
                },
            },
            {
                $addFields: {
                    score: { $add: [ '$score', 5 ] },
                    oldScore: '$score',
                },
            },
            { $sort: { score: -1, _id: 1 } },
            { $limit: 2 },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // AE2: Hoisted field changes field order
    {
        id: 'mixed-shape-ae2-field-order',
        description: 'AE2: Hoisted field changes document field order across $lookup',
        passId: 'add-field-pushdown',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, name: 'A', score: 10, foreignId: 100 },
                    { _id: 2, name: 'B', score: 30, foreignId: 101 },
                ],
            },
            foreign: {
                documents: foreignLookupDocs,
            },
        },
        pipeline: [
            {
                $lookup: {
                    from: 'foreign',
                    localField: 'foreignId',
                    foreignField: '_id',
                    as: 'foreignDocs',
                },
            },
            {
                $addFields: {
                    computed: { $add: [ '$score', 1 ] },
                },
            },
            { $sort: { computed: -1, _id: 1 } },
            { $limit: 2 },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // AE3: Unwound field is an object, not an array
    {
        id: 'mixed-shape-ae3-object-unwind',
        description: 'AE3: Unwound field is an object, not an array',
        passId: 'unwind-prefilter',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, items: { score: 5 } },
                    { _id: 2, items: [ { score: 5 } ] },
                    { _id: 3, items: [ { score: 10 } ] }
                ]
            }
        },
        pipeline: [
            { $unwind: '$items' },
            { $match: { 'items.score': 5 } },
            { $sort: { _id: 1 } }
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success'
    },

    // AE4: Unwound array holds scalars and predicate matches missing fields
    {
        id: 'mixed-shape-ae4-scalar-array-exists',
        description: 'AE4: Unwound array holds scalars and predicate matches missing properties',
        passId: 'unwind-prefilter',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, items: [ 1, 2 ] },
                    { _id: 2, items: [ { score: 10 } ] }
                ]
            }
        },
        pipeline: [
            { $unwind: '$items' },
            { $match: { 'items.score': { $exists: false } } },
            { $sort: { _id: 1 } }
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success'
    },

    // AE5: Original fails on a row that $limit would drop
    {
        id: 'mixed-shape-ae5-toint-error',
        description: 'AE5: $toInt over invalid string on excluded row',
        passId: 'top-k-pushdown',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, val: '10', rank: 1 },
                    { _id: 2, val: 'not-a-number', rank: 2 },
                ],
            },
        },
        pipeline: [
            { $addFields: { parsed: { $toInt: '$val' } } },
            { $sort: { rank: 1 } },
            { $limit: 1 },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'failure',
    },

    // Polymorphic $add failing on non-numeric shapes
    {
        id: 'mixed-shape-polymorphic-add-failing',
        description: 'Polymorphic $add fails when field contains range objects or arrays',
        passId: 'add-field-pushdown',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: standardMixedShapeDocs,
            },
        },
        pipeline: [
            { $addFields: { total: { $add: [ '$val', 10 ] } } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'failure',
    },

    // Polymorphic shape-tolerant query succeeding across all 8 shapes
    {
        id: 'mixed-shape-polymorphic-shape-tolerant',
        description: 'Shape-tolerant $type and $ifNull succeeds across all eight catalog shapes',
        passId: 'add-field-pushdown',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: standardMixedShapeDocs,
            },
        },
        pipeline: [
            {
                $addFields: {
                    shapeType: { $type: '$val' },
                    fallback: { $ifNull: [ '$val', 'is_null_or_missing' ] },
                },
            },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // Polymorphic lookup delay
    {
        id: 'mixed-shape-lookup-delay',
        description: 'lookup-delay preserves polymorphic attributes across joined collections',
        passId: 'lookup-delay',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: standardMixedShapeDocs,
            },
            foreign: {
                documents: foreignLookupDocs,
            },
        },
        pipeline: [
            {
                $lookup: {
                    from: 'foreign',
                    localField: 'foreignId',
                    foreignField: '_id',
                    as: 'joined',
                },
            },
            { $match: { status: 'active' } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // Polymorphic match pushdown
    {
        id: 'mixed-shape-match-pushdown',
        description: 'match-pushdown across field computation with polymorphic shapes',
        passId: 'match-pushdown',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: standardMixedShapeDocs,
            },
        },
        pipeline: [
            { $addFields: { activeMarker: { $eq: [ '$status', 'active' ] } } },
            { $match: { rank: { $lte: 4 } } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    {
        id: 'mixed-shape-heuristic-match-pushdown',
        description: 'heuristic-match-pushdown of computed field across costly lookup',
        passId: 'heuristic-match-pushdown',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, rank: 1, val: 10, foreignId: 101 },
                    { _id: 2, rank: 2, val: 20, foreignId: 102 },
                    { _id: 3, rank: 3, val: 30, foreignId: 103 },
                ],
            },
            foreign: {
                documents: [
                    { _id: 101, name: 'Item 101' },
                    { _id: 102, name: 'Item 102' },
                    { _id: 103, name: 'Item 103' },
                ],
            },
        },
        pipeline: [
            { $lookup: { from: 'foreign', localField: 'foreignId', foreignField: '_id', as: 'extra' } },
            { $addFields: { k: { $size: { $ifNull: [ '$extra', [] ] } } } },
            { $match: { k: { $gt: 0 } } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // Polymorphic group filter pushdown
    {
        id: 'mixed-shape-group-filter-pushdown',
        description: 'group-filter-pushdown where group key handles polymorphic data',
        passId: 'group-filter-pushdown',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: standardMixedShapeDocs,
            },
        },
        pipeline: [
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 },
                },
            },
            { $match: { _id: 'active' } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // Polymorphic redundant sort elimination
    {
        id: 'mixed-shape-redundant-sort-elimination',
        description: 'redundant-sort-elimination over polymorphic val field',
        passId: 'redundant-sort-elimination',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: standardMixedShapeDocs,
            },
        },
        pipeline: [
            { $sort: { val: 1 } },
            { $sort: { val: 1, _id: 1 } },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // Polymorphic unused field pruning
    {
        id: 'mixed-shape-unused-field-pruning',
        description: 'unused-field-pruning discards dead polymorphic computations',
        passId: 'unused-field-pruning',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: standardMixedShapeDocs,
            },
        },
        pipeline: [
            { $addFields: { deadField: '$val' } },
            { $project: { _id: 1, status: 1 } },
            { $sort: { _id: 1 } },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // Polymorphic limit advance across error-prone stage
    {
        id: 'mixed-shape-limit-advance',
        description: 'limit-advance across error-prone stage on excluded row',
        passId: 'limit-advance',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, val: '10' },
                    { _id: 2, val: 'not-a-number' },
                ],
            },
        },
        pipeline: [
            { $addFields: { parsed: { $toInt: '$val' } } },
            { $limit: 1 },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // Polymorphic bucket filter pushdown
    {
        id: 'mixed-shape-bucket-filter-pushdown',
        description: 'bucket-filter-pushdown with numeric boundaries and default',
        passId: 'bucket-filter-pushdown',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: [
                    { _id: 1, val: 25 },
                    { _id: 2, val: 75 },
                    { _id: 3, val: 150 },
                ],
            },
        },
        pipeline: [
            {
                $bucket: {
                    groupBy: '$val',
                    boundaries: [ 0, 50, 100 ],
                    default: 'other',
                },
            },
            { $match: { _id: 0 } },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // Polymorphic sort-by-count simplification
    {
        id: 'mixed-shape-sort-by-count-simplification',
        description: 'sort-by-count-simplification collapses group + sort over polymorphic val field',
        passId: 'sort-by-count-simplification',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: standardMixedShapeDocs,
            },
        },
        pipeline: [
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 },
                },
            },
            { $sort: { count: -1 } },
        ],
        observation: 'multiset',
        expectedOriginalOutcome: 'success',
    },

    // Polymorphic limit-skip coalescing
    {
        id: 'mixed-shape-limit-skip-coalescing',
        description: 'limit-skip-coalescing merges adjacent limits and skips over polymorphic collection',
        passId: 'limit-skip-coalescing',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: standardMixedShapeDocs,
            },
        },
        pipeline: [
            { $sort: { _id: 1 } },
            { $skip: 1 },
            { $skip: 1 },
            { $limit: 4 },
            { $limit: 2 },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // Polymorphic adjacent project merging
    {
        id: 'mixed-shape-adjacent-project-merging',
        description: 'adjacent-project-merging merges consecutive pure flag projections over polymorphic documents',
        passId: 'adjacent-project-merging',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: standardMixedShapeDocs,
            },
        },
        pipeline: [
            { $sort: { _id: 1 } },
            { $project: { _id: 1, status: 1, val: 1 } },
            { $project: { _id: 1, val: 1 } },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // Polymorphic adjacent add-field merging
    {
        id: 'mixed-shape-adjacent-add-field-merging',
        description: 'adjacent-add-field-merging merges disjoint addFields stages over polymorphic documents',
        passId: 'adjacent-add-field-merging',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: standardMixedShapeDocs,
            },
        },
        pipeline: [
            { $sort: { _id: 1 } },
            { $addFields: { fieldA: 1 } },
            { $addFields: { fieldB: '$status' } },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // Polymorphic redundant lookup elimination
    {
        id: 'mixed-shape-redundant-lookup-elimination',
        description: 'redundant-lookup-elimination removes lookup immediately discarded by project',
        passId: 'redundant-lookup-elimination',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: standardMixedShapeDocs,
            },
            foreign: {
                documents: [
                    { _id: 1, val: 10 },
                    { _id: 2, val: 20 },
                ],
            },
        },
        pipeline: [
            { $sort: { _id: 1 } },
            {
                $lookup: {
                    from: 'foreign',
                    localField: 'val',
                    foreignField: 'val',
                    as: 'joined',
                },
            },
            { $project: { _id: 1, status: 1 } },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // Polymorphic sort project commute
    {
        id: 'mixed-shape-sort-project-commute',
        description: 'sort-project-commute advances simple project before sort over polymorphic documents',
        passId: 'sort-project-commute',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: standardMixedShapeDocs,
            },
        },
        pipeline: [
            { $sort: { _id: 1, val: 1 } },
            { $project: { _id: 1, val: 1, status: 1 } },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // Polymorphic complex projection deferral
    {
        id: 'mixed-shape-complex-projection-deferral',
        description: 'complex-projection-deferral moves error-free addFields past sort over polymorphic documents',
        passId: 'complex-projection-deferral',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: standardMixedShapeDocs,
            },
        },
        pipeline: [
            { $addFields: { extra: 1 } },
            { $sort: { val: 1, _id: 1 } },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },

    // Polymorphic facet prefix hoisting
    {
        id: 'mixed-shape-facet-prefix-hoisting',
        description: 'facet-prefix-hoisting hoists common match prefix out of facet over polymorphic documents',
        passId: 'facet-prefix-hoisting',
        mainCollectionId: 'main',
        collections: {
            main: {
                documents: standardMixedShapeDocs,
            },
        },
        pipeline: [
            { $sort: { _id: 1 } },
            {
                $facet: {
                    activeItems: [
                        { $match: { status: 'active' } },
                        { $limit: 2 },
                    ],
                    activeCount: [
                        { $match: { status: 'active' } },
                        { $count: 'total' },
                    ],
                },
            },
        ],
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    },
    ...heuristicTopKHardeningCases(),
];

function heuristicTopKHardeningCases(): MixedShapeDifferentialCase[]
{
    const tagDocuments = [
        { _id: 1, tags: [ 'a' ], foreignId: 100 },
        { _id: 2, tags: [ 'a', 'b', 'c' ], foreignId: 101 },
        { _id: 3, tags: [], foreignId: 102 },
        { _id: 4, tags: [ 'a', 'b', 'c', 'd', 'e' ], foreignId: 100 },
    ];
    const lookup = { $lookup: { from: 'foreign', localField: 'foreignId', foreignField: '_id', as: 'foreignDocs' } };
    const collections = {
        main: { documents: tagDocuments },
        foreign: { documents: foreignLookupDocs },
    };
    const topKCase = ( id: string, description: string, pipeline: Document[], documents?: readonly Document[] ): MixedShapeDifferentialCase => ( {
        id,
        description,
        passId: 'top-k-pushdown',
        mainCollectionId: 'main',
        collections: documents ? { ...collections, main: { documents } } : collections,
        pipeline,
        observation: 'ordered-bson',
        expectedOriginalOutcome: 'success',
    } );

    return [
        topKCase( 'mixed-shape-heuristic-top-k-split-providers', 'Heuristic Top-K AE1: providers split by a $set on a later key dependency', [
            lookup,
            { $addFields: { k1: 0 } },
            { $set: { base: -1 } },
            { $addFields: { k2: { $multiply: [ { $size: '$tags' }, '$base' ] } } },
            { $sort: { k1: 1, k2: 1, _id: 1 } },
            { $limit: 2 },
        ] ),
        topKCase( 'mixed-shape-heuristic-top-k-cross-key', 'Heuristic Top-K AE2: a sort key reads another computed sort key', [
            lookup,
            { $addFields: { k1: 0 } },
            { $addFields: { k2: { $multiply: [ { $size: '$tags' }, { $add: [ '$k1', -1 ] } ] } } },
            { $sort: { k1: 1, k2: 1, _id: 1 } },
            { $limit: 2 },
        ] ),
        topKCase( 'mixed-shape-heuristic-top-k-dotted-key', 'Heuristic Top-K AE3: dotted computed key over array, empty array, scalar and missing parents', [
            lookup,
            { $addFields: { 'arr.v': { $size: '$tags' } } },
            { $sort: { 'arr.v': 1, _id: 1 } },
            { $limit: 2 },
        ], [
            { _id: 1, tags: [ 'a' ], arr: [ {}, {} ], foreignId: 100 },
            { _id: 2, tags: [ 'a', 'b' ], arr: [], foreignId: 101 },
            { _id: 3, tags: [], arr: 7, foreignId: 102 },
            { _id: 4, tags: [ 'a', 'b', 'c' ], foreignId: 100 },
        ] ),
        topKCase( 'mixed-shape-heuristic-top-k-one-provider-two-keys', 'Heuristic Top-K accepts two keys from one provider behind a $lookup', [
            lookup,
            { $addFields: { a: { $size: '$tags' }, b: { $multiply: [ { $size: '$tags' }, -1 ] } } },
            { $sort: { a: -1, b: 1, _id: 1 } },
            { $limit: 2 },
        ] ),
        topKCase( 'mixed-shape-heuristic-top-k-independent-providers', 'Heuristic Top-K accepts two keys from different providers with independent dependencies', [
            lookup,
            { $addFields: { a: { $size: '$tags' } } },
            { $addFields: { b: { $multiply: [ '$_id', -1 ] } } },
            { $sort: { a: 1, b: 1 } },
            { $limit: 3 },
        ] ),
        topKCase( 'mixed-shape-heuristic-top-k-nested-function', 'Heuristic Top-K hoists a deterministic $function nested inside another expression', [
            lookup,
            { $addFields: { n: { $add: [ { $function: { body: 'function( t ) { return t.length; }', args: [ '$tags' ], lang: 'js' } }, 0 ] } } },
            { $sort: { n: -1, _id: 1 } },
            { $limit: 2 },
        ] ),
    ];
}
