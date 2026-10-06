import { describe, expect, it } from 'vitest';
import { GuaranteeContext } from '../src/guarantees.js';
import
{
    canMoveStageAcrossStage,
    canRemoveStage,
    canSplitFieldAddingStage,
    isStageProvenErrorFree,
    pipelineReadsFieldOrder,
    stageAddsFields,
    stageCanExpandRows,
    stageCanFilterRows,
    stageReadsFieldOrder
}
from '../src/passes/guarantee-guards.js';

const DEFAULT_CONTEXT: GuaranteeContext = Object.freeze(
{
    strictFieldOrder : false,
    strictErrors     : false
});

const STRICT_ERRORS_CONTEXT: GuaranteeContext = Object.freeze(
{
    strictFieldOrder : false,
    strictErrors     : true
});

const STRICT_FIELD_ORDER_CONTEXT: GuaranteeContext = Object.freeze(
{
    strictFieldOrder : true,
    strictErrors     : false
});

describe( 'isStageProvenErrorFree', () =>
{
    it( 'returns false for non-object or array input', () =>
    {
        expect( isStageProvenErrorFree( null )).toBe( false );
        expect( isStageProvenErrorFree( undefined )).toBe( false );
        expect( isStageProvenErrorFree( 42 )).toBe( false );
        expect( isStageProvenErrorFree([ { $match: {} } ])).toBe( false );
    });

    it( 'returns false for malformed or unknown stages', () =>
    {
        expect( isStageProvenErrorFree( { $unknownOp: 1 } )).toBe( false );
        expect( isStageProvenErrorFree( { $match: 'invalid' } )).toBe( false );
        expect( isStageProvenErrorFree( {} )).toBe( false );
    });

    it( 'returns false for $addFields with $toInt', () =>
    {
        const stage = { $addFields: { n: { $toInt: '$str' } } };

        expect( isStageProvenErrorFree( stage )).toBe( false );
    });

    it( 'returns true for $addFields with $ifNull over plain paths', () =>
    {
        const stage = { $addFields: { safe: { $ifNull: [ '$a', '$b' ] } } };

        expect( isStageProvenErrorFree( stage )).toBe( true );
    });

    it( 'returns false for $lookup with a sub-pipeline holding $toInt', () =>
    {
        const stage =
        {
            $lookup:
            {
                from     : 'foreign',
                as       : 'items',
                pipeline : [ { $addFields: { parsed: { $toInt: '$raw' } } } ]
            }
        };

        expect( isStageProvenErrorFree( stage )).toBe( false );
    });

    it( 'returns true for error-free stages like safe $sort and $limit', () =>
    {
        expect( isStageProvenErrorFree( { $sort: { score: -1 } } )).toBe( true );
        expect( isStageProvenErrorFree( { $limit: 10 } )).toBe( true );
    });
});

describe( 'stageAddsFields', () =>
{
    it( 'identifies field-adding stages correctly', () =>
    {
        expect( stageAddsFields( { $addFields: { a: 1 } } )).toBe( true );
        expect( stageAddsFields( { $set: { b: 2 } } )).toBe( true );
        expect( stageAddsFields( { $lookup: { from: 'c', as: 'items' } } )).toBe( true );
        expect( stageAddsFields( { $unwind: { path: '$items', includeArrayIndex: 'idx' } } )).toBe( true );
    });

    it( 'returns false for non-field-adding stages and edge cases', () =>
    {
        expect( stageAddsFields( { $addFields: {} } )).toBe( false );
        expect( stageAddsFields( { $unwind: '$items' } )).toBe( false );
        expect( stageAddsFields( { $unwind: { path: '$items' } } )).toBe( false );
        expect( stageAddsFields( { $unwind: { path: '$items', includeArrayIndex: '' } } )).toBe( false );
        expect( stageAddsFields( { $sort: { a: 1 } } )).toBe( false );
        expect( stageAddsFields( { $limit: 5 } )).toBe( false );
        expect( stageAddsFields( { $match: { a: 1 } } )).toBe( false );
        expect( stageAddsFields( null )).toBe( false );
        expect( stageAddsFields( {} )).toBe( false );
    });
});

describe( 'stageCanFilterRows & stageCanExpandRows', () =>
{
    it( 'detects stages that can filter or reduce rows', () =>
    {
        expect( stageCanFilterRows( { $match: { a: 1 } } )).toBe( true );
        expect( stageCanFilterRows( { $limit: 5 } )).toBe( true );
        expect( stageCanFilterRows( { $skip: 2 } )).toBe( true );
        expect( stageCanFilterRows( { $group: { _id: '$x' } } )).toBe( true );
        expect( stageCanFilterRows( { $sort: { a: 1 } } )).toBe( false );
        expect( stageCanFilterRows( { $addFields: { a: 1 } } )).toBe( false );
        expect( stageCanFilterRows( null )).toBe( true );
        expect( stageCanFilterRows( [ 123 ] )).toBe( true );
        expect( stageCanFilterRows( { $malformed: true } )).toBe( true );
    });

    it( 'detects stages that can expand rows', () =>
    {
        expect( stageCanExpandRows( { $unwind: '$items' } )).toBe( true );
        expect( stageCanExpandRows( { $match: { a: 1 } } )).toBe( false );
        expect( stageCanExpandRows( { $sort: { a: 1 } } )).toBe( false );
        expect( stageCanExpandRows( null )).toBe( true );
        expect( stageCanExpandRows( [ 123 ] )).toBe( true );
        expect( stageCanExpandRows( { $malformed: true } )).toBe( true );
    });
});

describe( 'stageReadsFieldOrder & pipelineReadsFieldOrder', () =>
{
    it( 'detects $objectToArray in expressions and arrays', () =>
    {
        expect( stageReadsFieldOrder( { $project: { arr: { $objectToArray: '$$ROOT' } } } )).toBe( true );
        expect( stageReadsFieldOrder( { $addFields: { arr: [ { $objectToArray: '$sub' } ] } } )).toBe( true );
        expect( stageReadsFieldOrder( { $addFields: { arr: [ 1, 2 ] } } )).toBe( false );
    });

    it( 'detects object equality in $match', () =>
    {
        expect( stageReadsFieldOrder( { $match: { sub: { a: 1, b: 2 } } } )).toBe( true );
        expect( stageReadsFieldOrder( { $match: { sub: { a: 1 } } } )).toBe( false );
        expect( stageReadsFieldOrder( { $match: { sub: { $gt: 1, $lt: 5 } } } )).toBe( false );
        expect( stageReadsFieldOrder( { $match: { $expr: { $objectToArray: '$$ROOT' } } } )).toBe( true );
        expect( stageReadsFieldOrder( { $match: { $expr: { $eq: [ '$a', '$b' ] } } } )).toBe( false );
        expect( stageReadsFieldOrder( { $match: [ { sub: { a: 1, b: 2 } } ] } )).toBe( true );
        expect( stageReadsFieldOrder( { $match: [ { sub: 1 } ] } )).toBe( false );
        expect( stageReadsFieldOrder( { $match: { $objectToArray: '$$ROOT' } } )).toBe( true );
        expect( stageReadsFieldOrder( { $match: { $and: [ { x: 1 } ] } } )).toBe( false );
        expect( stageReadsFieldOrder( { $match: { $and: [ { sub: { a: 1, b: 2 } } ] } } )).toBe( true );
        expect( stageReadsFieldOrder( { $match: null } )).toBe( false );
    });

    it( 'detects $$ROOT or $$CURRENT in $group and $sort', () =>
    {
        expect( stageReadsFieldOrder( { $group: { _id: '$$ROOT' } } )).toBe( true );
        expect( stageReadsFieldOrder( { $group: { _id: '$$CURRENT' } } )).toBe( true );
        expect( stageReadsFieldOrder( { $group: { _id: '$userId' } } )).toBe( false );
        expect( stageReadsFieldOrder( { $group: 'invalid' } )).toBe( false );
        expect( stageReadsFieldOrder( { $sort: { '$$ROOT': 1 } } )).toBe( true );
        expect( stageReadsFieldOrder( { $sort: { '$$CURRENT': 1 } } )).toBe( true );
        expect( stageReadsFieldOrder( { $sort: { score: -1 } } )).toBe( false );
        expect( stageReadsFieldOrder( { $sort: 'score' } )).toBe( false );
    });

    it( 'detects field order sensitivity in sub-pipelines ($lookup, $facet, $unionWith)', () =>
    {
        const lookupWithOrder =
        {
            $lookup:
            {
                from     : 'c',
                as       : 'out',
                pipeline : [ { $project: { arr: { $objectToArray: '$$ROOT' } } } ]
            }
        };
        const lookupWithoutOrder =
        {
            $lookup:
            {
                from     : 'c',
                as       : 'out',
                pipeline : [ { $match: { a: 1 } } ]
            }
        };
        const simpleLookup = { $lookup: { from: 'c', as: 'out' } };
        const malformedLookup = { $lookup: 'invalid' };

        expect( stageReadsFieldOrder( lookupWithOrder )).toBe( true );
        expect( stageReadsFieldOrder( lookupWithoutOrder )).toBe( false );
        expect( stageReadsFieldOrder( simpleLookup )).toBe( false );
        expect( stageReadsFieldOrder( malformedLookup )).toBe( false );

        const facetWithOrder =
        {
            $facet:
            {
                branch : [ { $project: { arr: { $objectToArray: '$$ROOT' } } } ]
            }
        };
        const facetWithoutOrder =
        {
            $facet:
            {
                branch : [ { $match: { a: 1 } } ]
            }
        };
        const facetWithNonArray = { $facet: { branch: 'invalid' } };
        const malformedFacet = { $facet: 'invalid' };

        expect( stageReadsFieldOrder( facetWithOrder )).toBe( true );
        expect( stageReadsFieldOrder( facetWithoutOrder )).toBe( false );
        expect( stageReadsFieldOrder( facetWithNonArray )).toBe( false );
        expect( stageReadsFieldOrder( malformedFacet )).toBe( false );

        const unionWithOrder =
        {
            $unionWith:
            {
                coll     : 'c',
                pipeline : [ { $project: { arr: { $objectToArray: '$$ROOT' } } } ]
            }
        };
        const unionWithoutOrder =
        {
            $unionWith:
            {
                coll     : 'c',
                pipeline : [ { $match: { a: 1 } } ]
            }
        };
        const simpleUnion = { $unionWith: 'coll' };
        const malformedUnion = { $unionWith: 123 };

        expect( stageReadsFieldOrder( unionWithOrder )).toBe( true );
        expect( stageReadsFieldOrder( unionWithoutOrder )).toBe( false );
        expect( stageReadsFieldOrder( simpleUnion )).toBe( false );
        expect( stageReadsFieldOrder( malformedUnion )).toBe( false );
    });

    it( 'returns false for pipelines and stages that do not read field order', () =>
    {
        const pipeline =
        [
            { $match: { status: 'active', score: { $gt: 10 } } },
            { $sort: { score: -1 } },
            { $limit: 10 }
        ];

        expect( pipelineReadsFieldOrder( pipeline )).toBe( false );
        expect( pipelineReadsFieldOrder( null as any )).toBe( false );
        expect( stageReadsFieldOrder( null )).toBe( false );
        expect( stageReadsFieldOrder( {} )).toBe( false );
    });
});

describe( 'canMoveStageAcrossStage', () =>
{
    it( 'allows moving $limit across a $toInt stage in default mode and refuses in strict-errors mode', () =>
    {
        const limitStage = { $limit: 10 };
        const toIntStage = { $addFields: { parsed: { $toInt: '$raw' } } };

        expect( canMoveStageAcrossStage( limitStage, toIntStage, 'earlier', DEFAULT_CONTEXT )).toBe( true );
        expect( canMoveStageAcrossStage( limitStage, toIntStage, 'earlier', STRICT_ERRORS_CONTEXT )).toBe( false );
        expect( canMoveStageAcrossStage( toIntStage, limitStage, 'earlier', STRICT_ERRORS_CONTEXT )).toBe( false );
        expect( canMoveStageAcrossStage( limitStage, { $sort: { a: 1 } }, 'earlier', STRICT_ERRORS_CONTEXT )).toBe( true );
    });

    it( 'refuses moving a $toInt stage earlier across a $match in every mode because it would see new rows', () =>
    {
        const toIntStage = { $addFields: { parsed: { $toInt: '$raw' } } };
        const matchStage = { $match: { active: true } };

        expect( canMoveStageAcrossStage( toIntStage, matchStage, 'earlier', DEFAULT_CONTEXT )).toBe( false );
        expect( canMoveStageAcrossStage( toIntStage, matchStage, 'earlier', STRICT_ERRORS_CONTEXT )).toBe( false );
    });

    it( 'allows moving a $toInt stage earlier across a non-filtering stage like $sort in default mode', () =>
    {
        const toIntStage = { $addFields: { parsed: { $toInt: '$raw' } } };
        const sortStage = { $sort: { score: 1 } };

        expect( canMoveStageAcrossStage( toIntStage, sortStage, 'earlier', DEFAULT_CONTEXT )).toBe( true );
    });

    it( 'refuses moving $addFields across $lookup under strictFieldOrder and allows otherwise', () =>
    {
        const addFieldsStage = { $addFields: { score: 10 } };
        const lookupStage = { $lookup: { from: 'c', as: 'items' } };

        expect( canMoveStageAcrossStage( addFieldsStage, lookupStage, 'earlier', STRICT_FIELD_ORDER_CONTEXT )).toBe( false );
        expect( canMoveStageAcrossStage( addFieldsStage, lookupStage, 'earlier', DEFAULT_CONTEXT )).toBe( true );
    });

    it( 'allows moving $sort across $lookup under strictFieldOrder because $sort adds no fields', () =>
    {
        const sortStage = { $sort: { score: -1 } };
        const lookupStage = { $lookup: { from: 'c', as: 'items' } };

        expect( canMoveStageAcrossStage( sortStage, lookupStage, 'earlier', STRICT_FIELD_ORDER_CONTEXT )).toBe( true );
        expect( canMoveStageAcrossStage( lookupStage, sortStage, 'earlier', STRICT_FIELD_ORDER_CONTEXT )).toBe( true );
    });

    it( 'refuses field-order reordering in default mode if downstream reads field order', () =>
    {
        const addFieldsStage = { $addFields: { score: 10 } };
        const lookupStage = { $lookup: { from: 'c', as: 'items' } };
        const downstream = [ { $project: { arr: { $objectToArray: '$$ROOT' } } } ];

        expect( canMoveStageAcrossStage( addFieldsStage, lookupStage, 'earlier', DEFAULT_CONTEXT, downstream )).toBe( false );
        expect( canMoveStageAcrossStage( addFieldsStage, lookupStage, 'later', DEFAULT_CONTEXT, downstream )).toBe( false );
    });

    it( 'handles moving later across expanding stages', () =>
    {
        const toIntStage = { $addFields: { parsed: { $toInt: '$raw' } } };
        const safeStage = { $addFields: { ok: 1 } };
        const unwindStage = { $unwind: '$items' };
        const sortStage = { $sort: { score: 1 } };

        expect( canMoveStageAcrossStage( toIntStage, unwindStage, 'later', DEFAULT_CONTEXT )).toBe( false );
        expect( canMoveStageAcrossStage( safeStage, unwindStage, 'later', DEFAULT_CONTEXT )).toBe( true );
        expect( canMoveStageAcrossStage( toIntStage, sortStage, 'later', DEFAULT_CONTEXT )).toBe( true );
    });
});

describe( 'canRemoveStage & canSplitFieldAddingStage', () =>
{
    it( 'refuses removing a stage that may error only in strict-errors mode', () =>
    {
        const toIntStage = { $addFields: { parsed: { $toInt: '$raw' } } };
        const safeStage = { $addFields: { ok: 1 } };

        expect( canRemoveStage( toIntStage, DEFAULT_CONTEXT )).toBe( true );
        expect( canRemoveStage( toIntStage, STRICT_ERRORS_CONTEXT )).toBe( false );
        expect( canRemoveStage( safeStage, STRICT_ERRORS_CONTEXT )).toBe( true );
    });

    it( 'governs splitting field-adding stages under strictFieldOrder and downstream field-order reads', () =>
    {
        const lookupStage = { $lookup: { from: 'c', as: 'items' } };
        const sortStage = { $sort: { a: 1 } };
        const downstream = [ { $project: { arr: { $objectToArray: '$$ROOT' } } } ];

        expect( canSplitFieldAddingStage( sortStage, STRICT_FIELD_ORDER_CONTEXT )).toBe( true );
        expect( canSplitFieldAddingStage( lookupStage, STRICT_FIELD_ORDER_CONTEXT )).toBe( false );
        expect( canSplitFieldAddingStage( lookupStage, DEFAULT_CONTEXT, downstream )).toBe( false );
        expect( canSplitFieldAddingStage( lookupStage, DEFAULT_CONTEXT, [] )).toBe( true );
    });
});
