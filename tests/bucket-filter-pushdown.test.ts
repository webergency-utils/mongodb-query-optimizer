import { describe, expect, it } from 'vitest';
import { BucketFilterPushdownPass } from '../src/passes/bucket-filter-pushdown';
import { proveBucketFilterPushdown } from '../src/passes/bucket-pushdown-proofs';
import { optimizePipeline } from './helpers/pre-gate-optimizer.js';
import { runMockPipeline } from './helpers/mock-engine';

describe( 'bucket-pushdown-proofs unit and branch analysis', () =>
{
    it( 'returns null for non-plain-object stages', () =>
    {
        expect( proveBucketFilterPushdown( null, { $match: { _id: 10 } } )).toBeNull();
        expect( proveBucketFilterPushdown( Object.create( null ), { $match: { _id: 10 } } )).toBeNull();
        const nullProtoBucket = Object.create( null );
        nullProtoBucket.$bucket = {
            groupBy: '$year',
            boundaries: [ 0, 10 ]
        };
        expect( proveBucketFilterPushdown( nullProtoBucket, { $match: { _id: 0 } } )).not.toBeNull();
        expect( proveBucketFilterPushdown( { $bucket: {} }, null )).toBeNull();
        expect( proveBucketFilterPushdown( [ 1 ], { $match: { _id: 10 } } )).toBeNull();
        expect( proveBucketFilterPushdown( { $sort: {} }, { $match: { _id: 10 } } )).toBeNull();
        expect( proveBucketFilterPushdown( { $bucket: {} }, { $sort: {} } )).toBeNull();
        expect( proveBucketFilterPushdown( { $bucket: 'invalid' }, { $match: {} } )).toBeNull();
        expect( proveBucketFilterPushdown( { $bucket: {} }, { $match: 'invalid' } )).toBeNull();
    });

    it( 'validates groupBy field path requirements', () =>
    {
        // Not string
        expect( proveBucketFilterPushdown(
            { $bucket: { groupBy: 123, boundaries: [ 0, 10 ] } },
            { $match: { _id: 0 } }
        )).toBeNull();

        // Not starting with $
        expect( proveBucketFilterPushdown(
            { $bucket: { groupBy: 'year', boundaries: [ 0, 10 ] } },
            { $match: { _id: 0 } }
        )).toBeNull();

        // Starting with $$
        expect( proveBucketFilterPushdown(
            { $bucket: { groupBy: '$$year', boundaries: [ 0, 10 ] } },
            { $match: { _id: 0 } }
        )).toBeNull();

        // Just $
        expect( proveBucketFilterPushdown(
            { $bucket: { groupBy: '$', boundaries: [ 0, 10 ] } },
            { $match: { _id: 0 } }
        )).toBeNull();
    });

    it( 'validates boundaries array requirements', () =>
    {
        // Not array
        expect( proveBucketFilterPushdown(
            { $bucket: { groupBy: '$year', boundaries: 'invalid' } },
            { $match: { _id: 0 } }
        )).toBeNull();

        // Less than 2 elements
        expect( proveBucketFilterPushdown(
            { $bucket: { groupBy: '$year', boundaries: [ 10 ] } },
            { $match: { _id: 10 } }
        )).toBeNull();

        // Not sorted ascending
        expect( proveBucketFilterPushdown(
            { $bucket: { groupBy: '$year', boundaries: [ 20, 10, 30 ] } },
            { $match: { _id: 10 } }
        )).toBeNull();

        // Duplicate boundaries
        expect( proveBucketFilterPushdown(
            { $bucket: { groupBy: '$year', boundaries: [ 10, 10, 30 ] } },
            { $match: { _id: 10 } }
        )).toBeNull();
    });

    it( 'validates match conditions on _id', () =>
    {
        const validBucket =
        {
            $bucket: {
                groupBy: '$year',
                boundaries: [ 1990, 2000, 2010, 2020 ],
                default: 'other'
            }
        };

        // Missing _id in match
        expect( proveBucketFilterPushdown( validBucket, { $match: { status: 'active' } } )).toBeNull();

        // Scalar _id not in boundaries
        expect( proveBucketFilterPushdown( validBucket, { $match: { _id: 1985 } } )).toBeNull();

        // Scalar _id is the last boundary (only an upper limit, never a bucket _id)
        expect( proveBucketFilterPushdown( validBucket, { $match: { _id: 2020 } } )).toBeNull();

        // $eq not in boundaries
        expect( proveBucketFilterPushdown( validBucket, { $match: { _id: { $eq: 1985 } } } )).toBeNull();

        // $eq is the last boundary
        expect( proveBucketFilterPushdown( validBucket, { $match: { _id: { $eq: 2020 } } } )).toBeNull();

        // $in with item not in boundaries
        expect( proveBucketFilterPushdown( validBucket, { $match: { _id: { $in: [ 1990, 9999 ] } } } )).toBeNull();

        // $in with last boundary
        expect( proveBucketFilterPushdown( validBucket, { $match: { _id: { $in: [ 1990, 2020 ] } } } )).toBeNull();

        // Unknown operator on _id
        expect( proveBucketFilterPushdown( validBucket, { $match: { _id: { $gt: 1990 } } } )).toBeNull();
    });

    it( 'proves scalar and $eq bucket filter pushdown', () =>
    {
        const bucketStage =
        {
            $bucket: {
                groupBy: '$year',
                boundaries: [ 1990, 2000, 2010, 2020 ],
                default: 'other'
            }
        };

        const proofScalar = proveBucketFilterPushdown( bucketStage, { $match: { _id: 1990 } } );

        expect( proofScalar ).toEqual({
            prefilterStage: { $match: { year: { $gte: 1990, $lt: 2000 } } },
            postfilterStage: null
        });

        const proofEq = proveBucketFilterPushdown( bucketStage, { $match: { _id: { $eq: 2000 } } } );

        expect( proofEq ).toEqual({
            prefilterStage: { $match: { year: { $gte: 2000, $lt: 2010 } } },
            postfilterStage: null
        });
    });

    it( 'proves contiguous and non-contiguous $in bucket filter pushdown', () =>
    {
        const bucketStage =
        {
            $bucket: {
                groupBy: '$year',
                boundaries: [ 1990, 2000, 2010, 2020, 2030 ],
                default: 'other'
            }
        };

        // Contiguous 1990 and 2000 -> collapses to range [1990, 2010)
        const proofContiguous = proveBucketFilterPushdown(
            bucketStage,
            { $match: { _id: { $in: [ 1990, 2000 ] } } }
        );

        expect( proofContiguous ).toEqual({
            prefilterStage: { $match: { year: { $gte: 1990, $lt: 2010 } } },
            postfilterStage: null
        });

        // Non-contiguous 1990 and 2010 -> $or of ranges
        const proofNonContiguous = proveBucketFilterPushdown(
            bucketStage,
            { $match: { _id: { $in: [ 1990, 2010 ] } } }
        );

        expect( proofNonContiguous ).toEqual({
            prefilterStage: {
                $match: {
                    $or:
                    [
                        { year: { $gte: 1990, $lt: 2000 } },
                        { year: { $gte: 2010, $lt: 2020 } }
                    ]
                }
            },
            postfilterStage: null
        });
    });

    it( 'retains non-_id conditions in postfilterStage', () =>
    {
        const bucketStage =
        {
            $bucket: {
                groupBy: '$metadata.age',
                boundaries: [ 0, 18, 65, 100 ],
                default: 'other'
            }
        };

        const proof = proveBucketFilterPushdown(
            bucketStage,
            { $match: { _id: 18, count: { $gt: 5 }, active: true } }
        );

        expect( proof ).toEqual({
            prefilterStage: { $match: { 'metadata.age': { $gte: 18, $lt: 65 } } },
            postfilterStage: { $match: { count: { $gt: 5 }, active: true } }
        });
    });
});

describe( 'BucketFilterPushdownPass execution and parity', () =>
{
    const pass = new BucketFilterPushdownPass();

    it( 'pushes prefilter before bucket and removes empty postfilter', () =>
    {
        const pipeline =
        [
            {
                $bucket: {
                    groupBy: '$year',
                    boundaries: [ 1990, 2000, 2010, 2020 ],
                    default: 'other',
                    output: { count: { $sum: 1 } }
                }
            },
            { $match: { _id: 1990 } }
        ];

        const optimized = pass.execute( pipeline );

        expect( optimized ).toEqual(
        [
            { $match: { year: { $gte: 1990, $lt: 2000 } } },
            {
                $bucket: {
                    groupBy: '$year',
                    boundaries: [ 1990, 2000, 2010, 2020 ],
                    default: 'other',
                    output: { count: { $sum: 1 } }
                }
            }
        ]);
    });

    it( 'avoids duplicate prefilter when already present', () =>
    {
        const pipeline =
        [
            { $match: { year: { $gte: 1990, $lt: 2000 } } },
            {
                $bucket: {
                    groupBy: '$year',
                    boundaries: [ 1990, 2000, 2010, 2020 ],
                    default: 'other'
                }
            },
            { $match: { _id: 1990 } }
        ];

        const optimized = pass.execute( pipeline );

        expect( optimized ).toEqual(
        [
            { $match: { year: { $gte: 1990, $lt: 2000 } } },
            {
                $bucket: {
                    groupBy: '$year',
                    boundaries: [ 1990, 2000, 2010, 2020 ],
                    default: 'other'
                }
            }
        ]);
    });

    it( 'pushes prefilter and retains postfilter when additional conditions are present', () =>
    {
        const pipeline =
        [
            {
                $bucket: {
                    groupBy: '$year',
                    boundaries: [ 1990, 2000, 2010, 2020 ],
                    default: 'other',
                    output: { count: { $sum: 1 } }
                }
            },
            { $match: { _id: 1990, count: { $gt: 5 } } }
        ];

        const optimized = pass.execute( pipeline );

        expect( optimized ).toEqual(
        [
            { $match: { year: { $gte: 1990, $lt: 2000 } } },
            {
                $bucket: {
                    groupBy: '$year',
                    boundaries: [ 1990, 2000, 2010, 2020 ],
                    default: 'other',
                    output: { count: { $sum: 1 } }
                }
            },
            { $match: { count: { $gt: 5 } } }
        ]);
    });

    it( 'preserves execution parity on mock engine with real data', () =>
    {
        const dataset =
        [
            { _id: 1, year: 1995, score: 80 },
            { _id: 2, year: 1998, score: 90 },
            { _id: 3, year: 2005, score: 70 },
            { _id: 4, year: 2015, score: 60 }
        ];

        const rawPipeline =
        [
            {
                $bucket: {
                    groupBy: '$year',
                    boundaries: [ 1990, 2000, 2010, 2020 ],
                    default: 'other',
                    output: { count: { $sum: 1 }, maxScore: { $max: '$score' } }
                }
            },
            { $match: { _id: 1990 } }
        ];

        const optimizedPipeline = optimizePipeline( rawPipeline );
        const rawResult = runMockPipeline( dataset, rawPipeline );
        const optimizedResult = runMockPipeline( dataset, optimizedPipeline );

        expect( rawResult ).toEqual( optimizedResult );
        expect( optimizedPipeline ).toEqual(
        [
            { $match: { year: { $gte: 1990, $lt: 2000 } } },
            {
                $bucket: {
                    groupBy: '$year',
                    boundaries: [ 1990, 2000, 2010, 2020 ],
                    default: 'other',
                    output: { count: { $sum: 1 }, maxScore: { $max: '$score' } }
                }
            }
        ]);
    });

    it( 'blocks pushing down filter when bucket stage lacks default under strictErrors', () =>
    {
        const pipeline =
        [
            {
                $bucket: {
                    groupBy: '$year',
                    boundaries: [ 1990, 2000, 2010, 2020 ]
                }
            },
            { $match: { _id: 1990 } }
        ];

        const result = pass.execute( pipeline, { strictFieldOrder: false, strictErrors: true } );
        expect( result ).toEqual( pipeline );
    });
});
