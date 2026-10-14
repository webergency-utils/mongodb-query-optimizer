import { describe, expect, it } from 'vitest';
import { resolvePipelineGuarantees } from '../src/guarantees.js';
import
{
    ExpressionSimplificationPass,
    extractStringConstant,
    isFalsyConstant,
    isNonNullConstant,
    isTruthyConstant,
    simplifyExpression
}
from '../src/passes/expression-simplification.js';
import { runMockPipeline } from './helpers/mock-engine.js';

describe( 'ExpressionSimplificationPass unit and proof tests', () =>
{
    const defaultContext = resolvePipelineGuarantees( [], {} );
    const strictErrors = resolvePipelineGuarantees( [], { strictErrors: true } );
    const pass = new ExpressionSimplificationPass();

    it( 'identifies truthy, falsy, and non-null constants correctly across all branches', () =>
    {
        // Primitive truthy constants
        expect( isTruthyConstant( true )).toBe( true );
        expect( isTruthyConstant( 1 )).toBe( true );
        expect( isTruthyConstant( -5 )).toBe( true );
        expect( isTruthyConstant( 'hello' )).toBe( true );
        expect( isTruthyConstant( '' )).toBe( true );
        expect( isTruthyConstant( {} )).toBe( true );

        // Field and variable references are not constants
        expect( isTruthyConstant( '$a' )).toBe( false );
        expect( isTruthyConstant( '$$var' )).toBe( false );
        expect( isTruthyConstant( '$$this.x' )).toBe( false );

        // Falsy primitives
        expect( isTruthyConstant( false )).toBe( false );
        expect( isTruthyConstant( 0 )).toBe( false );
        expect( isTruthyConstant( Number.NaN )).toBe( false );
        expect( isTruthyConstant( null )).toBe( false );
        expect( isTruthyConstant( undefined )).toBe( false );

        // Non-empty objects that are not $literal
        expect( isTruthyConstant({ a: 1 })).toBe( false );
        expect( isTruthyConstant({ $gt: [ '$a', 1 ] })).toBe( false );

        // $literal truthy constants
        expect( isTruthyConstant({ $literal: true })).toBe( true );
        expect( isTruthyConstant({ $literal: 42 })).toBe( true );
        expect( isTruthyConstant({ $literal: '$path' })).toBe( true );
        expect( isTruthyConstant({ $literal: {} })).toBe( true );

        // $literal falsy or non-constant values
        expect( isTruthyConstant({ $literal: false })).toBe( false );
        expect( isTruthyConstant({ $literal: 0 })).toBe( false );
        expect( isTruthyConstant({ $literal: Number.NaN })).toBe( false );
        expect( isTruthyConstant({ $literal: null })).toBe( false );
        expect( isTruthyConstant({ $literal: { a: 1 } })).toBe( false );

        // isFalsyConstant
        expect( isFalsyConstant( false )).toBe( true );
        expect( isFalsyConstant( 0 )).toBe( true );
        expect( isFalsyConstant( null )).toBe( true );
        expect( isFalsyConstant({ $literal: false })).toBe( true );
        expect( isFalsyConstant({ $literal: 0 })).toBe( true );
        expect( isFalsyConstant({ $literal: null })).toBe( true );
        expect( isFalsyConstant({ $literal: 1 })).toBe( false );
        expect( isFalsyConstant({ a: 1 })).toBe( false );
        expect( isFalsyConstant( '$a' )).toBe( false );
        expect( isFalsyConstant( true )).toBe( false );

        // isNonNullConstant
        expect( isNonNullConstant( true )).toBe( true );
        expect( isNonNullConstant( false )).toBe( true );
        expect( isNonNullConstant( 0 )).toBe( true );
        expect( isNonNullConstant( 'abc' )).toBe( true );
        expect( isNonNullConstant({ $literal: false })).toBe( true );
        expect( isNonNullConstant({ $literal: 0 })).toBe( true );
        expect( isNonNullConstant({ $literal: null })).toBe( false );
        expect( isNonNullConstant( null )).toBe( false );
        expect( isNonNullConstant( '$a' )).toBe( false );
        expect( isNonNullConstant({ a: 1 })).toBe( false );
    });

    it( 'folds $size over $filter with all-truthy cond and no limit (AE6)', () =>
    {
        const expr = {
            $size: {
                $filter: {
                    input: '$items',
                    as: 'item',
                    cond: {
                        $and: [ {}, {} ]
                    }
                }
            }
        };

        expect( simplifyExpression( expr )).toEqual({ $size: '$items' });
    });

    it( 'leaves $size over $filter unchanged when limit is present (AE6)', () =>
    {
        const expr = {
            $size: {
                $filter: {
                    input: '$items',
                    as: 'item',
                    limit: 2,
                    cond: {
                        $and: [ {}, {} ]
                    }
                }
            }
        };

        expect( simplifyExpression( expr )).toEqual({
            $size: {
                $filter: {
                    input: '$items',
                    as: 'item',
                    limit: 2,
                    cond: true
                }
            }
        });
    });

    it( 'leaves cond unchanged when it reads a field or variable', () =>
    {
        const expr = {
            $size: {
                $filter: {
                    input: '$items',
                    as: 'item',
                    cond: '$$item.active'
                }
            }
        };

        expect( simplifyExpression( expr )).toEqual( expr );
    });

    it( 'folds, short-circuits, and prunes truthy identity constants in $and', () =>
    {
        expect( simplifyExpression({ $and: [ true, 1, 'a', {} ] })).toBe( true );
        expect( simplifyExpression({ $and: [ true, '$a' ] })).toEqual({ $and: [ '$a' ] });
        expect( simplifyExpression({ $and: [ '$a', '$b' ] })).toEqual({ $and: [ '$a', '$b' ] });
        expect( simplifyExpression({ $and: [ false, '$a' ] })).toBe( false );
        expect( simplifyExpression({ $and: [ 0, { $eq: [ '$a', 1 ] } ] })).toBe( false );
    });

    it( 'folds, short-circuits, and prunes falsy identity constants in $or', () =>
    {
        expect( simplifyExpression({ $or: [ true, 10 ] })).toBe( true );
        expect( simplifyExpression({ $or: [ 0, null ] })).toBe( false );
        expect( simplifyExpression({ $or: [ 0, null, '$a' ] })).toEqual({ $or: [ '$a' ] });
        expect( simplifyExpression({ $or: [ '$a', '$b' ] })).toEqual({ $or: [ '$a', '$b' ] });
        expect( simplifyExpression({ $or: [ true, '$a' ] })).toBe( true );
        expect( simplifyExpression({ $or: [ '$a', 1 ] })).toBe( true );
    });

    it( 'does not fold empty $or since $or: [] evaluates to false in MongoDB', () =>
    {
        const emptyOr = { $or: [] };
        expect( simplifyExpression( emptyOr )).toEqual( emptyOr );
    });

    it( 'folds $not over truthy and falsy constants and preserves dynamic operands', () =>
    {
        expect( simplifyExpression({ $not: [ true ] })).toBe( false );
        expect( simplifyExpression({ $not: [ 42 ] })).toBe( false );
        expect( simplifyExpression({ $not: [ false ] })).toBe( true );
        expect( simplifyExpression({ $not: [ null ] })).toBe( true );
        expect( simplifyExpression({ $not: [ 0 ] })).toBe( true );
        expect( simplifyExpression({ $not: [ '$flag' ] })).toEqual({ $not: [ '$flag' ] });
        expect( simplifyExpression({ $not: [ true, false ] })).toEqual({ $not: [ true, false ] });
    });

    it( 'folds $cond in both array and object forms when condition is a constant', () =>
    {
        expect( simplifyExpression({ $cond: [ true, '$a', '$b' ] })).toBe( '$a' );
        expect( simplifyExpression({ $cond: [ false, '$a', '$b' ] })).toBe( '$b' );
        expect( simplifyExpression({ $cond: [ null, '$a', '$b' ] })).toBe( '$b' );
        expect( simplifyExpression({ $cond: [ '$flag', '$a', '$b' ] })).toEqual({ $cond: [ '$flag', '$a', '$b' ] });
        expect( simplifyExpression({ $cond: [ true, '$a' ] })).toEqual({ $cond: [ true, '$a' ] });

        expect( simplifyExpression({ $cond: { if: 1, then: '$x', else: '$y' } })).toBe( '$x' );
        expect( simplifyExpression({ $cond: { if: 0, then: '$x', else: '$y' } })).toBe( '$y' );
        expect( simplifyExpression({ $cond: { if: '$flag', then: '$x', else: '$y' } })).toEqual({
            $cond: { if: '$flag', then: '$x', else: '$y' }
        });
        expect( simplifyExpression({ $cond: { if: true, then: '$x' } })).toEqual({
            $cond: { if: true, then: '$x' }
        });
        expect( simplifyExpression({ $cond: 'invalid' })).toEqual({ $cond: 'invalid' });
    });

    it( 'simplifies $switch branches with constant case conditions and folds deterministic matches', () =>
    {
        // First branch is truthy constant -> returns its then expression
        expect( simplifyExpression({
            $switch: {
                branches: [
                    { case: true, then: '$first' },
                    { case: '$cond2', then: '$second' }
                ],
                default: '$fallback'
            }
        })).toBe( '$first' );

        // Prunes leading falsy constant branch and folds the next truthy constant branch
        expect( simplifyExpression({
            $switch: {
                branches: [
                    { case: false, then: '$never' },
                    { case: 1, then: '$winner' }
                ]
            }
        })).toBe( '$winner' );

        // All branches falsy with default -> folds to default
        expect( simplifyExpression({
            $switch: {
                branches: [
                    { case: false, then: '$a' },
                    { case: null, then: '$b' }
                ],
                default: '$fallback'
            }
        })).toBe( '$fallback' );

        // All branches falsy WITHOUT default -> preserved because MongoDB throws at runtime
        const noDefaultSwitch = {
            $switch: {
                branches: [
                    { case: false, then: '$a' }
                ]
            }
        };
        expect( simplifyExpression( noDefaultSwitch )).toEqual( noDefaultSwitch );

        // Prunes falsy branch when remaining branch is dynamic
        expect( simplifyExpression({
            $switch: {
                branches: [
                    { case: 0, then: '$dead' },
                    { case: '$liveCond', then: '$liveVal' }
                ],
                default: '$def'
            }
        })).toEqual({
            $switch: {
                branches: [
                    { case: '$liveCond', then: '$liveVal' }
                ],
                default: '$def'
            }
        });

        // Prunes falsy branch when remaining branch is dynamic and no default is present
        expect( simplifyExpression({
            $switch: {
                branches: [
                    { case: 0, then: '$dead' },
                    { case: '$liveCond', then: '$liveVal' }
                ]
            }
        })).toEqual({
            $switch: {
                branches: [
                    { case: '$liveCond', then: '$liveVal' }
                ]
            }
        });

        // Preserves dynamic branches unchanged
        const dynamicSwitch = {
            $switch: {
                branches: [
                    { case: '$c1', then: '$v1' },
                    { case: '$c2', then: '$v2' }
                ]
            }
        };
        expect( simplifyExpression( dynamicSwitch )).toEqual( dynamicSwitch );

        // Malformed $switch shapes are left untouched
        expect( simplifyExpression({ $switch: 'invalid' })).toEqual({ $switch: 'invalid' });
        expect( simplifyExpression({ $switch: { branches: [] } })).toEqual({ $switch: { branches: [] } });
        expect( simplifyExpression({
            $switch: {
                branches: [ { case: true } ]
            }
        })).toEqual({
            $switch: {
                branches: [ { case: true } ]
            }
        });
        expect( simplifyExpression({
            $switch: {
                branches: [ 'not-an-object' ]
            }
        })).toEqual({
            $switch: {
                branches: [ 'not-an-object' ]
            }
        });
    });

    it( 'folds $ifNull with leading non-null constants and strips leading nulls in 3+ chains', () =>
    {
        expect( simplifyExpression({ $ifNull: [ 'fallback', '$a' ] })).toBe( 'fallback' );
        expect( simplifyExpression({ $ifNull: [ 0, '$a' ] })).toBe( 0 );
        expect( simplifyExpression({ $ifNull: [ false, '$a' ] })).toBe( false );
        expect( simplifyExpression({ $ifNull: [ null, 'default', '$a' ] })).toBe( 'default' );
        expect( simplifyExpression({ $ifNull: [ null, '$a', '$b' ] })).toEqual({ $ifNull: [ '$a', '$b' ] });
        expect( simplifyExpression({ $ifNull: [ null, '$a' ] })).toEqual({ $ifNull: [ null, '$a' ] });
        expect( simplifyExpression({ $ifNull: [ '$a', '$b' ] })).toEqual({ $ifNull: [ '$a', '$b' ] });
        expect( simplifyExpression({ $ifNull: [ '$a' ] })).toEqual({ $ifNull: [ '$a' ] });
    });

    it( 'folds constant $add, $multiply, $subtract, $concat, and comparison expressions', () =>
    {
        expect( extractStringConstant( 'hello' )).toBe( 'hello' );
        expect( extractStringConstant( '$field' )).toBeNull();
        expect( extractStringConstant({ $literal: '$field' })).toBe( '$field' );
        expect( extractStringConstant({ $literal: 123 })).toBeNull();
        expect( extractStringConstant( 123 )).toBeNull();

        expect( simplifyExpression({ $add: [ 1, 2, 3 ] })).toBe( 6 );
        expect( simplifyExpression({ $add: [ 1, '$x' ] })).toEqual({ $add: [ 1, '$x' ] });
        expect( simplifyExpression({ $add: [] })).toEqual({ $add: [] });

        expect( simplifyExpression({ $multiply: [ 2, 3, 4 ] })).toBe( 24 );
        expect( simplifyExpression({ $multiply: [ 2, '$x' ] })).toEqual({ $multiply: [ 2, '$x' ] });
        expect( simplifyExpression({ $multiply: [] })).toEqual({ $multiply: [] });

        expect( simplifyExpression({ $subtract: [ 10, 4 ] })).toBe( 6 );
        expect( simplifyExpression({ $subtract: [ 10, '$x' ] })).toEqual({ $subtract: [ 10, '$x' ] });
        expect( simplifyExpression({ $subtract: [ '$x', 4 ] })).toEqual({ $subtract: [ '$x', 4 ] });
        expect( simplifyExpression({ $subtract: [ 10 ] })).toEqual({ $subtract: [ 10 ] });

        expect( simplifyExpression({ $concat: [ 'foo', '-', 'bar' ] })).toBe( 'foo-bar' );
        expect( simplifyExpression({ $concat: [ { $literal: '$a' }, '-b' ] })).toEqual({ $literal: '$a-b' });
        expect( simplifyExpression({ $concat: [ 'foo', '$bar' ] })).toEqual({ $concat: [ 'foo', '$bar' ] });
        expect( simplifyExpression({ $concat: [] })).toEqual({ $concat: [] });

        // Numeric and string constant comparisons
        expect( simplifyExpression({ $eq: [ 5, 5 ] })).toBe( true );
        expect( simplifyExpression({ $eq: [ 5, 6 ] })).toBe( false );
        expect( simplifyExpression({ $ne: [ 'a', 'b' ] })).toBe( true );
        expect( simplifyExpression({ $ne: [ 'a', 'a' ] })).toBe( false );
        expect( simplifyExpression({ $gt: [ 10, 3 ] })).toBe( true );
        expect( simplifyExpression({ $gt: [ 'b', 'a' ] })).toBe( true );
        expect( simplifyExpression({ $gte: [ 3, 3 ] })).toBe( true );
        expect( simplifyExpression({ $gte: [ 'a', 'b' ] })).toBe( false );
        expect( simplifyExpression({ $lt: [ 2, 5 ] })).toBe( true );
        expect( simplifyExpression({ $lt: [ 'a', 'b' ] })).toBe( true );
        expect( simplifyExpression({ $lte: [ 5, 5 ] })).toBe( true );
        expect( simplifyExpression({ $lte: [ 'b', 'a' ] })).toBe( false );
        expect( simplifyExpression({ $cmp: [ 1, 2 ] })).toBe( -1 );
        expect( simplifyExpression({ $cmp: [ 2, 2 ] })).toBe( 0 );
        expect( simplifyExpression({ $cmp: [ 5, 2 ] })).toBe( 1 );
        expect( simplifyExpression({ $cmp: [ 'a', 'b' ] })).toBe( -1 );
        expect( simplifyExpression({ $cmp: [ 'b', 'b' ] })).toBe( 0 );
        expect( simplifyExpression({ $cmp: [ 'c', 'b' ] })).toBe( 1 );

        // Preserves mixed-type, dynamic, or invalid-arity comparisons
        expect( simplifyExpression({ $eq: [ 5, '5' ] })).toEqual({ $eq: [ 5, '5' ] });
        expect( simplifyExpression({ $gt: [ '$x', 5 ] })).toEqual({ $gt: [ '$x', 5 ] });
        expect( simplifyExpression({ $eq: [ 1 ] })).toEqual({ $eq: [ 1 ] });

        // Constant $abs, $ceil, $floor (including -0 normalization and array/scalar operand forms)
        expect( simplifyExpression({ $abs: -42 })).toBe( 42 );
        expect( simplifyExpression({ $abs: [ -0 ] })).toBe( 0 );
        expect( simplifyExpression({ $ceil: 1.2 })).toBe( 2 );
        expect( simplifyExpression({ $ceil: [ -0.5 ] })).toBe( 0 );
        expect( simplifyExpression({ $floor: [ 1.8 ] })).toBe( 1 );
        expect( simplifyExpression({ $abs: '$x' })).toEqual({ $abs: '$x' });
        expect( simplifyExpression({ $abs: [ 1, 2 ] })).toEqual({ $abs: [ 1, 2 ] });

        // Constant ASCII $toLower and $toUpper
        expect( simplifyExpression({ $toLower: 'HELLO' })).toBe( 'hello' );
        expect( simplifyExpression({ $toUpper: [ 'hello' ] })).toBe( 'HELLO' );
        expect( simplifyExpression({ $toLower: { $literal: '$FOO' } })).toEqual({ $literal: '$foo' });
        expect( simplifyExpression({ $toLower: 'ümlaut' })).toEqual({ $toLower: 'ümlaut' });
        expect( simplifyExpression({ $toLower: '$field' })).toEqual({ $toLower: '$field' });
        expect( simplifyExpression({ $toLower: [ 'a', 'b' ] })).toEqual({ $toLower: [ 'a', 'b' ] });

        // Constant $in membership
        expect( simplifyExpression({ $in: [ 'b', [ 'a', 'b', 'c' ] ] })).toBe( true );
        expect( simplifyExpression({ $in: [ 4, [ 1, 2, 3 ] ] })).toBe( false );
        expect( simplifyExpression({ $in: [ true, [ false, null, true ] ] })).toBe( true );
        expect( simplifyExpression({ $in: [ '$x', [ 'a', 'b' ] ] })).toEqual({ $in: [ '$x', [ 'a', 'b' ] ] });
        expect( simplifyExpression({ $in: [ 'a', [ '$x', 'b' ] ] })).toEqual({ $in: [ 'a', [ '$x', 'b' ] ] });

        // Constant $divide and $mod
        expect( simplifyExpression({ $divide: [ 10, 2 ] })).toBe( 5 );
        expect( simplifyExpression({ $divide: [ -0, 2 ] })).toBe( 0 );
        expect( simplifyExpression({ $divide: [ 10, 0 ] })).toEqual({ $divide: [ 10, 0 ] });
        expect( simplifyExpression({ $divide: [ Number.MAX_VALUE, 1e-300 ] })).toEqual({ $divide: [ Number.MAX_VALUE, 1e-300 ] });
        expect( simplifyExpression({ $mod: [ 10, 3 ] })).toBe( 1 );
        expect( simplifyExpression({ $mod: [ -4, 2 ] })).toBe( 0 );
        expect( simplifyExpression({ $mod: [ 10, 0 ] })).toEqual({ $mod: [ 10, 0 ] });

        // Constant $strLenBytes and $strLenCP
        expect( simplifyExpression({ $strLenBytes: 'ümlaut' })).toBe( 7 );
        expect( simplifyExpression({ $strLenCP: [ 'ümlaut' ] })).toBe( 6 );
        expect( simplifyExpression({ $strLenBytes: '$field' })).toEqual({ $strLenBytes: '$field' });

        // Single-element $and / $or unwrapping over boolean-producing expressions
        expect( simplifyExpression({ $and: [ { $eq: [ '$a', 1 ] } ] })).toEqual({ $eq: [ '$a', 1 ] });
        expect( simplifyExpression({ $or: [ { $gt: [ '$a', 5 ] } ] })).toEqual({ $gt: [ '$a', 5 ] });
        expect( simplifyExpression({ $or: [ false, { $gt: [ '$a', 5 ] } ] })).toEqual({ $gt: [ '$a', 5 ] });
        expect( simplifyExpression({ $and: [ '$flag' ] })).toEqual({ $and: [ '$flag' ] });
        expect( simplifyExpression({ $or: [ '$flag' ] })).toEqual({ $or: [ '$flag' ] });

        // Idempotent $cond (array and object forms)
        expect( simplifyExpression({ $cond: [ '$flag', 42, 42 ] })).toBe( 42 );
        expect( simplifyExpression({ $cond: [ { $eq: [ '$a', 1 ] }, { $literal: '$foo' }, { $literal: '$foo' } ] })).toEqual({ $literal: '$foo' });
        expect( simplifyExpression({ $cond: { if: '$flag', then: 'same', else: 'same' } })).toBe( 'same' );
        expect( simplifyExpression({ $cond: { if: '$flag', then: { $literal: '$x' }, else: { $literal: '$x' } } })).toEqual({ $literal: '$x' });
        expect( simplifyExpression({ $cond: [ { $divide: [ '$a', '$b' ] }, 42, 42 ] })).toEqual({ $cond: [ { $divide: [ '$a', '$b' ] }, 42, 42 ] });
        expect( simplifyExpression({ $cond: [ { $rand: {} }, 42, 42 ] })).toEqual({ $cond: [ { $rand: {} }, 42, 42 ] });

        // Boolean operand deduplication in $and / $or and identical $ifNull collapse (#20)
        expect( simplifyExpression({
            $and: [
                { $eq: [ '$a', 1 ] },
                { $eq: [ '$a', 1 ] },
                { $gt: [ '$b', 2 ] }
            ]
        })).toEqual({
            $and: [
                { $eq: [ '$a', 1 ] },
                { $gt: [ '$b', 2 ] }
            ]
        });

        expect( simplifyExpression({
            $or: [
                { $eq: [ '$a', 1 ] },
                { $eq: [ '$a', 1 ] }
            ]
        })).toEqual({ $eq: [ '$a', 1 ] });

        expect( simplifyExpression({ $ifNull: [ '$x', '$x' ] })).toBe( '$x' );
        expect( simplifyExpression({
            $ifNull: [ { $eq: [ '$a', 1 ] }, { $eq: [ '$a', 1 ] } ]
        })).toEqual({ $eq: [ '$a', 1 ] });
        expect( simplifyExpression({
            $cond: [ '$flag', { $eq: [ '$a', 1 ] }, { $eq: [ '$a', 1 ] } ]
        })).toEqual({ $eq: [ '$a', 1 ] });
        expect( simplifyExpression({
            $cond: { if: '$flag', then: { $eq: [ '$a', 1 ] }, else: { $eq: [ '$a', 1 ] } }
        })).toEqual({ $eq: [ '$a', 1 ] });
        expect( simplifyExpression({ $ifNull: [ { $rand: {} }, { $rand: {} } ] })).toEqual({
            $ifNull: [ { $rand: {} }, { $rand: {} } ]
        });

        // Boolean constant comparisons (#20)
        expect( simplifyExpression({ $eq: [ true, true ] })).toBe( true );
        expect( simplifyExpression({ $eq: [ true, false ] })).toBe( false );
        expect( simplifyExpression({ $ne: [ true, false ] })).toBe( true );
        expect( simplifyExpression({ $ne: [ false, false ] })).toBe( false );

        // Math operators: $sqrt, $pow, $trunc, $round (#19)
        expect( simplifyExpression({ $sqrt: 16 })).toBe( 4 );
        expect( simplifyExpression({ $sqrt: [ 0 ] })).toBe( 0 );
        expect( simplifyExpression({ $sqrt: -1 })).toEqual({ $sqrt: -1 });
        expect( simplifyExpression({ $pow: [ 2, 10 ] })).toBe( 1024 );
        expect( simplifyExpression({ $pow: [ 0, 2 ] })).toBe( 0 );
        expect( simplifyExpression({ $pow: [ 10, 1000 ] })).toEqual({ $pow: [ 10, 1000 ] });
        expect( simplifyExpression({ $pow: [ '$x', 2 ] })).toEqual({ $pow: [ '$x', 2 ] });
        expect( simplifyExpression({ $trunc: 3.9 })).toBe( 3 );
        expect( simplifyExpression({ $trunc: [ -0.4 ] })).toBe( 0 );
        expect( simplifyExpression({ $trunc: [ 3.9, 0 ] })).toBe( 3 );
        expect( simplifyExpression({ $trunc: [ -0.4, 0 ] })).toBe( 0 );
        expect( simplifyExpression({ $trunc: [ 3.9, 1 ] })).toEqual({ $trunc: [ 3.9, 1 ] });
        expect( simplifyExpression({ $round: 3.6 })).toBe( 4 );
        expect( simplifyExpression({ $round: [ -0.2 ] })).toBe( 0 );
        expect( simplifyExpression({ $round: [ 3.6, 0 ] })).toBe( 4 );
        expect( simplifyExpression({ $round: [ -0.2, 0 ] })).toBe( 0 );

        // String operators: $trim, $ltrim, $rtrim, $substrBytes, $substrCP (#19)
        expect( simplifyExpression({ $trim: { input: '  hello  ' } })).toBe( 'hello' );
        expect( simplifyExpression({ $ltrim: { input: '  hello  ' } })).toBe( 'hello  ' );
        expect( simplifyExpression({ $rtrim: { input: '  $hello  ' } })).toBe( '  $hello' );
        expect( simplifyExpression({ $ltrim: { input: '  $hello' } })).toEqual({ $literal: '$hello' });
        expect( simplifyExpression({ $trim: { input: '  hello  ', chars: ' ' } })).toEqual({
            $trim: { input: '  hello  ', chars: ' ' }
        });
        expect( simplifyExpression({ $trim: { input: '$field' } })).toEqual({ $trim: { input: '$field' } });
        expect( simplifyExpression({ $substrBytes: [ 'abcdef', 1, 3 ] })).toBe( 'bcd' );
        expect( simplifyExpression({ $substrCP: [ 'a$bc', 1, 3 ] })).toEqual({ $literal: '$bc' });
        expect( simplifyExpression({ $substrCP: [ '$field', 0, 2 ] })).toEqual({ $substrCP: [ '$field', 0, 2 ] });

        // Array operators: $concatArrays, $isArray, $arrayElemAt, $first, $last, $reverseArray (#18)
        expect( simplifyExpression({ $concatArrays: [ [ 1, 2 ], [ 'a', true ] ] })).toEqual([ 1, 2, 'a', true ]);
        expect( simplifyExpression({ $concatArrays: [ [ 1 ], '$dynamic' ] })).toEqual({
            $concatArrays: [ [ 1 ], '$dynamic' ]
        });
        expect( simplifyExpression({ $isArray: [ [ 1, 2 ] ] })).toBe( true );
        expect( simplifyExpression({ $isArray: 'scalar' })).toBe( false );
        expect( simplifyExpression({ $isArray: '$field' })).toEqual({ $isArray: '$field' });
        expect( simplifyExpression({ $isArray: [ 1, 2 ] })).toEqual({ $isArray: [ 1, 2 ] });
        expect( simplifyExpression({ $arrayElemAt: [ [ 'a', 'b', 'c' ], 1 ] })).toBe( 'b' );
        expect( simplifyExpression({ $arrayElemAt: [ [ 'a', 'b', 'c' ], -1 ] })).toBe( 'c' );
        expect( simplifyExpression({ $arrayElemAt: [ [ 'a', 'b' ], 5 ] })).toEqual({
            $arrayElemAt: [ [ 'a', 'b' ], 5 ]
        });
        expect( simplifyExpression({ $arrayElemAt: [ '$arr', 0 ] })).toEqual({
            $arrayElemAt: [ '$arr', 0 ]
        });
        expect( simplifyExpression({ $first: [ [ 10, 20, 30 ] ] })).toBe( 10 );
        expect( simplifyExpression({ $last: [ [ 10, 20, 30 ] ] })).toBe( 30 );
        expect( simplifyExpression({ $first: [ [] ] })).toEqual({ $first: [ [] ] });
        expect( simplifyExpression({ $first: '$arr' })).toEqual({ $first: '$arr' });
        expect( simplifyExpression({ $reverseArray: [ [ 1, 2, 3 ] ] })).toEqual([ 3, 2, 1 ]);
        expect( simplifyExpression({ $reverseArray: '$arr' })).toEqual({ $reverseArray: '$arr' });
    });

    it( 'never simplifies or inspects inside $literal subtrees', () =>
    {
        const literalAnd = { $literal: { $and: [ true, true ] } };
        expect( simplifyExpression( literalAnd )).toEqual( literalAnd );

        const nestedLiteral = {
            $add: [
                1,
                { $literal: { $size: { $filter: { input: '$a', cond: {} } } } }
            ]
        };
        expect( simplifyExpression( nestedLiteral )).toEqual( nestedLiteral );
    });

    it( 'skips the simplification pass entirely under strictErrors mode', () =>
    {
        const pipeline = [
            {
                $addFields: {
                    total: {
                        $size: {
                            $filter: {
                                input: '$tags',
                                cond: { $and: [ {}, {} ] }
                            }
                        }
                    }
                }
            }
        ];

        const executed = pass.execute( pipeline, strictErrors );
        expect( executed ).toBe( pipeline );
    });

    it( 'simplifies expressions in $addFields, $set, computed $project, $group, and $match.$expr', () =>
    {
        const pipeline = [
            {
                $addFields: {
                    total: {
                        $size: {
                            $filter: {
                                input: '$tags',
                                cond: { $and: [ {}, {} ] }
                            }
                        }
                    },
                    flag: { $and: [ true, 1 ] }
                }
            },
            {
                $set: {
                    activeCount: {
                        $size: {
                            $filter: {
                                input: '$items',
                                cond: true
                            }
                        }
                    }
                }
            },
            {
                $project: {
                    _id: 0,
                    name: 1,
                    isAllowed: true,
                    total: {
                        $size: {
                            $filter: {
                                input: '$items',
                                cond: { $or: [ 1, 2 ] }
                            }
                        }
                    }
                }
            },
            {
                $group: {
                    _id: { $cond: [ true, '$dept', '$fallback' ] },
                    total: { $sum: { $add: [ 0, 1 ] } },
                    unchanged: { $max: '$score' },
                    countDoc: { $count: {} }
                }
            },
            {
                $match: {
                    $expr: { $and: [ true, { $eq: [ '$dept', 'eng' ] } ] }
                }
            }
        ];

        const optimized = pass.execute( pipeline, defaultContext );
        expect( optimized[ 0 ] ).toEqual({
            $addFields: {
                total: { $size: '$tags' },
                flag: true
            }
        });
        expect( optimized[ 1 ] ).toEqual({
            $set: {
                activeCount: { $size: '$items' }
            }
        });
        expect( optimized[ 2 ] ).toEqual({
            $project: {
                _id: 0,
                name: 1,
                isAllowed: true,
                total: { $size: '$items' }
            }
        });
        expect( optimized[ 3 ] ).toEqual({
            $group: {
                _id: '$dept',
                total: { $sum: 1 },
                unchanged: { $max: '$score' },
                countDoc: { $count: {} }
            }
        });
        expect( optimized[ 4 ] ).toEqual({
            $match: {
                $expr: { $eq: [ '$dept', 'eng' ] }
            }
        });

        // Also handles $group with _id: null and $match.$expr tautologies/contradictions/nested branches
        expect( simplifyExpression({ $add: [ '$x', { $add: [ 1, 2 ] } ] })).toEqual({ $add: [ '$x', 3 ] });
        expect( pass.execute([
            { $group: { _id: null, c: { $sum: 1 }, invalidAcc: 123 } },
            { $match: { $expr: { $eq: [ 1, 1 ] } } },
            { $match: { $expr: { $eq: [ 1, 2 ] } } },
            { $match: { $expr: { $eq: [ '$a', '$b' ] } } },
            { $match: { status: 'active', $expr: { $eq: [ 1, 1 ] } } },
            { $match: { status: 'active', $expr: { $eq: [ 1, 2 ] } } },
            { $match: { status: 'active', $expr: { $eq: [ '$a', '$b' ] } } },
            { $match: { status: 'active', $expr: { $and: [ true, { $eq: [ '$a', '$b' ] } ] } } },
            { $match: { $and: [ { a: 1 }, { $expr: { $eq: [ 1, 1 ] } } ] } },
            { $match: { $and: [ { a: 1 }, { b: 2 } ] } },
            { $match: { a: { $in: 1 } } },
            { $match: { $and: 'malformed' } }
        ], defaultContext )).toEqual([
            { $group: { _id: null, c: { $sum: 1 }, invalidAcc: 123 } },
            { $match: {} },
            { $match: { _id: { $in: [] } } },
            { $match: { $expr: { $eq: [ '$a', '$b' ] } } },
            { $match: { status: 'active' } },
            { $match: { _id: { $in: [] } } },
            { $match: { status: 'active', $expr: { $eq: [ '$a', '$b' ] } } },
            { $match: { status: 'active', $expr: { $eq: [ '$a', '$b' ] } } },
            { $match: { $and: [ { a: 1 }, {} ] } },
            { $match: { $and: [ { a: 1 }, { b: 2 } ] } },
            { $match: { a: { $in: 1 } } },
            { $match: { $and: 'malformed' } }
        ]);

        // Double-negation elimination over boolean-producing operators
        expect( simplifyExpression({
            $not: [ { $not: [ { $gt: [ '$score', 10 ] } ] } ]
        })).toEqual({ $gt: [ '$score', 10 ] });
        expect( simplifyExpression({
            $not: [ { $not: [ { $isArray: '$tags' } ] } ]
        })).toEqual({ $isArray: '$tags' });
        // Preserves double-negation over non-boolean expressions or field paths
        expect( simplifyExpression({
            $not: [ { $not: [ '$flag' ] } ]
        })).toEqual({ $not: [ { $not: [ '$flag' ] } ] });
        expect( simplifyExpression({
            $not: [ { $not: [ { $add: [ '$a', 1 ] } ] } ]
        })).toEqual({ $not: [ { $not: [ { $add: [ '$a', 1 ] } ] } ] });
        expect( simplifyExpression({
            $not: [ { $not: [ { $gt: [ '$a', 1 ], extra: 2 } ] } ]
        })).toEqual({ $not: [ { $not: [ { $gt: [ '$a', 1 ], extra: 2 } ] } ] });
        expect( simplifyExpression({
            $not: [ { $not: [ '$a', '$b' ] } ]
        })).toEqual({ $not: [ { $not: [ '$a', '$b' ] } ] });
    });

    it( 'preserves execution equivalence on mock engine', () =>
    {
        const docs = [
            { _id: 1, tags: [ 'a', 'b', 'c' ] },
            { _id: 2, tags: [] },
            { _id: 3, tags: [ 'x' ] }
        ];

        const pipeline = [
            {
                $addFields: {
                    total: {
                        $size: {
                            $filter: {
                                input: '$tags',
                                cond: { $and: [ {}, {} ] }
                            }
                        }
                    }
                }
            }
        ];

        const original = runMockPipeline( docs, pipeline );
        const optimized = runMockPipeline( docs, pass.execute( pipeline, defaultContext ));

        expect( optimized ).toEqual( original );
        expect( optimized ).toEqual([
            { _id: 1, tags: [ 'a', 'b', 'c' ], total: 3 },
            { _id: 2, tags: [], total: 0 },
            { _id: 3, tags: [ 'x' ], total: 1 }
        ]);
    });

    it( 'returns unchanged pipeline when no simplification applies or stage is non-object', () =>
    {
        const unchanged = [
            { $sort: { _id: 1 } },
            { $limit: 10 },
            { $project: { _id: 0, val: 1 } }
        ];

        expect( pass.execute( unchanged, defaultContext )).toBe( unchanged );
        expect( pass.execute([ null, 'invalid' ], defaultContext )).toEqual([ null, 'invalid' ]);
    });

    it( 'folds constant $size, $filter, $map, type conversions, and string operators and simplifies $bucket/$sortByCount/$replaceRoot/$replaceWith', () =>
    {
        // Constant $size, $filter, $map (#19)
        expect( simplifyExpression({ $size: [ [ 1, 2, 3 ] ] })).toBe( 3 );
        expect( simplifyExpression({ $size: { $filter: { input: [ 10, 20 ], cond: true } } })).toBe( 2 );
        expect( simplifyExpression({ $filter: { input: [ 1, 2 ], cond: true } })).toEqual([ 1, 2 ]);
        expect( simplifyExpression({ $filter: { input: [ 1, 2 ], cond: false } })).toEqual([]);
        expect( simplifyExpression({ $filter: { input: [ 1, 2 ], cond: '$$this' } })).toEqual({
            $filter: { input: [ 1, 2 ], cond: '$$this' }
        });
        expect( simplifyExpression({ $filter: { input: [ 1, 2 ], cond: true, limit: 1 } })).toEqual({
            $filter: { input: [ 1, 2 ], cond: true, limit: 1 }
        });
        expect( simplifyExpression({ $map: { input: [], in: '$$this' } })).toEqual([]);
        expect( simplifyExpression({ $map: { input: [ 1 ], in: '$$this' } })).toEqual({
            $map: { input: [ 1 ], in: '$$this' }
        });

        // Constant $toBool, $toString, $toInt, $toDouble, $type, $split, $indexOfBytes, $indexOfCP (#20)
        expect( simplifyExpression({ $toBool: 1 })).toBe( true );
        expect( simplifyExpression({ $toBool: 0 })).toBe( false );
        expect( simplifyExpression({ $toBool: null })).toEqual({ $toBool: null });
        expect( simplifyExpression({ $toBool: [ 1, 2 ] })).toEqual({ $toBool: [ 1, 2 ] });
        expect( simplifyExpression({ $toBool: '$x' })).toEqual({ $toBool: '$x' });
        expect( simplifyExpression({ $toString: 42 })).toBe( '42' );
        expect( simplifyExpression({ $toString: { $literal: '$abc' } })).toEqual({ $literal: '$abc' });
        expect( simplifyExpression({ $toString: null })).toEqual({ $toString: null });
        expect( simplifyExpression({ $toInt: 3.9 })).toBe( 3 );
        expect( simplifyExpression({ $toInt: -0.2 })).toBe( 0 );
        expect( simplifyExpression({ $toInt: true })).toBe( 1 );
        expect( simplifyExpression({ $toInt: false })).toBe( 0 );
        expect( simplifyExpression({ $toInt: '123' })).toBe( 123 );
        expect( simplifyExpression({ $toInt: '-0' })).toBe( 0 );
        expect( simplifyExpression({ $toInt: '999999999999999999999' })).toEqual({ $toInt: '999999999999999999999' });
        expect( simplifyExpression({ $toInt: 'abc' })).toEqual({ $toInt: 'abc' });
        expect( simplifyExpression({ $toDouble: 5.5 })).toBe( 5.5 );
        expect( simplifyExpression({ $toDouble: -0 })).toBe( 0 );
        expect( simplifyExpression({ $toDouble: true })).toBe( 1 );
        expect( simplifyExpression({ $toDouble: false })).toBe( 0 );
        expect( simplifyExpression({ $toDouble: 'abc' })).toEqual({ $toDouble: 'abc' });
        expect( simplifyExpression({ $type: null })).toBe( 'null' );
        expect( simplifyExpression({ $type: true })).toBe( 'bool' );
        expect( simplifyExpression({ $type: 'hello' })).toBe( 'string' );
        expect( simplifyExpression({ $type: 42 })).toEqual({ $type: 42 });
        expect( simplifyExpression({ $split: [ 'a,b,c', ',' ] })).toEqual([ 'a', 'b', 'c' ]);
        expect( simplifyExpression({ $split: [ '$a,b', ',' ] })).toEqual({ $split: [ '$a,b', ',' ] });
        expect( simplifyExpression({ $split: [ 'a,$b', ',' ] })).toEqual({ $split: [ 'a,$b', ',' ] });
        expect( simplifyExpression({ $indexOfBytes: [ 'hello world', 'world' ] })).toBe( 6 );
        expect( simplifyExpression({ $indexOfCP: [ 'hello', 'z' ] })).toBe( -1 );
        expect( simplifyExpression({ $indexOfCP: [ '$field', 'z' ] })).toEqual({ $indexOfCP: [ '$field', 'z' ] });

        // Stage coverage for $sortByCount, $replaceWith, $replaceRoot, $bucket
        const stagePipeline = [
            { $sortByCount: { $cond: [ true, '$tag', '$other' ] } },
            { $sortByCount: '$tag' },
            { $replaceWith: { a: { $add: [ 1, 2 ] } } },
            { $replaceWith: '$sub' },
            { $replaceRoot: { newRoot: { a: { $add: [ 1, 2 ] } } } },
            { $replaceRoot: { newRoot: '$sub' } },
            {
                $bucket: {
                    groupBy: { $add: [ 1, 2 ] },
                    boundaries: [ 0, 10 ],
                    output: {
                        total: { $sum: { $add: [ 2, 3 ] } },
                        unchanged: { $max: '$x' },
                        nonAccObj: { $unknownAcc: '$x' },
                        nonPlain: 1
                    }
                }
            },
            {
                $bucket: {
                    groupBy: '$year',
                    boundaries: [ 0, 10 ],
                    output: {
                        unchanged: { $max: '$x' }
                    }
                }
            },
            { $bucket: { boundaries: [ 0, 10 ] } },
            { $limit: 5 }
        ];

        const simplifiedStages = pass.execute( stagePipeline, defaultContext );
        expect( simplifiedStages[ 0 ] ).toEqual({ $sortByCount: '$tag' });
        expect( simplifiedStages[ 1 ] ).toEqual({ $sortByCount: '$tag' });
        expect( simplifiedStages[ 2 ] ).toEqual({ $replaceWith: { a: 3 } });
        expect( simplifiedStages[ 3 ] ).toEqual({ $replaceWith: '$sub' });
        expect( simplifiedStages[ 4 ] ).toEqual({ $replaceRoot: { newRoot: { a: 3 } } });
        expect( simplifiedStages[ 5 ] ).toEqual({ $replaceRoot: { newRoot: '$sub' } });
        expect( simplifiedStages[ 6 ] ).toEqual({
            $bucket: {
                groupBy: 3,
                boundaries: [ 0, 10 ],
                output: {
                    total: { $sum: 5 },
                    unchanged: { $max: '$x' },
                    nonAccObj: { $unknownAcc: '$x' },
                    nonPlain: 1
                }
            }
        });
    });

    it( 'caps boolean operand deduplication in $and and $or at 64 items (R4, R5)', () =>
    {
        const oversizedAnd = Array.from({ length: 65 }, ( _, idx ) => (
            idx < 2 ? { $eq: [ '$a', 1 ] } : { $gt: [ `$f${ idx }`, idx ] }
        ));
        const simplifiedAnd = simplifyExpression({ $and: oversizedAnd });
        expect( simplifiedAnd ).toEqual({ $and: oversizedAnd });

        const oversizedOr = Array.from({ length: 65 }, ( _, idx ) => (
            idx < 2 ? { $eq: [ '$a', 1 ] } : { $gt: [ `$f${ idx }`, idx ] }
        ));
        const simplifiedOr = simplifyExpression({ $or: oversizedOr });
        expect( simplifiedOr ).toEqual({ $or: oversizedOr });

        // Mixed boolean-producing expression, non-boolean expression, and duplicate non-boolean operand within the 64-item cap
        expect( simplifyExpression({
            $and: [
                { $eq: [ '$a', 1 ] },
                { $eq: [ '$a', 1 ] },
                { $add: [ '$b', 1 ] },
                { $eq: [ '$divide', { $divide: [ '$a', '$b' ] } ] },
                '$flag'
            ]
        })).toEqual({
            $and: [
                { $eq: [ '$a', 1 ] },
                { $add: [ '$b', 1 ] },
                { $eq: [ '$divide', { $divide: [ '$a', '$b' ] } ] },
                '$flag'
            ]
        });

        // Unwraps single-element $and and $or inside boolean $filter.cond context
        expect( simplifyExpression({
            $filter: {
                input: '$items',
                as: 'item',
                cond: { $and: [ '$$item.active', true ] }
            }
        })).toEqual({
            $filter: {
                input: '$items',
                as: 'item',
                cond: '$$item.active'
            }
        });

        expect( simplifyExpression({
            $filter: {
                input: '$items',
                as: 'item',
                cond: { $or: [ '$$item.active', false ] }
            }
        })).toEqual({
            $filter: {
                input: '$items',
                as: 'item',
                cond: '$$item.active'
            }
        });
    });
});

