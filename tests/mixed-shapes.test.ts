import { describe, expect, it } from 'vitest';
import {
    MIXED_SHAPE_CATALOG,
    buildMixedShapeDocuments,
    getMixedShapeDefinition,
    setDottedProperty,
} from './fixtures/mixed-shapes.js';

describe( 'Mixed shape catalog and builders', () =>
{
    it( 'contains all eight required shapes from R8 and R16', () =>
    {
        const expectedShapes = [
            'number',
            'min-max',
            'plain-object',
            'number-array',
            'object-array',
            'nested-array',
            'null',
            'missing',
        ];

        const actualShapes = MIXED_SHAPE_CATALOG.map( ( entry ) => entry.type );
        expect( actualShapes ).toEqual( expectedShapes );
    } );

    it( 'retrieves definitions for each known shape and throws for unknown', () =>
    {
        for( const entry of MIXED_SHAPE_CATALOG )
        {
            const found = getMixedShapeDefinition( entry.type );
            expect( found.type ).toBe( entry.type );
        }

        expect( () => getMixedShapeDefinition( 'unknown' as any ) )
            .toThrow( 'Unknown mixed shape type: unknown' );
    } );

    it( 'sets dotted properties correctly on objects', () =>
    {
        const obj: Record<string, unknown> = {};
        setDottedProperty( obj, 'deep.nested.value', 123 );
        expect( obj ).toEqual( { deep: { nested: { value: 123 } } } );

        // Does nothing if value is undefined (missing)
        const empty: Record<string, unknown> = {};
        setDottedProperty( empty, 'ignored', undefined );
        expect( empty ).toEqual( {} );
    } );

    it( 'builds documents covering every shape across the collection', () =>
    {
        const documents = buildMixedShapeDocuments( {
            fieldPath: 'attribute',
            extraFields: ( i, shape ) => ( { category: `cat-${shape}` } ),
        } );

        expect( documents ).toHaveLength( 8 );

        // 1. Number
        expect( typeof documents[0].attribute ).toBe( 'number' );
        // 2. Min-max
        expect( documents[1].attribute ).toHaveProperty( 'min' );
        expect( documents[1].attribute ).toHaveProperty( 'max' );
        // 3. Plain-object
        expect( documents[2].attribute ).toHaveProperty( 'text' );
        // 4. Number-array
        expect( Array.isArray( documents[3].attribute ) ).toBe( true );
        expect( typeof ( documents[3].attribute as any[] )[0] ).toBe( 'number' );
        // 5. Object-array
        expect( Array.isArray( documents[4].attribute ) ).toBe( true );
        expect( ( documents[4].attribute as any[] )[0] ).toHaveProperty( 'score' );
        // 6. Nested-array
        expect( Array.isArray( documents[5].attribute ) ).toBe( true );
        expect( Array.isArray( ( documents[5].attribute as any[] )[0] ) ).toBe( true );
        // 7. Null
        expect( documents[6].attribute ).toBeNull();
        // 8. Missing (omitted property)
        expect( 'attribute' in documents[7] ).toBe( false );
        expect( documents[7].category ).toBe( 'cat-missing' );
    } );

    it( 'is deterministic and supports custom count and baseId', () =>
    {
        const run1 = buildMixedShapeDocuments( { fieldPath: 'x', count: 16, baseId: 100 } );
        const run2 = buildMixedShapeDocuments( { fieldPath: 'x', count: 16, baseId: 100 } );

        expect( run1 ).toEqual( run2 );
        expect( run1[0]._id ).toBe( 100 );
        expect( run1[15]._id ).toBe( 115 );
    } );
} );
