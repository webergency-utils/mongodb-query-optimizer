import { isPlainObject } from './utils';

export interface ToAbstractQueryOptions
{
    // Reserved for future options
}

export interface FormatAbstractQueryOptions
{
    readonly tabSize?: number;
    readonly format?: 'allman' | 'same-line';
}

const COMMUTATIVE_BRANCH_OPERATORS = new Set([ '$or', '$and', '$nor' ]);

function isObjectId( val: unknown ): boolean
{
    if( !val || typeof val !== 'object' )
    {
        return false;
    }

    const obj = val as Record<string, any>;
    if( obj._bsontype === 'ObjectID' || obj._bsontype === 'ObjectId' )
    {
        return true;
    }

    if( obj.constructor && ( obj.constructor.name === 'ObjectId' || obj.constructor.name === 'ObjectID' ))
    {
        return true;
    }

    if( typeof obj.toHexString === 'function' && typeof obj.getTimestamp === 'function' )
    {
        return true;
    }

    return false;
}

function isBinary( val: unknown ): boolean
{
    if( typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function' && Buffer.isBuffer( val ))
    {
        return true;
    }

    if( val instanceof Uint8Array )
    {
        return true;
    }

    if( val && typeof val === 'object' && ( val as any )._bsontype === 'Binary' )
    {
        return true;
    }

    return false;
}

function isBsonType( val: unknown, typeName: string ): boolean
{
    return Boolean( val && typeof val === 'object' && ( val as any )._bsontype === typeName );
}

function getTypeTag( val: unknown ): string
{
    if( val === null )
    {
        return 'null';
    }

    if( val === undefined )
    {
        return 'undefined';
    }

    if( typeof val === 'boolean' )
    {
        return '<boolean>';
    }

    if( typeof val === 'number' || typeof val === 'bigint' )
    {
        return '<number>';
    }

    if( typeof val === 'string' )
    {
        return '<string>';
    }

    if( val instanceof Date )
    {
        return '<Date>';
    }

    if( val instanceof RegExp || isBsonType( val, 'BSONRegExp' ))
    {
        return '<RegExp>';
    }

    if( isBinary( val ))
    {
        return '<Binary>';
    }

    if( isObjectId( val ))
    {
        return '<ObjectId>';
    }

    if( isBsonType( val, 'Decimal128' ) || isBsonType( val, 'Long' ) || isBsonType( val, 'Int32' ) || isBsonType( val, 'Double' ))
    {
        return '<number>';
    }

    if( isBsonType( val, 'MinKey' ))
    {
        return '<MinKey>';
    }

    if( isBsonType( val, 'MaxKey' ))
    {
        return '<MaxKey>';
    }

    if( isBsonType( val, 'Timestamp' ))
    {
        return '<Timestamp>';
    }

    return '<unknown>';
}

function isScalarLiteral( val: unknown ): boolean
{
    if( val === null || val === undefined )
    {
        return true;
    }

    if( typeof val !== 'object' )
    {
        return true;
    }

    if( val instanceof Date || val instanceof RegExp || isBinary( val ) || isObjectId( val ))
    {
        return true;
    }

    if( ( val as any )._bsontype )
    {
        return true;
    }

    return false;
}

function isAggregationPipeline( val: unknown ): val is Array<Record<string, any>>
{
    if( !Array.isArray( val ) || val.length === 0 )
    {
        return false;
    }

    return val.every(( item ) =>
    {
        if( !isPlainObject( item ))
        {
            return false;
        }

        const keys = Object.keys( item );
        return keys.length > 0 && keys.every(( key ) => key.startsWith( '$' ));
    });
}

interface AbstractionContext
{
    readonly isExpression?: boolean;
    readonly inPipeline?: boolean;
    readonly isIdentifier?: boolean;
    readonly isIndex?: boolean;
    readonly parentOperator?: string;
    readonly parentStage?: string;
}

function toAbstractQueryInternal( query: unknown, context: AbstractionContext = {}): string
{
    if( query === null )
    {
        return 'null';
    }

    if( query === undefined )
    {
        return 'undefined';
    }

    if( typeof query === 'string' )
    {
        if( context.isIdentifier || query.startsWith( '$$' ) || ( context.isExpression && query.startsWith( '$' )))
        {
            return JSON.stringify( query );
        }
        return '<string>';
    }

    if( typeof query === 'number' || typeof query === 'bigint' )
    {
        if( context.isIndex )
        {
            return String( query );
        }
        return '<number>';
    }

    if( isScalarLiteral( query ))
    {
        return getTypeTag( query );
    }

    if( Array.isArray( query ))
    {
        if( query.length === 0 )
        {
            return '[]';
        }

        if( !context.inPipeline && isAggregationPipeline( query ))
        {
            const stages = query.map(( stage ) =>
            {
                return toAbstractQueryInternal( stage, { inPipeline: true });
            });
            return `[${ stages.join( ',' ) }]`;
        }

        const elementShapes = query.map(( elem ) =>
        {
            return toAbstractQueryInternal( elem, context );
        });

        const uniqueShapes = Array.from( new Set( elementShapes )).sort(( a, b ) => a.localeCompare( b ));
        return `[${ uniqueShapes.join( ',' ) }]`;
    }

    if( isPlainObject( query ) || ( typeof query === 'object' && query !== null ))
    {
        const keys = Object.keys( query ).sort(( a, b ) => a.localeCompare( b ));
        if( keys.length === 0 )
        {
            return '{}';
        }

        const entries: string[] = [];

        for( const key of keys )
        {
            const val = ( query as Record<string, any> )[ key ];

            if( key === '$unset' )
            {
                if( typeof val === 'string' )
                {
                    entries.push( `${ JSON.stringify( key ) }:${ JSON.stringify( val ) }` );
                    continue;
                }

                if( Array.isArray( val ))
                {
                    const sortedFields = val.map(( field ) =>
                    {
                        if( typeof field === 'string' )
                        {
                            return JSON.stringify( field );
                        }
                        return toAbstractQueryInternal( field, context );
                    }).sort(( a, b ) => a.localeCompare( b ));

                    entries.push( `${ JSON.stringify( key ) }:[${ sortedFields.join( ',' ) }]` );
                    continue;
                }
            }

            if( key === '$getField' && typeof val === 'string' )
            {
                entries.push( `${ JSON.stringify( key ) }:${ JSON.stringify( val ) }` );
                continue;
            }

            let childContext: AbstractionContext = {
                ...context,
                isIdentifier: false,
                isIndex: false,
                parentOperator: key.startsWith( '$' ) ? key : context.parentOperator
            };

            if( context.inPipeline )
            {
                if( key === '$match' )
                {
                    childContext = { inPipeline: true, isExpression: false, parentStage: '$match' };
                }
                else
                {
                    childContext = { inPipeline: true, isExpression: true, parentStage: key, parentOperator: key };
                }
            }
            else if(
                key === '$expr' ||
                key === '$map' ||
                key === '$filter' ||
                key === '$getField' ||
                key === '$setField' ||
                key === '$unsetField' ||
                key === '$cond' ||
                key === '$switch' ||
                key === '$arrayElemAt' ||
                key === '$slice' ||
                key === '$indexOfArray' ||
                key === '$indexOfCP' ||
                key === '$indexOfBytes' ||
                key === '$substrCP' ||
                key === '$substrBytes' ||
                key === '$substr' ||
                key === '$range'
            )
            {
                childContext = { ...childContext, isExpression: true, parentOperator: key };
            }

            if( key === '$arrayElemAt' && Array.isArray( val ))
            {
                const exprContext: AbstractionContext = {
                    ...childContext,
                    isExpression: true,
                    parentOperator: key
                };
                const elements = val.map(( elem, idx ) =>
                {
                    if( idx === 1 && typeof elem === 'number' )
                    {
                        return String( elem );
                    }
                    return toAbstractQueryInternal( elem, {
                        ...exprContext,
                        isIndex: idx === 1
                    });
                });
                entries.push( `${ JSON.stringify( key ) }:[${ elements.join( ',' ) }]` );
                continue;
            }

            if( key === '$slice' )
            {
                if( typeof val === 'number' )
                {
                    entries.push( `${ JSON.stringify( key ) }:${ String( val ) }` );
                    continue;
                }

                if( Array.isArray( val ))
                {
                    const isProjectionSlice = val.length === 2 && typeof val[ 0 ] === 'number' && typeof val[ 1 ] === 'number';
                    const exprContext: AbstractionContext = {
                        ...childContext,
                        isExpression: true,
                        parentOperator: key
                    };
                    const elements = val.map(( elem, idx ) =>
                    {
                        if( isProjectionSlice )
                        {
                            return typeof elem === 'number'
                                ? String( elem )
                                : toAbstractQueryInternal( elem, { ...exprContext, isIndex: true });
                        }

                        if( idx > 0 && typeof elem === 'number' )
                        {
                            return String( elem );
                        }
                        return toAbstractQueryInternal( elem, { ...exprContext, isIndex: idx > 0 });
                    });
                    entries.push( `${ JSON.stringify( key ) }:[${ elements.join( ',' ) }]` );
                    continue;
                }
            }

            if( key === '$indexOfArray' && Array.isArray( val ))
            {
                const exprContext: AbstractionContext = {
                    ...childContext,
                    isExpression: true,
                    parentOperator: key
                };
                const elements = val.map(( elem, idx ) =>
                {
                    if( idx >= 2 && typeof elem === 'number' )
                    {
                        return String( elem );
                    }
                    return toAbstractQueryInternal( elem, { ...exprContext, isIndex: idx >= 2 });
                });
                entries.push( `${ JSON.stringify( key ) }:[${ elements.join( ',' ) }]` );
                continue;
            }

            if(( key === '$indexOfCP' || key === '$indexOfBytes' ) && Array.isArray( val ))
            {
                const exprContext: AbstractionContext = {
                    ...childContext,
                    isExpression: true,
                    parentOperator: key
                };
                const elements = val.map(( elem, idx ) =>
                {
                    if( idx >= 2 && typeof elem === 'number' )
                    {
                        return String( elem );
                    }
                    return toAbstractQueryInternal( elem, { ...exprContext, isIndex: idx >= 2 });
                });
                entries.push( `${ JSON.stringify( key ) }:[${ elements.join( ',' ) }]` );
                continue;
            }

            if(( key === '$substrCP' || key === '$substrBytes' || key === '$substr' ) && Array.isArray( val ))
            {
                const exprContext: AbstractionContext = {
                    ...childContext,
                    isExpression: true,
                    parentOperator: key
                };
                const elements = val.map(( elem, idx ) =>
                {
                    if( idx >= 1 && typeof elem === 'number' )
                    {
                        return String( elem );
                    }
                    return toAbstractQueryInternal( elem, { ...exprContext, isIndex: idx >= 1 });
                });
                entries.push( `${ JSON.stringify( key ) }:[${ elements.join( ',' ) }]` );
                continue;
            }

            if( key === '$range' && Array.isArray( val ))
            {
                const exprContext: AbstractionContext = {
                    ...childContext,
                    isExpression: true,
                    parentOperator: key
                };
                const elements = val.map(( elem ) =>
                {
                    if( typeof elem === 'number' )
                    {
                        return String( elem );
                    }
                    return toAbstractQueryInternal( elem, { ...exprContext, isIndex: true });
                });
                entries.push( `${ JSON.stringify( key ) }:[${ elements.join( ',' ) }]` );
                continue;
            }

            if( key === 'as' && (
                context.parentOperator === '$map' ||
                context.parentOperator === '$filter' ||
                context.parentStage === '$lookup' ||
                context.parentStage === '$graphLookup' ||
                context.parentOperator === '$lookup' ||
                context.parentOperator === '$graphLookup'
            ))
            {
                childContext = { ...childContext, isIdentifier: true };
            }
            else if( key === 'includeArrayIndex' && (
                context.parentStage === '$unwind' ||
                context.parentOperator === '$unwind'
            ))
            {
                childContext = { ...childContext, isIdentifier: true };
            }
            else if( key === 'field' && (
                context.parentOperator === '$getField' ||
                context.parentOperator === '$setField' ||
                context.parentOperator === '$unsetField' ||
                context.parentStage === '$densify' ||
                context.parentOperator === '$densify'
            ))
            {
                childContext = { ...childContext, isIdentifier: true };
            }
            else if( key === 'partitionByFields' && (
                context.parentStage === '$densify' ||
                context.parentOperator === '$densify' ||
                context.parentStage === '$fill' ||
                context.parentOperator === '$fill'
            ) && Array.isArray( val ))
            {
                const sortedFields = val.map(( field ) =>
                {
                    if( typeof field === 'string' )
                    {
                        return JSON.stringify( field );
                    }
                    return toAbstractQueryInternal( field, childContext );
                }).sort(( a, b ) => a.localeCompare( b ));

                entries.push( `${ JSON.stringify( key ) }:[${ sortedFields.join( ',' ) }]` );
                continue;
            }

            if( COMMUTATIVE_BRANCH_OPERATORS.has( key ) && Array.isArray( val ))
            {
                const branchShapes = val.map(( branch ) =>
                {
                    return toAbstractQueryInternal( branch, childContext );
                }).sort(( a, b ) => a.localeCompare( b ));

                entries.push( `${ JSON.stringify( key ) }:[${ branchShapes.join( ',' ) }]` );
            }
            else
            {
                const formattedVal = toAbstractQueryInternal( val, childContext );
                entries.push( `${ JSON.stringify( key ) }:${ formattedVal }` );
            }
        }

        return `{${ entries.join( ',' ) }}`;
    }

    return '<unknown>';
}

/**
 * Generates an abstract, whitespace-free canonical MongoDB query shape.
 * Replaces literal values with unquoted type placeholders (e.g. <string>, <number>),
 * deduplicates and sorts array types, preserves aggregation field paths ($field),
 * and recursively sorts object keys and commutative logical operator branches ($or, $and, $nor).
 */
export function toAbstractQuery( query: unknown, _options?: ToAbstractQueryOptions ): string
{
    return toAbstractQueryInternal( query, {} );
}

interface Token
{
    readonly type: 'LBRACE' | 'RBRACE' | 'LBRACKET' | 'RBRACKET' | 'COLON' | 'COMMA' | 'LITERAL';
    readonly value: string;
}

function tokenize( input: string ): Token[]
{
    const tokens: Token[] = [];
    let i = 0;

    while( i < input.length )
    {
        const char = input[ i ];

        if( /\s/.test( char ))
        {
            i++;
            continue;
        }

        if( char === '{' )
        {
            tokens.push({ type: 'LBRACE', value: '{' });
            i++;
        }
        else if( char === '}' )
        {
            tokens.push({ type: 'RBRACE', value: '}' });
            i++;
        }
        else if( char === '[' )
        {
            tokens.push({ type: 'LBRACKET', value: '[' });
            i++;
        }
        else if( char === ']' )
        {
            tokens.push({ type: 'RBRACKET', value: ']' });
            i++;
        }
        else if( char === ':' )
        {
            tokens.push({ type: 'COLON', value: ':' });
            i++;
        }
        else if( char === ',' )
        {
            tokens.push({ type: 'COMMA', value: ',' });
            i++;
        }
        else if( char === '"' )
        {
            let str = '"';
            i++;
            while( i < input.length )
            {
                const c = input[ i ];
                str += c;
                if( c === '\\' && i + 1 < input.length )
                {
                    i++;
                    str += input[ i ];
                }
                else if( c === '"' )
                {
                    i++;
                    break;
                }
                i++;
            }
            tokens.push({ type: 'LITERAL', value: str });
        }
        else if( char === '<' )
        {
            let tag = '<';
            i++;
            while( i < input.length && input[ i ] !== '>' )
            {
                tag += input[ i ];
                i++;
            }
            if( i < input.length && input[ i ] === '>' )
            {
                tag += '>';
                i++;
            }
            tokens.push({ type: 'LITERAL', value: tag });
        }
        else
        {
            let lit = '';
            while( i < input.length && !/[{}[\]:,\s]/.test( input[ i ] ))
            {
                lit += input[ i ];
                i++;
            }
            tokens.push({ type: 'LITERAL', value: lit });
        }
    }

    return tokens;
}

type AstNode =
    | { readonly kind: 'literal'; readonly value: string }
    | { readonly kind: 'object'; readonly properties: ReadonlyArray<{ readonly key: string; readonly value: AstNode }> }
    | { readonly kind: 'array'; readonly elements: ReadonlyArray<AstNode> };

function parseTokens( tokens: Token[] ): AstNode
{
    let pos = 0;

    function parseNode(): AstNode
    {
        const token = tokens[ pos ];
        if( !token )
        {
            return { kind: 'literal', value: '' };
        }

        if( token.type === 'LBRACE' )
        {
            pos++;
            const properties: Array<{ key: string; value: AstNode }> = [];

            while( pos < tokens.length && tokens[ pos ].type !== 'RBRACE' )
            {
                const keyToken = tokens[ pos ];
                pos++;

                if( pos < tokens.length && tokens[ pos ].type === 'COLON' )
                {
                    pos++;
                }

                const value = parseNode();
                properties.push({ key: keyToken.value, value });

                if( pos < tokens.length && tokens[ pos ].type === 'COMMA' )
                {
                    pos++;
                }
            }

            if( pos < tokens.length && tokens[ pos ].type === 'RBRACE' )
            {
                pos++;
            }

            return { kind: 'object', properties };
        }

        if( token.type === 'LBRACKET' )
        {
            pos++;
            const elements: AstNode[] = [];

            while( pos < tokens.length && tokens[ pos ].type !== 'RBRACKET' )
            {
                const elem = parseNode();
                elements.push( elem );

                if( pos < tokens.length && tokens[ pos ].type === 'COMMA' )
                {
                    pos++;
                }
            }

            if( pos < tokens.length && tokens[ pos ].type === 'RBRACKET' )
            {
                pos++;
            }

            return { kind: 'array', elements };
        }

        pos++;
        return { kind: 'literal', value: token.value };
    }

    return parseNode();
}

function formatAst( node: AstNode, depth: number, options: { tabSize: number; format: 'allman' | 'same-line' }): string
{
    const indent = ( d: number ) => ' '.repeat( d * options.tabSize );

    if( node.kind === 'literal' )
    {
        return node.value;
    }

    if( node.kind === 'array' )
    {
        if( node.elements.length === 0 )
        {
            return '[]';
        }

        const allScalars = node.elements.every(( elem ) => elem.kind === 'literal' );
        if( allScalars )
        {
            return `[${ node.elements.map(( elem ) => elem.value ).join( ', ' ) }]`;
        }

        const childLines = node.elements.map(( elem ) =>
        {
            return `${ indent( depth + 1 ) }${ formatAst( elem, depth + 1, options ) }`;
        }).join( ',\n' );

        return `[\n${ childLines }\n${ indent( depth ) }]`;
    }

    if( node.kind === 'object' )
    {
        if( node.properties.length === 0 )
        {
            return '{}';
        }

        const propLines: string[] = [];

        for( const prop of node.properties )
        {
            const { key, value } = prop;

            const isMultilineValue = ( value.kind === 'object' && value.properties.length > 0 )
                || ( value.kind === 'array' && !value.elements.every(( elem ) => elem.kind === 'literal' ) && value.elements.length > 0 );

            if( options.format === 'allman' && isMultilineValue )
            {
                const formattedVal = formatAst( value, depth + 1, options );
                propLines.push( `${ indent( depth + 1 ) }${ key }:\n${ indent( depth + 1 ) }${ formattedVal }` );
            }
            else
            {
                const formattedVal = formatAst( value, depth + 1, options );
                propLines.push( `${ indent( depth + 1 ) }${ key }: ${ formattedVal }` );
            }
        }

        return `{\n${ propLines.join( ',\n' ) }\n${ indent( depth ) }}`;
    }

    return '';
}

/**
 * Formats an abstract query shape or query object into a human-readable, indented string.
 * Supports configurable tab sizes (default 2) and bracket placement ('allman' vs 'same-line').
 */
export function formatAbstractQuery( queryOrShape: unknown, options?: FormatAbstractQueryOptions ): string
{
    const tabSize = options?.tabSize ?? 2;
    const format = options?.format ?? 'same-line';

    const shapeString = typeof queryOrShape === 'string'
        ? queryOrShape
        : toAbstractQuery( queryOrShape );

    const tokens = tokenize( shapeString );
    const ast = parseTokens( tokens );

    return formatAst( ast, 0, { tabSize, format });
}
