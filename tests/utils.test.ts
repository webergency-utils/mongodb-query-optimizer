import { describe, expect, it } from 'vitest';
import
{
    isPlainObject,
    isEmptyObject,
    isOperatorSubdocument
}
from '../src/utils.js';
import
{
    getSingleStageEntry,
    getStageSpec,
    isMatchStage,
    isSingleKeyStage
}
from '../src/passes/helpers.js';
import
{
    isExactPath,
    isExactTopLevelPath
}
from '../src/analyzer/paths.js';
import
{
    isValidProjectionPath
}
from '../src/analyzer/projections.js';

describe( 'utils and stage helpers', () =>
{
    describe( 'isPlainObject', () =>
    {
        it( 'returns true for plain object literals and Object.create(null)', () =>
        {
            expect( isPlainObject({ a: 1 })).toBe( true );
            expect( isPlainObject( Object.create( null ))).toBe( true );
            expect( isPlainObject({})).toBe( true );
        });

        it( 'returns false for primitives, arrays, null, undefined, dates, and class instances', () =>
        {
            expect( isPlainObject( null )).toBe( false );
            expect( isPlainObject( undefined )).toBe( false );
            expect( isPlainObject( 123 )).toBe( false );
            expect( isPlainObject( 'str' )).toBe( false );
            expect( isPlainObject( true )).toBe( false );
            expect( isPlainObject([ 1, 2, 3 ])).toBe( false );
            expect( isPlainObject( new Date())).toBe( false );
            expect( isPlainObject( new RegExp( 'abc' ))).toBe( false );

            class Custom {}
            expect( isPlainObject( new Custom())).toBe( false );
        });
    });

    describe( 'isEmptyObject', () =>
    {
        it( 'returns true only for empty plain objects', () =>
        {
            expect( isEmptyObject({})).toBe( true );
            expect( isEmptyObject( Object.create( null ))).toBe( true );
            expect( isEmptyObject({ a: 1 })).toBe( false );
            expect( isEmptyObject( null )).toBe( false );
            expect( isEmptyObject([])).toBe( false );
        });
    });

    describe( 'isOperatorSubdocument', () =>
    {
        it( 'identifies documents where all keys start with $', () =>
        {
            expect( isOperatorSubdocument({ $gt: 5, $lt: 10 })).toBe( true );
            expect( isOperatorSubdocument({ $eq: 1 })).toBe( true );
            expect( isOperatorSubdocument({ a: 1, $gt: 2 })).toBe( false );
            expect( isOperatorSubdocument({})).toBe( false );
            expect( isOperatorSubdocument( null )).toBe( false );
            expect( isOperatorSubdocument( 'not-an-object' )).toBe( false );
        });
    });

    describe( 'stage helpers', () =>
    {
        it( 'getSingleStageEntry extracts single entry from valid stages and returns null otherwise', () =>
        {
            expect( getSingleStageEntry({ $match: { x: 1 } })).toEqual([ '$match', { x: 1 } ]);
            expect( getSingleStageEntry({ $match: 1, $sort: 1 })).toBeNull();
            expect( getSingleStageEntry({})).toBeNull();
            expect( getSingleStageEntry( null )).toBeNull();
            expect( getSingleStageEntry( 'stage' )).toBeNull();
        });

        it( 'getStageSpec retrieves plain object spec matching target operator', () =>
        {
            expect( getStageSpec({ $match: { x: 1 } }, '$match' )).toEqual({ x: 1 });
            expect( getStageSpec({ $match: 'scalar' }, '$match' )).toBeNull();
            expect( getStageSpec({ $sort: { x: 1 } }, '$match' )).toBeNull();
            expect( getStageSpec( null, '$match' )).toBeNull();
        });

        it( 'isMatchStage verifies valid single-key $match stage with plain object filter', () =>
        {
            expect( isMatchStage({ $match: { x: 1 } })).toBe( true );
            expect( isMatchStage({ $match: {} })).toBe( true );
            expect( isMatchStage({ $match: 123 })).toBe( false );
            expect( isMatchStage({ $sort: { x: 1 } })).toBe( false );
            expect( isMatchStage({ $match: {}, extra: 1 })).toBe( false );
            expect( isMatchStage( null )).toBe( false );
        });

        it( 'isSingleKeyStage verifies operator key presence on single-key stages', () =>
        {
            expect( isSingleKeyStage({ $sortByCount: '$dept' }, '$sortByCount' )).toBe( true );
            expect( isSingleKeyStage({ $group: {} }, '$sortByCount' )).toBe( false );
            expect( isSingleKeyStage( null, '$sortByCount' )).toBe( false );
        });
    });

    describe( 'path predicates', () =>
    {
        it( 'isExactPath validates well-formed exact paths and rejects wildcards or invalid paths', () =>
        {
            expect( isExactPath( 'profile.name' )).toBe( true );
            expect( isExactPath( 'status' )).toBe( true );
            expect( isExactPath( '' )).toBe( false );
            expect( isExactPath( '*' )).toBe( false );
            expect( isExactPath( '?' )).toBe( false );
            expect( isExactPath( '$$var' )).toBe( false );
            expect( isExactPath( 'a..b' )).toBe( false );
        });

        it( 'isExactTopLevelPath validates top-level document fields excluding dot paths and $-prefixes', () =>
        {
            expect( isExactTopLevelPath( 'status' )).toBe( true );
            expect( isExactTopLevelPath( 'profile.name' )).toBe( false );
            expect( isExactTopLevelPath( '$status' )).toBe( false );
            expect( isExactTopLevelPath( '' )).toBe( false );
            expect( isExactTopLevelPath( '*' )).toBe( false );
        });

        it( 'isValidProjectionPath checks projection path segment formatting', () =>
        {
            expect( isValidProjectionPath( 'status' )).toBe( true );
            expect( isValidProjectionPath( 'profile.name' )).toBe( true );
            expect( isValidProjectionPath( '' )).toBe( false );
            expect( isValidProjectionPath( '$status' )).toBe( false );
            expect( isValidProjectionPath( 'profile.' )).toBe( false );
            expect( isValidProjectionPath( '.profile' )).toBe( false );
            expect( isValidProjectionPath( 'profile..name' )).toBe( false );
        });
    });
});

