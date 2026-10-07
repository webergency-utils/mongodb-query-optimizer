import type { Document } from 'mongodb';
import
{
    getPipelineTransformationRegistryStatus,
    type PipelineTransformationId
}
from '../../src/passes/registry.js';
import type { ObservationMode } from '../helpers/mongodb-oracle.js';
import { MIXED_SHAPE_CATALOG, buildMixedShapeDocuments } from './mixed-shapes.js';
import { seededRandom } from './generated-interactions.js';

export interface RandomDifferentialCase
{
    readonly id: string;
    readonly seed: number;
    readonly caseIndex: number;
    readonly passId: PipelineTransformationId;
    readonly mainCollectionId: string;
    readonly collections: Readonly<Record<string, { documents: readonly Document[] }>>;
    readonly pipeline: readonly Document[];
    readonly observation: ObservationMode;
    readonly expectedOriginalOutcome: 'success';
}

export const DEFAULT_RANDOM_SEEDS: readonly number[] = Object.freeze([
    0x1337_0001,
    0x1337_0002,
    0x1337_0003
]);

export function getReplaySeed(): number | null
{
    const envVal = process.env.RANDOM_DIFFERENTIAL_REPLAY_SEED ?? process.env.REPLAY_SEED;
    if( !envVal || envVal.trim().length === 0 )
    {
        return null;
    }

    const trimmed = envVal.trim().replaceAll( '_', '' );
    const parsed = trimmed.startsWith( '0x' ) || trimmed.startsWith( '0X' )
        ? parseInt( trimmed, 16 )
        : parseInt( trimmed, 10 );

    return Number.isFinite( parsed ) ? parsed : null;
}

export function getEffectiveRandomSeeds(): readonly number[]
{
    const replay = getReplaySeed();
    return replay !== null ? Object.freeze([ replay ]) : DEFAULT_RANDOM_SEEDS;
}

export interface PipelineTemplate
{
    readonly passId: PipelineTransformationId;
    readonly observation?: ObservationMode;
    readonly buildPipeline: ( random: () => number, index: number ) => readonly Document[];
}

export const RANDOM_PIPELINE_TEMPLATES: readonly PipelineTemplate[] = Object.freeze([
    {
        passId: 'group-filter-pushdown',
        buildPipeline: ( _random, _index ) => [
            { $sort: { _id: 1 } },
            { $group: { _id: '$status', count: { $sum: 1 }, totalScore: { $sum: '$score' } } },
            { $match: { _id: 'active' } }
        ]
    },
    {
        passId: 'bucket-filter-pushdown',
        buildPipeline: ( _random, _index ) => [
            { $sort: { _id: 1 } },
            { $bucket: { groupBy: '$score', boundaries: [ 0, 50, 100 ], default: 'other' } },
            { $match: { _id: 0 } }
        ]
    },
    {
        passId: 'unwind-prefilter',
        buildPipeline: ( _random, _index ) => [
            { $sort: { _id: 1 } },
            { $unwind: '$tags' },
            { $match: { tags: 'alpha' } }
        ]
    },
    {
        passId: 'redundant-sort-elimination',
        buildPipeline: ( _random, _index ) => [
            { $sort: { score: 1 } },
            { $sort: { _id: 1 } }
        ]
    },
    {
        passId: 'sort-by-count-simplification',
        observation: 'multiset',
        buildPipeline: ( _random, _index ) => [
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]
    },
    {
        passId: 'limit-skip-coalescing',
        buildPipeline: ( _random, _index ) => [
            { $sort: { _id: 1 } },
            { $limit: 10 },
            { $limit: 4 }
        ]
    },
    {
        passId: 'expression-simplification',
        buildPipeline: ( _random, _index ) => [
            { $addFields: { total: { $size: { $filter: { input: '$tags', cond: { $and: [ {}, {} ] } } } } } },
            { $sort: { _id: 1 } }
        ]
    },
    {
        passId: 'match-pushdown',
        buildPipeline: ( _random, _index ) => [
            { $project: { _id: 1, status: 1, score: 1 } },
            { $match: { status: 'active' } },
            { $sort: { _id: 1 } }
        ]
    },
    {
        passId: 'heuristic-match-pushdown',
        buildPipeline: ( _random, _index ) => [
            { $lookup: { from: 'foreign', localField: 'foreignId', foreignField: '_id', as: 'items' } },
            { $addFields: { k: { $size: { $ifNull: [ '$items', [] ] } } } },
            { $match: { k: { $gt: 0 } } },
            { $sort: { _id: 1 } }
        ]
    },
    {
        passId: 'limit-advance',
        buildPipeline: ( _random, _index ) => [
            { $project: { _id: 1, status: 1, score: 1 } },
            { $limit: 3 },
            { $sort: { _id: 1 } }
        ]
    },
    {
        passId: 'add-field-pushdown',
        buildPipeline: ( _random, _index ) => [
            { $addFields: { flag: 1 } },
            {
                $lookup: {
                    from: 'foreign',
                    localField: 'foreignId',
                    foreignField: '_id',
                    as: 'joined'
                }
            },
            { $sort: { _id: 1 } }
        ]
    },
    {
        passId: 'top-k-pushdown',
        buildPipeline: ( _random, _index ) => [
            { $addFields: { flag: 1 } },
            { $sort: { _id: 1 } },
            { $limit: 3 }
        ]
    },
    {
        passId: 'unused-field-pruning',
        buildPipeline: ( _random, _index ) => [
            { $sort: { _id: 1 } },
            { $set: { tempVal: 99, keepVal: '$status' } },
            { $unset: 'tempVal' }
        ]
    },
    {
        passId: 'adjacent-project-merging',
        buildPipeline: ( _random, _index ) => [
            { $project: { _id: 1, status: 1, score: 1 } },
            { $project: { _id: 1, status: 1 } },
            { $sort: { _id: 1 } }
        ]
    },
    {
        passId: 'adjacent-add-field-merging',
        buildPipeline: ( _random, _index ) => [
            { $sort: { _id: 1 } },
            { $addFields: { fieldA: 1 } },
            { $addFields: { fieldB: 2 } }
        ]
    },
    {
        passId: 'lookup-delay',
        buildPipeline: ( _random, _index ) => [
            {
                $lookup: {
                    from: 'foreign',
                    localField: 'foreignId',
                    foreignField: '_id',
                    as: 'joined'
                }
            },
            { $sort: { _id: 1 } }
        ]
    },
    {
        passId: 'redundant-lookup-elimination',
        buildPipeline: ( _random, _index ) => [
            {
                $lookup: {
                    from: 'foreign',
                    localField: 'foreignId',
                    foreignField: '_id',
                    as: 'joined'
                }
            },
            { $project: { _id: 1, status: 1 } },
            { $sort: { _id: 1 } }
        ]
    },
    {
        passId: 'sort-project-commute',
        buildPipeline: ( _random, _index ) => [
            { $sort: { _id: 1 } },
            { $project: { _id: 1, status: 1 } }
        ]
    },
    {
        passId: 'complex-projection-deferral',
        buildPipeline: ( _random, _index ) => [
            { $addFields: { extra: 1 } },
            { $sort: { _id: 1 } }
        ]
    },
    {
        passId: 'facet-prefix-hoisting',
        buildPipeline: ( _random, _index ) => [
            { $sort: { _id: 1 } },
            {
                $facet: {
                    b1: [
                        { $match: { status: 'active' } },
                        { $limit: 2 }
                    ],
                    b2: [
                        { $match: { status: 'active' } },
                        { $count: 'n' }
                    ]
                }
            }
        ]
    }
]);

export function makeSeededDocuments( random: () => number ): readonly Document[]
{
    const tagOptions = [ 'alpha', 'beta', 'gamma' ];

    return buildMixedShapeDocuments({
        fieldPath: 'val',
        count: MIXED_SHAPE_CATALOG.length * 2,
        extraFields: ( index, _shape ) =>
        {
            const tagIndex = Math.floor( random() * tagOptions.length );
            return {
                status: index % 2 === 0 ? 'active' : 'inactive',
                score: ( index % 10 ) * 10,
                foreignId: 100 + ( index % 3 ),
                tags: [ tagOptions[ tagIndex ] ]
            };
        }
    });
}

export function generateRandomDifferentialCases( seed: number ): readonly RandomDifferentialCase[]
{
    const random = seededRandom( seed );
    const documents = makeSeededDocuments( random );
    const foreignDocs: readonly Document[] = Object.freeze([
        { _id: 100, name: 'Item 100' },
        { _id: 101, name: 'Item 101' },
        { _id: 102, name: 'Item 102' }
    ]);

    const collections = Object.freeze({
        main: Object.freeze({ documents }),
        foreign: Object.freeze({ documents: foreignDocs })
    });

    const cases: RandomDifferentialCase[] = [];

    for( let index = 0; index < RANDOM_PIPELINE_TEMPLATES.length; index++ )
    {
        const template = RANDOM_PIPELINE_TEMPLATES[ index ];
        const pipeline = template.buildPipeline( random, index );

        cases.push({
            id: `random-0x${seed.toString( 16 )}-${template.passId}-${index}`,
            seed,
            caseIndex: index,
            passId: template.passId,
            mainCollectionId: 'main',
            collections,
            pipeline,
            observation: template.observation ?? 'ordered-bson',
            expectedOriginalOutcome: 'success'
        });
    }

    return Object.freeze( cases );
}
