import { isPlainObject } from './utils';

export interface ToAbstractQueryOptions
{
    // Reserved for future options
}

export interface FormatAbstractQueryOptions
{
    readonly tabSize?       : number
    readonly format?        : 'allman' | 'same-line'
    readonly maxLineLength? : number
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

function getScalarTypeTag( val: unknown ): string | null
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

    if( typeof val !== 'object' )
    {
        return '<unknown>';
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

    if(
        isBsonType( val, 'Decimal128' )
        || isBsonType( val, 'Long' )
        || isBsonType( val, 'Int32' )
        || isBsonType( val, 'Double' )
    )
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

    if( ( val as any )._bsontype )
    {
        return '<unknown>';
    }

    return null;
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
    readonly isExpression?      : boolean
    readonly inPipeline?        : boolean
    readonly isIdentifier?      : boolean
    readonly isIndex?           : boolean
    readonly isSortSpec?        : boolean
    readonly isProjectionSpec?  : boolean
    readonly parentOperator?    : string
    readonly parentStage?       : string
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
        if(
            context.isIdentifier ||
            query.startsWith( '$$' ) ||
            ( context.isExpression && query.startsWith( '$' )) ||
            query === 'unbounded' ||
            query === 'current'
        )
        {
            return JSON.stringify( query );
        }

        return '<string>';
    }

    if( typeof query === 'boolean' )
    {
        if( context.isProjectionSpec )
        {
            return String( query );
        }

        return '<boolean>';
    }

    if( typeof query === 'number' || typeof query === 'bigint' )
    {
        if(
            context.isIndex ||
            ( context.isSortSpec && ( query === 1 || query === -1 )) ||
            ( context.isProjectionSpec && ( query === 0 || query === 1 ))
        )
        {
            return String( query );
        }

        return '<number>';
    }

    const scalarTag = getScalarTypeTag( query );

    if( scalarTag !== null )
    {
        return scalarTag;
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

        const shapeSet = new Set<string>();

        for( let i = 0; i < query.length; i++ )
        {
            shapeSet.add( toAbstractQueryInternal( query[ i ], context ));
        }

        const uniqueShapes = Array.from( shapeSet ).sort(( a, b ) => a.localeCompare( b ));

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

            if(( key === '$limit' || key === '$skip' ) && typeof val === 'number' )
            {
                entries.push( `${ JSON.stringify( key ) }:${ String( val ) }` );
                continue;
            }

            if(( key === '$count' || key === '$unwind' ) && typeof val === 'string' )
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

            if( key.startsWith( '$' ))
            {
                childContext = {
                    ...childContext,
                    isProjectionSpec: false,
                    isSortSpec: false,
                    isExpression: true,
                    parentOperator: key
                };

                if( context.inPipeline )
                {
                    if( key === '$match' )
                    {
                        childContext = { inPipeline: true, isExpression: false, parentStage: '$match', parentOperator: '$match' };
                    }
                    else if( key === '$project' )
                    {
                        childContext = {
                            inPipeline: true,
                            isExpression: false,
                            isProjectionSpec: true,
                            parentStage: '$project',
                            parentOperator: '$project'
                        };
                    }
                    else if( key === '$sort' )
                    {
                        childContext = {
                            inPipeline: true,
                            isExpression: false,
                            isSortSpec: true,
                            parentStage: '$sort',
                            parentOperator: '$sort'
                        };
                    }
                    else
                    {
                        childContext = { inPipeline: true, isExpression: true, parentStage: key, parentOperator: key };
                    }
                }
                else if( key === '$sort' )
                {
                    childContext = { ...childContext, isExpression: false, isSortSpec: true, parentOperator: key };
                }
                else if( key === '$project' )
                {
                    childContext = { ...childContext, isExpression: false, isProjectionSpec: true, parentOperator: key };
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
            }

            if( key === 'sortBy' )
            {
                childContext = { ...childContext, isSortSpec: true };
            }

            const COUNT_LIMIT_OPERATORS = new Set([
                '$firstN', '$lastN', '$topN', '$bottomN', '$maxN', '$minN'
            ]);
            if( key === 'n' && (
                COUNT_LIMIT_OPERATORS.has( context.parentOperator ?? '' ) ||
                COUNT_LIMIT_OPERATORS.has( context.parentStage ?? '' )
            ))
            {
                childContext = { ...childContext, isIndex: true };
            }

            if( key === 'size' && ( context.parentStage === '$sample' || context.parentOperator === '$sample' ))
            {
                childContext = { ...childContext, isIndex: true };
            }

            if( key === 'format' && context.parentOperator === '$dateToString' )
            {
                childContext = { ...childContext, isIdentifier: true };
            }
            else if( key === 'unit' && (( context.parentOperator ?? '' ).startsWith( '$date' ) || context.parentStage === '$setWindowFields' || context.parentOperator === '$setWindowFields' || context.parentOperator === 'window' ))
            {
                childContext = { ...childContext, isIdentifier: true };
            }
            else if( key === 'binSize' && ( context.parentOperator ?? '' ).startsWith( '$date' ))
            {
                childContext = { ...childContext, isIndex: true };
            }
            else if( key === '$options' || ( key === 'options' && ( context.parentOperator ?? '' ).startsWith( '$regex' )))
            {
                childContext = { ...childContext, isIdentifier: true };
            }
            else if( key === '$type' )
            {
                childContext = { ...childContext, isIdentifier: true, isIndex: true };
            }

            if(( key === 'documents' || key === 'range' ) && (
                context.parentOperator === 'window' ||
                context.parentOperator === '$setWindowFields' ||
                context.parentStage === '$setWindowFields'
            ) && Array.isArray( val ))
            {
                const elements = val.map(( elem ) =>
                {
                    if( typeof elem === 'number' )
                    {
                        return String( elem );
                    }

                    if( typeof elem === 'string' )
                    {
                        return JSON.stringify( elem );
                    }

                    return toAbstractQueryInternal( elem, childContext );
                });

                entries.push( `${ JSON.stringify( key ) }:[${ elements.join( ',' ) }]` );
                continue;
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
            else if(( key === 'includeArrayIndex' || key === 'path' ) && (
                context.parentStage === '$unwind' ||
                context.parentOperator === '$unwind'
            ))
            {
                childContext = { ...childContext, isIdentifier: true };
            }
            else if(( key === 'localField' || key === 'foreignField' ) && (
                context.parentStage === '$lookup' ||
                context.parentOperator === '$lookup'
            ))
            {
                childContext = { ...childContext, isIdentifier: true };
            }
            else if(( key === 'connectFromField' || key === 'connectToField' || key === 'depthField' ) && (
                context.parentStage === '$graphLookup' ||
                context.parentOperator === '$graphLookup'
            ))
            {
                childContext = { ...childContext, isIdentifier: true };
            }
            else if( key === 'maxDepth' && (
                context.parentStage === '$graphLookup' ||
                context.parentOperator === '$graphLookup'
            ))
            {
                childContext = { ...childContext, isIndex: true };
            }
            else if( key === 'buckets' && (
                context.parentStage === '$bucketAuto' ||
                context.parentOperator === '$bucketAuto'
            ))
            {
                childContext = { ...childContext, isIndex: true };
            }
            else if( key === 'granularity' && (
                context.parentStage === '$bucketAuto' ||
                context.parentOperator === '$bucketAuto'
            ))
            {
                childContext = { ...childContext, isIdentifier: true };
            }
            else if( key === 'size' && (
                context.parentStage === '$sample' ||
                context.parentOperator === '$sample'
            ))
            {
                childContext = { ...childContext, isIndex: true };
            }
            else if(( key === 'into' || key === 'on' || key === 'whenMatched' || key === 'whenNotMatched' ) && (
                context.parentStage === '$merge' ||
                context.parentOperator === '$merge'
            ))
            {
                childContext = { ...childContext, isIdentifier: true };
            }
            else if(( key === 'coll' || key === 'db' ) && (
                context.parentStage === '$out' ||
                context.parentOperator === '$out' ||
                context.parentStage === '$merge' ||
                context.parentOperator === '$merge'
            ))
            {
                childContext = { ...childContext, isIdentifier: true };
            }
            else if( key === 'to' && (
                context.parentOperator === '$convert' ||
                context.parentStage === '$convert'
            ))
            {
                childContext = { ...childContext, isIdentifier: true, isIndex: true };
            }
            else if( key === 'method' && (
                context.parentOperator === '$fill' ||
                context.parentStage === '$fill'
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

const LEAF_COMPARISON_OPERATORS = new Set([
    '$eq',
    '$ne',
    '$gt',
    '$gte',
    '$lt',
    '$lte',
    '$in',
    '$nin',
    '$type',
    '$size',
    '$exists',
    '$regex',
    '$mod',
    '$all'
]);

const LEAF_ARRAY_INDEX_OPERATORS = new Set([
    '$arrayElemAt',
    '$slice',
    '$indexOfArray',
    '$substrCP',
    '$substrBytes',
    '$substr',
    '$indexOfCP',
    '$indexOfBytes',
    '$range'
]);

const LEAF_ACCUMULATOR_OPERATORS = new Set([
    '$sum',
    '$avg',
    '$first',
    '$last',
    '$max',
    '$min',
    '$push',
    '$addToSet'
]);

const COMPACT_PIPELINE_STAGES = new Set([
    '$limit',
    '$skip',
    '$count',
    '$sort',
    '$sortByCount',
    '$out'
]);

const ALL_LEAF_OPERATORS = new Set([
    ...LEAF_COMPARISON_OPERATORS,
    ...LEAF_ARRAY_INDEX_OPERATORS,
    ...LEAF_ACCUMULATOR_OPERATORS
]);

function formatSingleLine( node: AstNode ): string
{
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

        return `[${ node.elements.map( formatSingleLine ).join( ', ' ) }]`;
    }

    if( node.kind === 'object' )
    {
        if( node.properties.length === 0 )
        {
            return '{}';
        }

        const formattedProps = node.properties.map(( p ) =>
        {
            return `${ p.key }: ${ formatSingleLine( p.value ) }`;
        }).join( ', ' );

        return `{ ${ formattedProps } }`;
    }

    return '';
}

function cleanKey( key: string ): string
{
    return key.replace( /^"|"$/g, '' );
}

function isLeafCandidate( node: AstNode, depth: number = 0 ): boolean
{
    if( depth > 3 )
    {
        return false;
    }

    if( node.kind === 'literal' )
    {
        return true;
    }

    if( node.kind === 'array' )
    {
        if( node.elements.length === 0 )
        {
            return true;
        }

        if( node.elements.every(( elem ) => elem.kind === 'literal' ))
        {
            return true;
        }

        if( node.elements.length > 5 )
        {
            return false;
        }

        return node.elements.every(( elem ) => isLeafCandidate( elem, depth + 1 ));
    }

    if( node.kind === 'object' )
    {
        if( node.properties.length === 0 )
        {
            return true;
        }

        // Compact sort specification (all values are 1, -1, or numerical literal)
        if( node.properties.length <= 4 && node.properties.every(( p ) => p.value.kind === 'literal' && ( p.value.value === '1' || p.value.value === '-1' || p.value.value === '<number>' )))
        {
            return true;
        }

        // Single property that is a leaf operator or compact stage
        if( node.properties.length === 1 )
        {
            const prop = node.properties[ 0 ];
            const cleanedKey = cleanKey( prop.key );

            if( cleanedKey === '$unwind' )
            {
                return prop.value.kind === 'literal';
            }

            if( cleanedKey === '$sample' )
            {
                return prop.value.kind === 'object' &&
                    prop.value.properties.length === 1 &&
                    cleanKey( prop.value.properties[ 0 ].key ) === 'size';
            }

            if( ALL_LEAF_OPERATORS.has( cleanedKey ) || COMPACT_PIPELINE_STAGES.has( cleanedKey ))
            {
                return isLeafCandidate( prop.value, depth + 1 );
            }

            // Single field filter whose value is a leaf operator object (e.g. { "deleted": { "$ne": true } })
            if( prop.value.kind === 'object' && prop.value.properties.length === 1 )
            {
                const innerKey = cleanKey( prop.value.properties[ 0 ].key );
                if( ALL_LEAF_OPERATORS.has( innerKey ))
                {
                    return isLeafCandidate( prop.value, depth + 1 );
                }
            }
        }

        return false;
    }

    return false;
}

interface FormatAstOptions
{
    tabSize       : number
    format        : 'allman' | 'same-line'
    maxLineLength : number
}

function formatAst( node: AstNode, depth: number, options: FormatAstOptions ): string
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

        const canCollapseArray = depth > 0 || !node.elements.some(( elem ) => elem.kind === 'object' );
        if( canCollapseArray && isLeafCandidate( node ))
        {
            const singleLine = formatSingleLine( node );
            if( indent( depth ).length + singleLine.length <= options.maxLineLength )
            {
                return singleLine;
            }
        }

        const childLines = node.elements.map(( elem ) =>
        {
            if( isLeafCandidate( elem ))
            {
                const singleLine = formatSingleLine( elem );
                if( indent( depth + 1 ).length + singleLine.length <= options.maxLineLength )
                {
                    return `${ indent( depth + 1 ) }${ singleLine }`;
                }
            }

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

            if( isLeafCandidate( value ))
            {
                const singleLineVal = formatSingleLine( value );
                const prospectiveLineLength = indent( depth + 1 ).length + key.length + 2 + singleLineVal.length;

                if( prospectiveLineLength <= options.maxLineLength )
                {
                    propLines.push( `${ indent( depth + 1 ) }${ key }: ${ singleLineVal }` );
                    continue;
                }
            }

            const isMultilineValue = ( value.kind === 'object' && value.properties.length > 0 )
                || ( value.kind === 'array' && value.elements.length > 0 );

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
 * Supports configurable tab sizes (default 2), bracket placement ('allman' vs 'same-line'),
 * and a line-length threshold (default 80) for inlining compact leaf expressions.
 */
export function formatAbstractQuery( queryOrShape: unknown, options?: FormatAbstractQueryOptions ): string
{
    const tabSize = options?.tabSize ?? 2;
    const format = options?.format ?? 'same-line';
    const maxLineLength = Math.max( 20, options?.maxLineLength ?? 80 );

    const shapeString = typeof queryOrShape === 'string'
        ? queryOrShape
        : toAbstractQuery( queryOrShape );

    const tokens = tokenize( shapeString );
    const ast = parseTokens( tokens );

    return formatAst( ast, 0, { tabSize, format, maxLineLength });
}
