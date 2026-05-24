type ExtractedFields = { used: string[], produced: string[], removed: string[], destructive: boolean }
type FieldDependency = ExtractedFields & { stage: any, stageID: number }
type Stage = { stageID: number, stage: any, destructive: boolean, dependencies: Stage[], dependents: Stage[] }
type StageType = typeof STAGE_ORDER[number];

const STAGE_DEPS: {[stage: string]: string[]}  = {
    '$limit': ['$sort', '$skip', '$sample', '$match'],
    '$sort': ['$limit', '$skip', '$sample'],
    '$skip': ['$sort', '$limit', '$sample', '$match'],
    '$sample': ['$sort', '$limit', '$skip', '$match'],
    '$match': ['$limit', '$skip', '$sample', '$group', '$bucket', '$bucketAuto', '$facet'],
}
// const ADDITIVE_STAGES = [
//     '$addFields',
//     '$set',
//     '$unset',
//     '$lookup',
//     '$graphLookup',
// ]
const STAGE_ORDER = [
    '$match',
    '$sortByCount',
    '$unwind',
    '$project',
    '$search',
    '$sort',
    '$limit',
    '$skip',
    '$addFields',
    '$set',
    '$lookup',
    '$graphLookup',
    '$group',
    '$bucket',
    '$bucketAuto',
    '$facet',
    '$count',
    '$unset',
    '$sample',
]
const STAGES_ALTERING_COUNT = [
    '$match',
    '$unwind',
    '$search',
    '$limit',
    '$skip',
    '$group',
    '$bucket',
    '$bucketAuto',
    '$facet',
    '$count',
    '$sample',
]
const DATE_OPERATORS = [ '$dayOfYear', '$dayOfMonth', '$dayOfWeek', '$year', '$month', '$week', '$hour', '$minute', '$second', '$millisecond', '$dateToString' ];
const MATHEMATICAL_OPERATORS = [ '$sum', '$subtract', '$multiply', '$divide', '$mod', '$abs', '$ceil', '$floor', '$ln', '$log', '$log10', '$pow', '$sqrt', '$trunc', '$exp', '$round', '$sin', '$cos', '$tan', '$asin', '$acos', '$atan', '$atan2', '$degreesToRadians', '$radiansToDegrees', '$avg', '$min', '$max', '$gt', '$gte', '$lt', '$lte', '$eq', '$ne' ];

export default class QueryOptimizer
{
    /**
     * Optimize the pipeline:
     *  - remove unnecessary stages
     *  - reorder stages, move $lookup to the end if possible
     *  - remove stages that don't affect the count
     * @param pipeline
     */
    optimizePipeline( pipeline: any[] ): any[]
    {
        /*
        rules:
            - keep sort, limit, skip, sample order
            - match, project, group should be as early as possible
            - lookup should be as late as possible
         */
        try
        {
            const dependencies = this.calculateDependencies( pipeline );

            let result: Stage[] = dependencies;

            if ( dependencies.some( ({ stage }) => Object.keys(stage)[0] === '$count' ) )
            {
                result = this.optimizeCountPipeline( dependencies )
            }

            result = this.topSort( result );

            const resultPipeline = result.map( ({ stage }) => stage );

            // if ( resultPipeline.length !== pipeline.length || JSON.stringify(pipeline) !== JSON.stringify(resultPipeline) )
            // {
            //     console.log('======================================================================')
            //     console.log('Original pipeline:');
            //     console.dir( pipeline, { depth: 10 });
            //     console.log('----------------------------------------------------------------------')
            //     console.log('Optimized pipeline:');
            //     console.dir( resultPipeline, { depth: 10 });
            //     console.log('======================================================================')
            // }

            return resultPipeline;
        }
        catch ( e )
        {
            console.error('Error optimizing pipeline:', e);
            return pipeline;
        }
    }

    /**
     * Removes stages that don't affect the count - $lookup, $graphLookup, $project, $addFields, $set, $unset that don't have dependents
     * @param pipeline
     * @private
     */
    private optimizeCountPipeline( pipeline: Stage[] ): Stage[]
    {
        const result = pipeline.slice();

        const queue = result.filter( stage => this.filterCountPipelineQueue( stage ) );

        while ( queue.length > 0 )
        {
            const stage = queue.shift()!;

            const index = result.findIndex( s => s.stageID === stage.stageID );
            if ( index === -1 )
            {
                continue;
            }

            result.splice( index, 1 );

            for ( const dependency of stage.dependencies )
            {
                dependency.dependents = dependency.dependents.filter( d => d.stageID !== stage.stageID );

                if ( this.filterCountPipelineQueue( dependency ) && !queue.find( q => q.stageID === dependency.stageID ) )
                {
                    queue.push( dependency );
                }
            }
        }

        return result;
    }

    calculateDependencies( pipeline: any[] ): Stage[]
    {
        const fieldDependencies: FieldDependency[] = [];

        let i = 0;
        for ( const stage of pipeline )
        {
            const extracted = this.extractFields( stage );

            fieldDependencies.push({ stageID: i++, stage, ...extracted });

            // TODO: $project, $group - destructive operators - vyhodia ostatné fieldy, všetko, čo používa aj niečo iné okrem toho, čo produkujú, musí byť pred nimi
        }

        const dependencies: (Omit<Stage, 'dependencies' | 'dependents'> & {dependencies: number[], dependents: number[]})[] = []
        const result: Stage[] = [];

        for ( let i = 0; i < fieldDependencies.length; ++i )
        {
            const { stageID, stage, destructive } = fieldDependencies[i];

            let deps = fieldDependencies
                .slice(0, i);

            const destructiveIndex = deps.slice().reverse().findIndex( el => el.destructive );
            if ( destructiveIndex !== -1 )
            {
                const destructiveDeps = deps.slice(0, deps.length - destructiveIndex);
                const allDeps = deps.filter( dep => this.filterDependent( dep, fieldDependencies[i] ) );
                deps = [...destructiveDeps, ...allDeps].reduce( (acc, dep) => {
                    if ( !acc.find( d => d.stageID === dep.stageID ) )
                    {
                        acc.push( dep );
                    }
                    return acc;
                }, [] as FieldDependency[]);
            }
            else
            {
                deps = deps.filter( dep => this.filterDependent( dep, fieldDependencies[i] ) );
            }

            dependencies.push({ stageID, stage, destructive, dependencies: deps.map( el => el.stageID ), dependents: [] });
            result.push({ stageID, stage, destructive, dependencies: [], dependents: [] });
        }

        for ( let i = 0; i < fieldDependencies.length; ++i )
        {
            const deps = dependencies[i].dependencies;

            for ( const depStageID of deps )
            {
                const dependency = dependencies.find( d => d.stageID === depStageID );

                if ( dependency )
                {
                    dependency.dependents.push( dependencies[i].stageID );
                }
            }
        }

        // resolve dependency and dependents stageIDs
        for ( const dep of dependencies )
        {
            const { stageID, stage, destructive, dependencies: deps, dependents } = dep;

            const resultStage = result.find( r => r.stageID === stageID )!;
            resultStage.dependencies = deps.map( depID => result.find( d => d.stageID === depID )! );
            resultStage.dependents = dependents.map( depID => result.find( d => d.stageID === depID )! );
        }

        return result;
    }

    private topSort( graph: Stage[] )
    {
        let queue: Stage[] = [];
        const outDegrees: {[stage: string]: number} = {};

        for ( const { stageID } of graph )
        {
            outDegrees[stageID] = 0;
        }

        for ( const { dependents } of graph )
        {
            for ( const { stageID } of dependents )
            {
                outDegrees[stageID]++;
            }
        }

        const initialWave: Stage[] = [];
        for ( const { stageID, stage, destructive, dependencies, dependents } of graph )
        {
            if ( outDegrees[stageID] === 0 )
            {
                initialWave.push({ stageID, stage, destructive, dependencies, dependents });
            }
        }
        initialWave.sort( this.stageSort );
        queue.push(...initialWave);

        const result: Stage[] = [];

        while ( queue.length > 0 )
        {
            const { stageID, stage, destructive, dependencies, dependents } = queue.shift() as Stage;
            result.push({ stageID, stage, destructive, dependencies, dependents });

            const wave: Stage[] = [];
            const subQueue: Stage[] = [];

            for ( const dep of dependents )
            {
                outDegrees[dep.stageID]--;
                if ( [...queue, ...result].find( r => r.stageID === dep.stageID ) )
                {
                    continue;
                }

                if ( outDegrees[dep.stageID] === 0 )
                    // || ( outDegrees[dep.stageID] === 1 && !dep.destructive ) )
                {
                    wave.push(dep);
                }
            }

            wave.sort( this.stageSort );
            subQueue.push(...wave);

            // queue.push(...wave);
            queue = [...subQueue, ...queue];
        }

        return result;
    }

    private stageSort( a: Stage, b: Stage )
    {
        if ( a.destructive && !b.destructive ) { return -1; }
        if ( !a.destructive && b.destructive ) { return 1; }

        const aIndex = STAGE_ORDER.indexOf( Object.keys(a.stage)[0] );
        const bIndex = STAGE_ORDER.indexOf( Object.keys(b.stage)[0] );

        if ( !aIndex ) { return -1; }
        if ( !bIndex ) { return 1; }

        return aIndex - bIndex;
    }

    /**
     * Filter stages that depend on reference
     * @param dep - potential dependent stage
     * @param reference - reference stage
     */
    private filterDependent( dep: FieldDependency, reference: FieldDependency ): boolean
    {
        if ( reference.destructive )
        {
            return true;
        }

        const refStageKey = Object.keys(reference.stage)[0];
        const depStageKey = Object.keys(dep.stage)[0];

        if ( STAGE_DEPS[refStageKey] && STAGE_DEPS[refStageKey].includes( depStageKey ) )
        {
            return true;
        }

        // TODO: prefix match
        return dep.produced.some( field => reference.used.some( used => field === used || field.split('.')[0] === used.split('.')[0] ) );
    }

    private filterCountPipelineQueue( stage: Stage ): boolean
    {
        return ( stage.dependents.length === 0 || ( stage.dependents.length === 1 && this.stageType( stage.dependents[0] ) === '$count' ) )
            && !STAGES_ALTERING_COUNT.includes( this.stageType( stage ) )
    }

    extractFields( stage: any ): ExtractedFields
    {
        const usedFields: Set<string> = new Set();
        const producedFields: Set<string> = new Set();
        const removedFields: Set<string> = new Set();
        let destructive = false;

        const operator = Object.keys(stage)[0];

        switch ( operator )
        {
            case '$match':
                const extracted = this.extractRecursively( stage.$match, true );
                for ( const field of extracted )
                {
                    usedFields.add(field);
                }
                break;

            case '$sortByCount':
                if ( typeof stage.$sortByCount === 'string' )
                {
                    usedFields.add(stage.$sortByCount);
                }
                else
                {
                    this.extractRecursively( stage.$sortByCount, false ).forEach(key => usedFields.add(key));
                }
                break;

            case '$project':
            case '$group':
                // TODO: destructive operators - vyhodia ostatné fieldy, všetko, čo používa aj niečo iné okrem toho, čo produkujú, musí byť pred nimi
                for ( const [key, value] of Object.entries(stage[operator]) )
                {
                    if ( typeof value === 'object' || (typeof value === 'string' && value.startsWith('$')) )
                    {
                        this.extractRecursively( value, false ).forEach(key => usedFields.add(key));
                    }

                    if ( value === 0 )
                    {
                        removedFields.add( key );
                    }
                    else if ( value === 1 )
                    {
                        usedFields.add( key );
                        producedFields.add( key );
                    }
                    else
                    {
                        producedFields.add( key );
                    }
                }
                break;

            case '$addFields':
            case '$set':
                for ( const [key, value] of Object.entries(stage[operator]) )
                {
                    if ( typeof value === 'object' || (typeof value === 'string' && value.startsWith('$')) )
                    {
                        this.extractRecursively( value, false ).forEach(key => usedFields.add(key));
                    }

                    producedFields.add(key);
                }
                break;

            case '$unset':
                const unset = Array.isArray( stage.$unset ) ? stage.$unset : [stage.$unset];
                for ( const field of unset )
                {
                    usedFields.add( field );
                    removedFields.add( field );
                }
                break;

            case '$lookup':
                if ( stage.$lookup.localField )
                {
                    usedFields.add( stage.$lookup.localField )
                }
                if ( stage.$lookup.let )
                {
                    for ( const [key, value] of Object.entries(stage.$lookup.let) )
                    {
                        if ( typeof value === 'string' && value.startsWith('$') )
                        {
                            usedFields.add(value.replace('$', ''));
                        }
                        else if ( typeof value === 'object' )
                        {
                            this.extractRecursively( value, false ).forEach(key => usedFields.add(key));
                        }
                    }
                }
                if ( stage.$lookup.pipeline )
                {
                    for ( const s of stage.$lookup.pipeline )
                    {
                        const { used } = this.extractFields( s );
                        used.forEach( key => usedFields.add(key) );
                    }
                }
                producedFields.add( stage.$lookup.as );
                break;

            case '$bucket':
            case '$bucketAuto':
                if ( typeof stage[operator].groupBy !== 'string' )
                {
                    throw new Error(`Unsupported $bucket groupBy type: "${typeof stage[operator].groupBy}"`);
                }
                usedFields.add( stage[operator].groupBy.replace('$', '') );

                for ( const [key, value] of Object.entries(stage[operator].output) )
                {
                    producedFields.add( key );

                    if ( typeof value === 'object' || (typeof value === 'string' && value.startsWith('$')) )
                    {
                        this.extractRecursively( value, false ).forEach(key => usedFields.add(key));
                    }
                }

                destructive = true;

                break;

            case '$unwind':
                if ( typeof stage.$unwind === 'object' )
                {
                    usedFields.add(stage.$unwind.path.replace('$', ''));
                    producedFields.add(stage.$unwind.path.replace('$', ''));
                }
                else
                {
                    usedFields.add(stage.$unwind.replace('$', ''));
                    producedFields.add(stage.$unwind.replace('$', ''));
                }
                break;

            case '$facet':
                for ( const [key, value] of Object.entries(stage.$facet) )
                {
                    producedFields.add(key);

                    for ( const stage of value as any[] )
                    {
                        const { used } = this.extractFields( stage );
                        used.forEach( key => usedFields.add(key) );
                    }
                }
                destructive = true;
                break;

            case '$graphLookup':
                usedFields.add(stage.$graphLookup.startWith.replace('$', ''));
                usedFields.add(stage.$graphLookup.connectFromField.replace('$', ''));
                usedFields.add(stage.$graphLookup.connectToField.replace('$', ''));
                producedFields.add( stage.$graphLookup.as );
                break;

            case '$count':
                producedFields.add( stage.$count );
                destructive = true;
                break;

            case '$search':
            case '$limit':
            case '$skip':
            case '$sample':
                break;

            case '$sort':
                for ( const [key, value] of Object.entries(stage.$sort) )
                {
                    usedFields.add(key);
                }
                break;

            case '$replaceWith':
                destructive = true;
                break;

            default:
                throw new Error(`Unsupported stage: "${operator}"`);
        }


        return { used: Array.from(usedFields), produced: Array.from(producedFields), removed: Array.from( removedFields ), destructive }
    }

    /**
     * Extract fields from the object recursively
     * @param obj
     * @param extractKeys - extract keys as well
     *   true - { $match: { year: { $year: '$date' } } } - extract 'year' as well
     *   false - { "$group": { "_id": { "year": { "$year": "$date" } }, "count": { "$sum": 1 } } } - extract 'date' only
     */
    private extractRecursively( obj: any, extractKeys: boolean ): Set<string>
    {
        const fields: Set<string> = new Set();

        if ( !obj ) { return fields; }

        if ( typeof obj !== 'object' )
        {
            if ( typeof obj === 'string' && obj.startsWith('$') )
            {
                fields.add(obj);
            }
        }
        else if ( Array.isArray(obj) )
        {
            obj.forEach( (item: any) => typeof item === 'string' && item.startsWith('$') && fields.add(item) );
        }
        else
        {
            for ( const [key, value] of Object.entries(obj) )
            {
                if ( key === '$and' || key === '$or' )
                {
                    for ( const item of value as any[] )
                    {
                        this.extractRecursively( item, extractKeys ).forEach(key => fields.add(key));
                    }
                }
                else if ( key === '$exists' )
                {
                    // ignore
                }
                else if ( key === '$expr' )
                {
                    this.extractRecursively( value, extractKeys ).forEach(key => fields.add(key));
                }
                else if ( key === '$map' || key === '$filter' || key === '$reduce' )
                {
                    fields.add((value as any).input);
                }
                else if ( key === '$mergeObjects' )
                {
                    for ( const item of value as any[] )
                    {
                        if ( typeof item === 'string' && item.startsWith('$') )
                        {
                            this.extractRecursively( item, extractKeys ).forEach(key => fields.add(key));
                        }
                    }
                }
                else if ( key === '$cond' )
                {
                    if ( Array.isArray(value) )
                    {
                        this.extractRecursively( value[0], extractKeys ).forEach(key => fields.add(key));
                        this.extractRecursively( value[1], extractKeys ).forEach(key => fields.add(key));
                        this.extractRecursively( value[2], extractKeys ).forEach(key => fields.add(key));
                    }
                    else
                    {
                        this.extractRecursively( (value as any).if, extractKeys ).forEach(key => fields.add(key));
                        this.extractRecursively( (value as any).then, extractKeys ).forEach(key => fields.add(key));
                        this.extractRecursively( (value as any).else, extractKeys ).forEach(key => fields.add(key));
                    }
                }
                else if ( key === '$addToSet' )
                {
                    this.extractRecursively( value, extractKeys ).forEach(key => fields.add(key));
                }
                else if ( key === '$arrayElemAt' )
                {
                    fields.add((value as any[])[0]);
                }
                else if ( key === '$function' )
                {
                    (value as any).args
                        .filter( (arg: any) => typeof arg === 'string' && arg.startsWith('$'))
                        .forEach( (arg: string) => fields.add(arg));
                }
                else if ( key === '$switch' )
                {
                    for ( const branch of (value as any).branches )
                    {
                        this.extractRecursively( branch.case, extractKeys ).forEach(key => fields.add(key));
                    }
                    this.extractRecursively( (value as any).default, extractKeys ).forEach(key => fields.add(key));
                }
                else if ( MATHEMATICAL_OPERATORS.includes(key) )
                {
                    this.extractRecursively( value, extractKeys ).forEach(key => fields.add(key));
                }
                else if ( DATE_OPERATORS.includes(key) )
                {
                    const date = typeof value === 'string' ? value : (value as any).date;
                    if ( date && date.startsWith('$') )
                    {
                        fields.add( date );
                    }
                    else if ( typeof date === 'object' )
                    {
                        this.extractRecursively( date, extractKeys ).forEach(key => fields.add(key));
                    }
                }
                else if ( ['$size', '$push', '$first', '$last'].includes(key) )
                {
                    if ( typeof value === 'string' )
                    {
                        fields.add( value );
                    }
                    else if ( value && typeof value === 'object' && Object.keys( value ).length === 1 && Object.keys( value )[0].startsWith('$') )
                    {
                        this.extractRecursively( value, extractKeys ).forEach(key => fields.add(key));
                    }
                }
                else if ( Array.isArray( value ) )
                {
                    value.forEach( (item: any) => {
                        if ( typeof item === 'string' && item.startsWith('$') )
                        {
                            fields.add(item);
                        }
                        else if ( typeof item === 'object' )
                        {
                            this.extractRecursively( item, extractKeys ).forEach( key => fields.add(key) );
                        }
                    } );
                }
                else if ( !key.startsWith('$') && extractKeys )
                {
                    fields.add(key);
                    if ( typeof value === 'object' )
                    {
                        this.extractRecursively( value, extractKeys ).forEach(key => fields.add(key));
                    }
                }
                else if ( typeof value === 'object' )
                {
                    this.extractRecursively( value, extractKeys ).forEach(key => fields.add(key));
                }
                else if ( ['$literal'].includes(key) )
                {
                    // ignore
                }
                else
                {
                    throw new Error(`Unsupported operator: "${key}"`);
                }
            }
        }

        const result: Set<string> = new Set();
        for ( const field of fields )
        {
            result.add(field.startsWith('$') ? field.replace(/^\$/, '') : field);
        }

        return new Set([...result].filter( field => !field.startsWith('$') ));
    }

    private stageType( stage: Stage ): StageType
    {
        return Object.keys(stage.stage)[0] as StageType;
    }
}