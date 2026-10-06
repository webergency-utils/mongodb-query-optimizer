import type { Document } from 'mongodb';

export type MixedShapeType =
    | 'number'
    | 'min-max'
    | 'plain-object'
    | 'number-array'
    | 'object-array'
    | 'nested-array'
    | 'null'
    | 'missing';

export interface MixedShapeDefinition
{
    readonly type: MixedShapeType;
    readonly description: string;
    readonly createValue: ( index?: number ) => unknown;
}

export const MIXED_SHAPE_CATALOG: readonly MixedShapeDefinition[] = [
    {
        type: 'number',
        description: 'Scalar numeric value',
        createValue: ( index = 1 ) => index * 10,
    },
    {
        type: 'min-max',
        description: 'Range object with min and max properties',
        createValue: ( index = 1 ) => ( { min: index * 5, max: index * 20 } ),
    },
    {
        type: 'plain-object',
        description: 'General plain object',
        createValue: ( index = 1 ) => ( { text: `item-${index}`, active: index % 2 === 0 } ),
    },
    {
        type: 'number-array',
        description: 'Array of numbers',
        createValue: ( index = 1 ) => [ index, index + 5, index + 10 ],
    },
    {
        type: 'object-array',
        description: 'Array of embedded documents',
        createValue: ( index = 1 ) => [
            { score: index * 10, title: `A-${index}` },
            { score: index * 10 + 5, title: `B-${index}` },
        ],
    },
    {
        type: 'nested-array',
        description: 'Multi-dimensional nested array',
        createValue: ( index = 1 ) => [ [ index, index + 1 ], [ index + 2 ] ],
    },
    {
        type: 'null',
        description: 'Explicit BSON null value',
        createValue: () => null,
    },
    {
        type: 'missing',
        description: 'Omitted property',
        createValue: () => undefined,
    },
];

export function getMixedShapeDefinition( type: MixedShapeType ): MixedShapeDefinition
{
    const definition = MIXED_SHAPE_CATALOG.find( ( entry ) => entry.type === type );
    if( !definition )
    {
        throw new Error( `Unknown mixed shape type: ${type}` );
    }

    return definition;
}

export function setDottedProperty( target: Record<string, unknown>, path: string, value: unknown ): void
{
    if( value === undefined )
    {
        return;
    }

    const parts = path.split( '.' );
    let current: Record<string, unknown> = target;

    for( let i = 0; i < parts.length - 1; i++ )
    {
        const part = parts[i];
        if( !current[part] || typeof current[part] !== 'object' )
        {
            current[part] = {};
        }

        current = current[part] as Record<string, unknown>;
    }

    current[parts[parts.length - 1]] = value;
}

export interface BuildMixedShapeDocumentsOptions
{
    readonly fieldPath: string;
    readonly count?: number;
    readonly baseId?: number;
    readonly extraFields?: ( index: number, shape: MixedShapeType ) => Record<string, unknown>;
}

export function buildMixedShapeDocuments( options: BuildMixedShapeDocumentsOptions ): Document[]
{
    const count = options.count ?? MIXED_SHAPE_CATALOG.length;
    const baseId = options.baseId ?? 1;
    const documents: Document[] = [];

    for( let i = 0; i < count; i++ )
    {
        const definition = MIXED_SHAPE_CATALOG[i % MIXED_SHAPE_CATALOG.length];
        const doc: Record<string, unknown> = {
            _id: baseId + i,
        };

        if( options.extraFields )
        {
            const extras = options.extraFields( i + 1, definition.type );
            Object.assign( doc, extras );
        }

        const value = definition.createValue( i + 1 );
        if( value !== undefined )
        {
            setDottedProperty( doc, options.fieldPath, value );
        }

        documents.push( doc );
    }

    return documents;
}
