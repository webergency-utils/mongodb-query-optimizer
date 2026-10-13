import { describe, expect, it } from 'vitest';
import { arePathsDisjoint } from '../src/passes/path-disjoint.js';

describe( 'proof path overlap', () =>
{
    it( 'treats exact paths with no shared prefix as disjoint', () =>
    {
        expect( arePathsDisjoint( [ 'user.name' ], [ 'order.total' ] )).toBe( true );
    });

    it( 'treats the same path and an ancestor with its descendant as overlap', () =>
    {
        expect( arePathsDisjoint( [ 'user.name' ], [ 'user.name' ] )).toBe( false );
        expect( arePathsDisjoint( [ 'user' ], [ 'user.name' ] )).toBe( false );
        expect( arePathsDisjoint( [ 'user.name' ], [ 'user' ] )).toBe( false );
    });

    it( 'treats an unknown path as overlap', () =>
    {
        expect( arePathsDisjoint( [ '?' ], [ 'profile' ] )).toBe( false );
        expect( arePathsDisjoint( [ 'a.' ], [ 'profile' ] )).toBe( false );
        expect( arePathsDisjoint( [ 'profile' ], [ '?' ] )).toBe( false );
    });

    it( 'treats empty lists as disjoint', () =>
    {
        expect( arePathsDisjoint( [], [] )).toBe( true );
        expect( arePathsDisjoint( [ 'user.name' ], [] )).toBe( true );
        expect( arePathsDisjoint( [], [ 'user.name' ] )).toBe( true );
    });
});
