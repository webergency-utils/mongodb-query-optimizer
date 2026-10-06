import
{
    StageInfo,
    StageSemantics
}
from './types';
import { analyzeStage } from './semantics';
import { isPlainObject } from '../utils';

const KNOWN_STAGE_OPERATORS = new Set([
    '$match',
    '$project',
    '$group',
    '$lookup',
    '$graphLookup',
    '$sort',
    '$limit',
    '$skip',
    '$sample',
    '$addFields',
    '$set',
    '$unset',
    '$unwind',
    '$count',
    '$sortByCount',
    '$replaceRoot',
    '$replaceWith',
    '$facet',
    '$bucket',
    '$bucketAuto',
    '$setWindowFields',
    '$densify',
    '$fill',
    '$documents',
    '$unionWith'
]);

const DESTRUCTIVE_OPERATORS = new Set([
    '$group',
    '$count',
    '$sortByCount',
    '$replaceRoot',
    '$replaceWith',
    '$facet',
    '$bucket',
    '$bucketAuto',
    '$documents'
]);

const ALTERS_COUNT_OPERATORS = new Set([
    '$match',
    '$limit',
    '$skip',
    '$sample',
    '$unwind',
    '$group',
    '$count',
    '$sortByCount',
    '$facet',
    '$bucket',
    '$bucketAuto',
    '$setWindowFields',
    '$densify',
    '$unionWith',
    '$documents',
    '$fill'
]);

function conservativeStageInfo( semantics: StageSemantics ): StageInfo
{
    return {
        index: semantics.index,
        stage: semantics.stage,
        operator: semantics.operator,
        usedFields: new Set([ '*' ]),
        producedFields: new Set([ '*' ]),
        modifiedFields: new Set([ '*' ]),
        removedFields: new Set(),
        isDestructive: true,
        altersCount: true,
        isUnknown: true
    };
}

function toStageInfo( semantics: StageSemantics ): StageInfo
{
    if( semantics.malformed || !KNOWN_STAGE_OPERATORS.has( semantics.operator ))
    {
        return conservativeStageInfo( semantics );
    }

    const val = ( semantics.stage as Record<string, any> )[ semantics.operator ];

    const isDestructive = semantics.operator === '$project'
        ? ( semantics.projection?.mode === 'inclusion' || semantics.projection?.mode === 'mixed' )
        : DESTRUCTIVE_OPERATORS.has( semantics.operator );

    const altersCount = ALTERS_COUNT_OPERATORS.has( semantics.operator );

    const usedFields = new Set( semantics.dependencies.local );
    usedFields.delete( '*' );

    const producedFields = new Set( semantics.writes );
    producedFields.delete( '?' );

    const modifiedFields = new Set( semantics.modifies );
    modifiedFields.delete( '?' );

    const removedFields = new Set( semantics.removes );
    removedFields.delete( '?' );

    if( semantics.operator === '$project' )
    {
        if( semantics.projection?.mode === 'exclusion' )
        {
            usedFields.clear();
            producedFields.clear();
            modifiedFields.clear();
        }
        else if( !( '_id' in val ))
        {
            usedFields.delete( '_id' );
            producedFields.delete( '_id' );
        }
    }
    else if( semantics.operator === '$graphLookup' )
    {
        usedFields.clear();
        for( const f of semantics.dependencies.local )
        {
            usedFields.add( f );
        }
        usedFields.add( val.connectToField );
        for( const f of semantics.dependencies.foreign )
        {
            if( f !== val.connectFromField && f !== val.connectToField )
            {
                usedFields.add( f );
            }
        }
        producedFields.clear();
        modifiedFields.clear();
        producedFields.add( val.as );
        modifiedFields.add( val.as );
        if( typeof val.depthField === 'string' )
        {
            producedFields.add( val.depthField );
            modifiedFields.add( val.depthField );
        }
    }
    else if( semantics.operator === '$addFields' || semantics.operator === '$set' )
    {
        for( const [ k, v ] of Object.entries( val ))
        {
            if( v === '$' + k )
            {
                modifiedFields.delete( k );
            }
        }
    }
    else if( semantics.operator === '$unwind' )
    {
        if( isPlainObject( val ) && typeof val.includeArrayIndex === 'string' )
        {
            producedFields.add( val.includeArrayIndex );
            modifiedFields.add( val.includeArrayIndex );
        }
    }
    else if( semantics.operator === '$unionWith' )
    {
        producedFields.add( '*' );
        modifiedFields.add( '*' );
    }

    return {
        index: semantics.index,
        stage: semantics.stage,
        operator: semantics.operator,
        usedFields,
        producedFields,
        modifiedFields,
        removedFields,
        isDestructive,
        altersCount,
        isUnknown: false
    };
}

export function getStageInfo( stage: any, index: number ): StageInfo
{
    return toStageInfo( analyzeStage( stage, index ));
}

export { analyzePipeline, analyzeStage } from './semantics';
export * from './types';
