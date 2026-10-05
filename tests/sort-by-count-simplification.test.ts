import { describe, expect, it } from 'vitest';
import { SortByCountSimplificationPass } from '../src/passes/sort-by-count-simplification';
import { proveSortByCountSimplification } from '../src/passes/sort-by-count-proofs';
import { optimizePipeline } from '../src/index';
import { runMockPipeline } from './helpers/mock-engine';

describe( 'sort-by-count-proofs unit and branch analysis', () =>
{
    it( 'returns null for non-plain-object stages', () =>
    {
        expect( proveSortByCountSimplification( null, { $sort: { count: -1 } } )).toBeNull();
        expect( proveSortByCountSimplification( Object.create( null ), { $sort: { count: -1 } } )).toBeNull();
        const nullProtoGroup = Object.create( null );
        nullProtoGroup.$group = { _id: '$a', count: { $sum: 1 } };
        expect( proveSortByCountSimplification( nullProtoGroup, { $sort: { count: -1 } } )).not.toBeNull();
        expect( proveSortByCountSimplification( { $group: { _id: '$a', count: { $sum: 1 } } }, null )).toBeNull();
        expect( proveSortByCountSimplification( [ 1 ], { $sort: { count: -1 } } )).toBeNull();
        expect( proveSortByCountSimplification( { $match: {} }, { $sort: { count: -1 } } )).toBeNull();
        expect( proveSortByCountSimplification( { $group: { _id: '$a', count: { $sum: 1 } } }, { $match: {} } )).toBeNull();
    });

    it( 'returns null when stage specs are not plain objects', () =>
    {
        expect( proveSortByCountSimplification( { $group: 'invalid' }, { $sort: { count: -1 } } )).toBeNull();
        expect( proveSortByCountSimplification( { $group: { _id: '$a', count: { $sum: 1 } } }, { $sort: 'invalid' } )).toBeNull();
    });

    it( 'returns null when group structure does not match exact shape', () =>
    {
        // Wrong number of keys
        expect( proveSortByCountSimplification(
            { $group: { _id: '$a' } },
            { $sort: { count: -1 } }
        )).toBeNull();

        expect( proveSortByCountSimplification(
            { $group: { _id: '$a', count: { $sum: 1 }, extra: 1 } },
            { $sort: { count: -1 } }
        )).toBeNull();

        // Missing _id or count
        expect( proveSortByCountSimplification(
            { $group: { key: '$a', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        )).toBeNull();

        expect( proveSortByCountSimplification(
            { $group: { _id: '$a', total: { $sum: 1 } } },
            { $sort: { count: -1 } }
        )).toBeNull();

        // count accumulator not plain object
        expect( proveSortByCountSimplification(
            { $group: { _id: '$a', count: 1 } },
            { $sort: { count: -1 } }
        )).toBeNull();

        // count accumulator not { $sum: 1 } or { $count: {} }
        expect( proveSortByCountSimplification(
            { $group: { _id: '$a', count: { $sum: 2 } } },
            { $sort: { count: -1 } }
        )).toBeNull();

        expect( proveSortByCountSimplification(
            { $group: { _id: '$a', count: { $count: { invalid: 1 } } } },
            { $sort: { count: -1 } }
        )).toBeNull();

        expect( proveSortByCountSimplification(
            { $group: { _id: '$a', count: { $avg: 1 } } },
            { $sort: { count: -1 } }
        )).toBeNull();
    });

    it( 'returns null when sort structure does not match exact shape', () =>
    {
        // Wrong sort key
        expect( proveSortByCountSimplification(
            { $group: { _id: '$a', count: { $sum: 1 } } },
            { $sort: { total: -1 } }
        )).toBeNull();

        // Multiple sort keys
        expect( proveSortByCountSimplification(
            { $group: { _id: '$a', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } }
        )).toBeNull();

        // Sort direction not descending (-1)
        expect( proveSortByCountSimplification(
            { $group: { _id: '$a', count: { $sum: 1 } } },
            { $sort: { count: 1 } }
        )).toBeNull();
    });

    it( 'proves valid shape with { $sum: 1 } and { $count: {} }', () =>
    {
        const proofSum = proveSortByCountSimplification(
            { $group: { _id: '$category', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        );

        expect( proofSum ).toEqual({
            sortByCountStage: { $sortByCount: '$category' }
        });

        const proofCount = proveSortByCountSimplification(
            { $group: { _id: { x: '$x', y: '$y' }, count: { $count: {} } } },
            { $sort: { count: -1 } }
        );

        expect( proofCount ).toEqual({
            sortByCountStage: { $sortByCount: { x: '$x', y: '$y' } }
        });
    });
});

describe( 'SortByCountSimplificationPass execution and parity', () =>
{
    const pass = new SortByCountSimplificationPass();

    it( 'simplifies group + sort to $sortByCount', () =>
    {
        const pipeline =
        [
            { $match: { active: true } },
            { $group: { _id: '$tag', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
        ];

        const optimized = pass.execute( pipeline );

        expect( optimized ).toEqual(
        [
            { $match: { active: true } },
            { $sortByCount: '$tag' },
            { $limit: 10 }
        ]);
    });

    it( 'preserves execution parity on mock engine with real data', () =>
    {
        const dataset =
        [
            { _id: 1, tag: 'tech' },
            { _id: 2, tag: 'news' },
            { _id: 3, tag: 'tech' },
            { _id: 4, tag: 'tech' },
            { _id: 5, tag: 'sports' },
            { _id: 6, tag: 'news' }
        ];

        const rawPipeline =
        [
            { $group: { _id: '$tag', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ];

        const optimizedPipeline = optimizePipeline( rawPipeline );
        const rawResult = runMockPipeline( dataset, rawPipeline );
        const optimizedResult = runMockPipeline( dataset, optimizedPipeline );

        expect( rawResult ).toEqual( optimizedResult );
        expect( optimizedPipeline ).toEqual(
        [
            { $sortByCount: '$tag' }
        ]);
    });
});
