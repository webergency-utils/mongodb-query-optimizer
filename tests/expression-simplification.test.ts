import { describe, expect, it } from 'vitest';
import { resolvePipelineGuarantees } from '../src/guarantees.js';
import
{
    ExpressionSimplificationPass,
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

    it( 'identifies truthy constants correctly across all branches', () =>
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
