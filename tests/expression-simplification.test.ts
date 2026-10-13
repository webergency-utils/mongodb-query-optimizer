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

    it( 'folds $and with all-truthy constant operands to true', () =>
    {
        expect( simplifyExpression({ $and: [ true, 1, 'a', {} ] })).toBe( true );
    });

    it( 'leaves $and unchanged when any operand is not a truthy constant', () =>
    {
        const expr = { $and: [ true, '$a' ] };
        expect( simplifyExpression( expr )).toEqual( expr );
    });

    it( 'folds $or with all-truthy constant operands to true', () =>
    {
        expect( simplifyExpression({ $or: [ true, 10 ] })).toBe( true );
    });

    it( 'does not fold $or when operands are not truthy constants', () =>
    {
        const falsyOr = { $or: [ 0, null ] };
        expect( simplifyExpression( falsyOr )).toEqual( falsyOr );
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

    it( 'folds constant $add, $multiply, $subtract, and $concat expressions', () =>
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

    it( 'simplifies expressions in $addFields, $set, and computed $project fields', () =>
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
});
