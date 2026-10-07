const { FuzzedDataProvider } = require( '@jazzer.js/core' );
const optimizer = require( './dist/index.cjs' );

const {
    optimizePipeline,
    optimizeFilter,
    getStageInfo
} = optimizer;

const KNOWN_STAGE_NAMES = [
    '$match',
    '$project',
    '$addFields',
    '$set',
    '$unset',
    '$sort',
    '$limit',
    '$skip',
    '$group',
    '$unwind',
    '$lookup',
    '$facet',
    '$bucket',
    '$sortByCount',
    '$replaceRoot',
    '$count'
];

const KNOWN_OPERATORS = [
    '$eq',
    '$ne',
    '$gt',
    '$gte',
    '$lt',
    '$lte',
    '$in',
    '$nin',
    '$and',
    '$or',
    '$nor',
    '$not',
    '$exists',
    '$type',
    '$elemMatch',
    '$size',
    '$all',
    '$expr',
    '$add',
    '$subtract',
    '$multiply',
    '$divide',
    '$concat',
    '$cond',
    '$ifNull',
    '$switch',
    '$filter',
    '$map'
];

const FIELD_NAMES = [
    '_id',
    'id',
    'status',
    'type',
    'user.id',
    'user.profile.name',
    'items',
    'items.price',
    'count',
    'score',
    'createdAt',
    'a',
    'b',
    'c',
    'data.value'
];

const VARIABLE_NAMES = [
    '$$ROOT',
    '$$CURRENT',
    '$$NOW',
    '$$CLUSTER_TIME',
    '$$item',
    '$$this',
    '$$value',
    '$$customVar'
];

function createFuzzedLeaf( provider )
{
    const leafKind = provider.consumeIntegralInRange( 0, 7 );

    if( leafKind === 0 )
    {
        return provider.consumeString( 32 );
    }

    if( leafKind === 1 )
    {
        return provider.consumeNumber();
    }

    if( leafKind === 2 )
    {
        return provider.consumeBoolean();
    }

    if( leafKind === 3 )
    {
        return null;
    }

    if( leafKind === 4 )
    {
        return undefined;
    }

    if( leafKind === 5 )
    {
        return provider.consumeIntegralInRange( -10000, 10000 );
    }

    if( leafKind === 6 )
    {
        return provider.pickValue( VARIABLE_NAMES );
    }

    return Buffer.from( provider.consumeBytes( 8 ));
}

function createFuzzedValue( provider, depth = 0, maxDepth = 3 )
{
    if( depth >= maxDepth )
    {
        return createFuzzedLeaf( provider );
    }

    const kind = provider.consumeIntegralInRange( 0, 6 );

    if( kind === 0 )
    {
        return createFuzzedLeaf( provider );
    }

    if( kind === 1 )
    {
        // Array of values
        const len = provider.consumeIntegralInRange( 0, 4 );
        const arr = [];

        for( let i = 0; i < len; i++ )
        {
            arr.push( createFuzzedValue( provider, depth + 1, maxDepth ));
        }

        return arr;
    }

    if( kind === 2 )
    {
        // Plain object with field names
        const numKeys = provider.consumeIntegralInRange( 0, 4 );
        const obj = {};

        for( let i = 0; i < numKeys; i++ )
        {
            const key = provider.consumeBoolean()
                ? provider.pickValue( FIELD_NAMES )
                : provider.consumeString( 12 );

            obj[ key ] = createFuzzedValue( provider, depth + 1, maxDepth );
        }

        return obj;
    }

    if( kind === 3 )
    {
        // Expression object with operator key
        const op = provider.consumeBoolean()
            ? provider.pickValue( KNOWN_OPERATORS )
            : '$' + provider.consumeString( 8 );

        return {
            [ op ]: createFuzzedValue( provider, depth + 1, maxDepth )
        };
    }

    if( kind === 4 )
    {
        return new Date( provider.consumeIntegralInRange( 0, 2000000000000 ));
    }

    if( kind === 5 )
    {
        try
        {
            return new RegExp( provider.consumeString( 10 ), provider.consumeBoolean() ? 'i' : '' );
        }
        catch
        {
            return /pattern/i;
        }
    }

    return createFuzzedLeaf( provider );
}

function createFuzzedStage( provider )
{
    const stageName = provider.consumeBoolean()
        ? provider.pickValue( KNOWN_STAGE_NAMES )
        : '$' + provider.consumeString( 10 );

    return {
        [ stageName ]: createFuzzedValue( provider, 0, 2 )
    };
}

function createFuzzedPipeline( provider )
{
    if( provider.consumeBoolean() && provider.consumeIntegralInRange( 0, 10 ) === 0 )
    {
        // Non-array input to test fail-open safety
        return createFuzzedValue( provider, 0, 1 );
    }

    const stageCount = provider.consumeIntegralInRange( 0, 6 );
    const pipeline = [];

    for( let i = 0; i < stageCount; i++ )
    {
        pipeline.push( createFuzzedStage( provider ));
    }

    return pipeline;
}

function createFuzzedOptions( provider )
{
    if( !provider.consumeBoolean() )
    {
        return undefined;
    }

    return {
        strictFieldOrder : provider.consumeBoolean(),
        strictErrors     : provider.consumeBoolean()
    };
}

module.exports.fuzz = function( data )
{
    try
    {
        const provider = new FuzzedDataProvider( data );
        const action = provider.consumeIntegralInRange( 0, 3 );
        const options = createFuzzedOptions( provider );

        if( action === 0 || action === 3 )
        {
            const pipeline = createFuzzedPipeline( provider );
            optimizePipeline( pipeline, options );
        }

        if( action === 1 || action === 3 )
        {
            const filter = createFuzzedValue( provider, 0, 3 );
            optimizeFilter( filter, options );
        }

        if( action === 2 || action === 3 )
        {
            const stage = createFuzzedStage( provider );
            getStageInfo( stage );
        }
    }
    catch( e )
    {
        if( e instanceof RangeError || e instanceof TypeError )
        {
            return;
        }

        throw e;
    }
};
