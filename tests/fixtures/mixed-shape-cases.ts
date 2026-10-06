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
];
