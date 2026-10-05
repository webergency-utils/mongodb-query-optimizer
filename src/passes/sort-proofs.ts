function isPlainObject( value: unknown ): value is Record<string, any>
{
    if( !value || typeof value !== 'object' || Array.isArray( value ))
    {
        return false;
    }
    const proto = Object.getPrototypeOf( value );

    return proto === Object.prototype || proto === null;
}

const ORDER_AGNOSTIC_ACCUMULATORS = new Set([
    '$sum',
    '$avg',
    '$min',
    '$max',
    '$count',
    '$stdDevPop',
    '$stdDevSamp'
]);

export function isOrderAgnosticGroup( groupStage: unknown ): boolean
{
    if( !isPlainObject( groupStage ))
    {
        return false;
    }

    const groupKeys = Object.keys( groupStage );
    if( groupKeys.length !== 1 || groupKeys[0] !== '$group' )
    {
        return false;
    }

    const groupSpec = groupStage.$group;
    if( !isPlainObject( groupSpec ))
    {
        return false;
    }

    for( const [ key, val ] of Object.entries( groupSpec ))
    {
        if( key === '_id' )
        {
            continue;
        }

        if( !isPlainObject( val ))
        {
            return false;
        }

        const opKeys = Object.keys( val );
        if( opKeys.length !== 1 )
        {
            return false;
        }

        const op = opKeys[0];
        if( !ORDER_AGNOSTIC_ACCUMULATORS.has( op ))
        {
            return false;
        }
    }

    return true;
}

export function isEmptySort( stage: unknown ): boolean
{
    if( !isPlainObject( stage ))
    {
        return false;
    }

    const keys = Object.keys( stage );
    if( keys.length !== 1 || keys[0] !== '$sort' )
    {
        return false;
    }

    const sortSpec = stage.$sort;

    return isPlainObject( sortSpec ) && Object.keys( sortSpec ).length === 0;
}

export function isAdjacentSort( currentStage: unknown, nextStage: unknown ): boolean
{
    if( !isPlainObject( currentStage ) || !isPlainObject( nextStage ))
    {
        return false;
    }

    const currentKeys = Object.keys( currentStage );
    const nextKeys = Object.keys( nextStage );

    if( currentKeys.length !== 1 || currentKeys[0] !== '$sort' )
    {
        return false;
    }

    if( nextKeys.length !== 1 || nextKeys[0] !== '$sort' )
    {
        return false;
    }

    return isPlainObject( currentStage.$sort ) && isPlainObject( nextStage.$sort );
}

export function isDeadSortBeforeGroup( currentStage: unknown, nextStage: unknown ): boolean
{
    if( !isPlainObject( currentStage ))
    {
        return false;
    }

    const currentKeys = Object.keys( currentStage );
    if( currentKeys.length !== 1 || currentKeys[0] !== '$sort' )
    {
        return false;
    }

    if( !isPlainObject( currentStage.$sort ))
    {
        return false;
    }

    return isOrderAgnosticGroup( nextStage );
}

export function isDeadSortBeforeCount( currentStage: unknown, nextStage: unknown ): boolean
{
    if( !isPlainObject( currentStage ) || !isPlainObject( nextStage ))
    {
        return false;
    }

    const currentKeys = Object.keys( currentStage );
    if( currentKeys.length !== 1 || currentKeys[0] !== '$sort' )
    {
        return false;
    }

    if( !isPlainObject( currentStage.$sort ))
    {
        return false;
    }

    const nextKeys = Object.keys( nextStage );
    if( nextKeys.length !== 1 || nextKeys[0] !== '$count' )
    {
        return false;
    }

    const countSpec = nextStage.$count;

    return typeof countSpec === 'string' && countSpec.length > 0;
}

export function isDeadSortBeforeSortByCount( currentStage: unknown, nextStage: unknown ): boolean
{
    if( !isPlainObject( currentStage ) || !isPlainObject( nextStage ))
    {
        return false;
    }

    const currentKeys = Object.keys( currentStage );
    if( currentKeys.length !== 1 || currentKeys[0] !== '$sort' )
    {
        return false;
    }

    if( !isPlainObject( currentStage.$sort ))
    {
        return false;
    }

    const nextKeys = Object.keys( nextStage );

    return nextKeys.length === 1 && nextKeys[0] === '$sortByCount';
}

export function proveRedundantSortElimination(
    currentStage: unknown,
    nextStage: unknown
): boolean
{
    if( isAdjacentSort( currentStage, nextStage ))
    {
        return true;
    }

    if( isDeadSortBeforeGroup( currentStage, nextStage ))
    {
        return true;
    }

    if( isDeadSortBeforeCount( currentStage, nextStage ))
    {
        return true;
    }

    if( isDeadSortBeforeSortByCount( currentStage, nextStage ))
    {
        return true;
    }

    return false;
}
