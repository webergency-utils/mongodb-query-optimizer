import { createHash, randomBytes } from 'node:crypto';
import {
    BSON,
    MongoClient,
    MongoServerError,
    type AggregateOptions,
    type CreateCollectionOptions,
    type Db,
    type Document,
    type FindOptions,
} from 'mongodb';

export const MONGODB_ORACLE_DATABASE = 'webergency_mongodb_query_optimizer';
export const MONGODB_ORACLE_WRITE_ATTESTATION =
    'ALLOW_WEBERGENCY_MONGODB_QUERY_OPTIMIZER_WRITES';

const OWNERSHIP_COLLECTION = '__wqo_oracle_ownership';
const LEASE_DURATION_MS = 30 * 60 * 1000;
const RUN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;

export interface MongoOracleConfiguration
{
    readonly uri: string;
    readonly database: typeof MONGODB_ORACLE_DATABASE;
    readonly runId: string;
}

export interface LeaseSummary
{
    readonly ownerToken: string;
    readonly leaseExpiresAt: Date;
}

export type ObservationMode =
    | 'ordered-bson'
    | 'multiset'
    | 'acceptance-error'
    | 'structural-barrier';

export type FieldOrderPolicy = 'relaxed' | 'strict';
export type ErrorPolicy = 'relaxed' | 'strict';
export type ExpectedOriginalOutcome = 'success' | 'failure';

export interface OracleComparisonPolicy
{
    readonly fieldOrder?: FieldOrderPolicy;
    readonly errors?: ErrorPolicy;
}

export function oraclePolicyFromOptions( options?: {
    readonly strictFieldOrder?: boolean;
    readonly strictErrors?: boolean;
} ): OracleComparisonPolicy
{
    return {
        fieldOrder: options?.strictFieldOrder ? 'strict' : 'relaxed',
        errors: options?.strictErrors ? 'strict' : 'relaxed',
    };
}

export interface OracleError
{
    readonly code?: number;
    readonly codeName?: string;
    readonly labels: readonly string[];
}

export type OracleExecution =
    | {
        readonly status: 'success';
        readonly documents: readonly Document[];
    }
    | {
        readonly status: 'error';
        readonly error: OracleError;
    };

export interface ObservationComparison
{
    readonly mode: ObservationMode;
    readonly policy?: OracleComparisonPolicy;
    readonly expectedOriginalOutcome?: ExpectedOriginalOutcome;
    readonly original: OracleExecution;
    readonly optimized: OracleExecution;
    readonly generatedNamespaces?: readonly string[];
    readonly originalForm?: unknown;
    readonly optimizedForm?: unknown;
}

export interface LogicalCollectionFixture
{
    readonly documents: readonly Document[];
    readonly options?: CreateCollectionOptions;
}

export type OracleOperation =
    | {
        readonly kind: 'aggregate';
        readonly pipeline: readonly Document[];
        readonly options?: AggregateOptions;
    }
    | {
        readonly kind: 'find';
        readonly filter: Document;
        readonly options?: FindOptions;
    };

export interface MongoDifferentialCase
{
    readonly id: string;
    readonly mainCollectionId: string;
    readonly collections: Readonly<Record<string, LogicalCollectionFixture>>;
    readonly original: OracleOperation;
    readonly optimized: OracleOperation;
    readonly observation: ObservationMode;
    readonly policy?: OracleComparisonPolicy;
    readonly expectedOriginalOutcome?: ExpectedOriginalOutcome;
    readonly originalForm?: unknown;
    readonly optimizedForm?: unknown;
}

export interface MongoDifferentialResult
{
    readonly equal: boolean;
    readonly original: OracleExecution;
    readonly optimized: OracleExecution;
}

interface OwnershipDocument extends Document
{
    readonly _id: string;
    readonly runId: string;
    readonly ownerToken: string;
    readonly collectionPrefix: string;
    readonly collections: string[];
    readonly state: 'seeding' | 'ready';
    readonly leaseExpiresAt: Date;
}

function configurationError(reason: string): never
{
    throw new Error(`MongoDB oracle configuration rejected: ${reason}`);
}

function getUriDatabase(uri: string): string | undefined
{
    let parsed: URL;

    try
    {
        parsed = new URL(uri);
    }
    catch
    {
        return configurationError("MONGODB_URI is invalid");
    }

    if (parsed.protocol !== "mongodb:" && parsed.protocol !== "mongodb+srv:")
    {
        return configurationError("MONGODB_URI protocol is not supported");
    }

    const encodedDatabase = parsed.pathname.replace(/^\/+/, "");
    if (!encodedDatabase)
    {
        return undefined;
    }

    try
    {
        return decodeURIComponent(encodedDatabase);
    }
    catch
    {
        return configurationError("MONGODB_URI database is invalid");
    }
}

export function validateMongoOracleEnvironment(
    environment: Readonly<Record<string, string | undefined>>,
): MongoOracleConfiguration
{
    const uri = environment.MONGODB_URI;
    if (!uri)
    {
        return configurationError("MONGODB_URI is required");
    }

    if (environment.MONGODB_TEST_DATABASE !== MONGODB_ORACLE_DATABASE)
    {
        return configurationError("MONGODB_TEST_DATABASE is not authorized");
    }

    const uriDatabase = getUriDatabase(uri);
    if (uriDatabase !== undefined && uriDatabase !== MONGODB_ORACLE_DATABASE)
    {
        return configurationError("MONGODB_URI database is not authorized");
    }

    const runId = environment.MONGODB_TEST_RUN_ID;
    if (!runId || !RUN_ID_PATTERN.test(runId))
    {
        return configurationError("MONGODB_TEST_RUN_ID is invalid");
    }

    if (
        environment.MONGODB_TEST_WRITE_ATTESTATION
        !== MONGODB_ORACLE_WRITE_ATTESTATION
    )
    {
        return configurationError("write attestation is missing");
    }

    return {
        uri,
        database: MONGODB_ORACLE_DATABASE,
        runId,
    };
}

function normalizeNamePart(value: string): string
{
    const normalized = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");

    if (!normalized)
    {
        throw new Error("MongoDB oracle namespace component is empty");
    }

    return normalized;
}

function boundedCollectionName(parts: readonly string[]): string
{
    const raw = `wqo_${parts.map(normalizeNamePart).join('_')}`;
    if (raw.length <= 120)
    {
        return raw;
    }

    const digest = createHash("sha256").update(raw).digest("hex").slice(0, 12);
    return `${raw.slice(0, 107)}_${digest}`;
}

export function buildPhysicalCollectionNames(input: {
    readonly runId: string;
    readonly runToken: string;
    readonly caseId: string;
    readonly caseToken: string;
    readonly side: "original" | "optimized";
    readonly logicalCollectionIds: readonly string[];
}): Record<string, string>
{
    const sideToken = input.side === "original" ? "o" : "x";
    const result: Record<string, string> = {};

    for (const logicalId of input.logicalCollectionIds)
    {
        result[logicalId] = boundedCollectionName([
            input.runId,
            input.runToken.slice(0, 12),
            input.caseId,
            input.caseToken.slice(0, 8),
            sideToken,
            logicalId,
        ]);
    }

    return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown>
{
    if (!value || typeof value !== "object" || Array.isArray(value))
    {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function bindPipelineValue(
    value: unknown,
    namespaces: Readonly<Record<string, string>>,
): unknown
{
    if (Array.isArray(value))
    {
        return value.map((entry) => bindPipelineValue(entry, namespaces));
    }

    if (!isPlainObject(value))
    {
        return value;
    }

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value))
    {
        if (key === "pipeline" && Array.isArray(child))
        {
            result[key] = bindPipelineNamespaces(child, namespaces);
        }
        else
        {
            result[key] = bindPipelineValue(child, namespaces);
        }
    }

    return result;
}

function bindStageNamespaces(
    stage: Document,
    namespaces: Readonly<Record<string, string>>,
): Document
{
    const result = bindPipelineValue(stage, namespaces) as Document;

    for (const operator of ["$lookup", "$graphLookup"] as const)
    {
        const specification = result[operator];
        if (isPlainObject(specification) && typeof specification.from === "string")
        {
            specification.from = namespaces[specification.from] ?? specification.from;
        }
    }

    const union = result.$unionWith;
    if (typeof union === "string")
    {
        result.$unionWith = namespaces[union] ?? union;
    }
    else if (isPlainObject(union) && typeof union.coll === "string")
    {
        union.coll = namespaces[union.coll] ?? union.coll;
    }

    const facet = result.$facet;
    if (isPlainObject(facet))
    {
        for (const [name, branch] of Object.entries(facet))
        {
            if (Array.isArray(branch))
            {
                facet[name] = bindPipelineNamespaces(branch, namespaces);
            }
        }
    }

    return result;
}

export function bindPipelineNamespaces(
    pipeline: readonly Document[],
    namespaces: Readonly<Record<string, string>>,
): Document[]
{
    return pipeline.map((stage) => bindStageNamespaces(stage, namespaces));
}

function nestedPipelines(stage: Document): readonly (readonly Document[])[]
{
    const result: (readonly Document[])[] = [];
    const facet = stage.$facet;

    if (isPlainObject(facet))
    {
        for (const value of Object.values(facet))
        {
            if (Array.isArray(value))
            {
                result.push(value as Document[]);
            }
        }
    }

    for (const operator of ["$lookup", "$unionWith"] as const)
    {
        const specification = stage[operator];
        if (isPlainObject(specification) && Array.isArray(specification.pipeline))
        {
            result.push(specification.pipeline as Document[]);
        }
    }

    return result;
}

export function assertReadOnlyPipeline(pipeline: readonly Document[]): void
{
    for (const stage of pipeline)
    {
        if (isPlainObject(stage) && ("$out" in stage || "$merge" in stage))
        {
            throw new Error("MongoDB oracle rejected a write-capable pipeline stage");
        }

        for (const childPipeline of nestedPipelines(stage))
        {
            assertReadOnlyPipeline(childPipeline);
        }
    }
}

export function isCurrentLeaseOwner(
    lease: LeaseSummary,
    ownerToken: string,
    now = new Date(),
): boolean
{
    return (
        lease.ownerToken === ownerToken
        && lease.leaseExpiresAt.getTime() > now.getTime()
    );
}

function canonicalBson( value: unknown ): string
{
    return BSON.EJSON.stringify( value, {
        relaxed: false,
        legacy: false,
    } );
}

function canonicalizeRelaxedValue( value: unknown ): unknown
{
    if( Array.isArray( value ) )
    {
        return value.map( canonicalizeRelaxedValue );
    }

    if( isPlainObject( value ) )
    {
        const sorted: Record<string, unknown> = {};
        const keys = Object.keys( value ).sort();

        for( const key of keys )
        {
            sorted[key] = canonicalizeRelaxedValue( value[key] );
        }

        return sorted;
    }

    return value;
}

export function compareObservations( input: ObservationComparison ): {
    readonly equal: boolean;
}
{
    if( input.expectedOriginalOutcome !== undefined )
    {
        const expectedStatus = input.expectedOriginalOutcome === 'success' ? 'success' : 'error';
        if( input.original.status !== expectedStatus )
        {
            return { equal: false };
        }
    }

    if( input.mode === 'structural-barrier' )
    {
        if( input.original.status !== input.optimized.status )
        {
            return { equal: false };
        }

        return {
            equal: canonicalBson( input.originalForm ) === canonicalBson( input.optimizedForm ),
        };
    }

    const errorsPolicy: ErrorPolicy = input.policy?.errors
        ?? ( input.mode === 'acceptance-error' ? 'strict' : 'relaxed' );

    if( input.original.status === 'error' )
    {
        if( errorsPolicy === 'relaxed' )
        {
            return { equal: true };
        }

        return { equal: input.optimized.status === 'error' };
    }

    if( input.optimized.status === 'error' )
    {
        return { equal: false };
    }

    if( input.mode === 'acceptance-error' )
    {
        return { equal: true };
    }

    const fieldOrderPolicy: FieldOrderPolicy = input.policy?.fieldOrder ?? 'relaxed';

    const originalDocs = fieldOrderPolicy === 'relaxed'
        ? input.original.documents.map( canonicalizeRelaxedValue )
        : input.original.documents;
    const optimizedDocs = fieldOrderPolicy === 'relaxed'
        ? input.optimized.documents.map( canonicalizeRelaxedValue )
        : input.optimized.documents;

    const originalFingerprints = originalDocs.map( canonicalBson );
    const optimizedFingerprints = optimizedDocs.map( canonicalBson );

    if( input.mode === 'multiset' )
    {
        originalFingerprints.sort();
        optimizedFingerprints.sort();
    }

    return {
        equal: canonicalBson( originalFingerprints ) === canonicalBson( optimizedFingerprints ),
    };
}

function cloneDocuments(documents: readonly Document[]): Document[]
{
    return documents.map((document) =>
        BSON.EJSON.deserialize(BSON.EJSON.serialize(document)) as Document
    );
}

function captureExecutionError(error: unknown): OracleExecution
{
    if (error instanceof MongoServerError)
    {
        return {
            status: "error",
            error: {
                code: typeof error.code === "number" ? error.code : undefined,
                codeName: typeof error.codeName === "string" ? error.codeName : undefined,
                labels: [...error.errorLabels].sort(),
            },
        };
    }

    return {
        status: "error",
        error: {
            codeName: "UnknownMongoDBError",
            labels: [],
        },
    };
}

export class MongoDifferentialOracle
{
    readonly runToken = randomBytes(16).toString("hex");

    private readonly client: MongoClient;
    private database?: Db;
    private collectionPrefix = "";

    constructor(readonly configuration: MongoOracleConfiguration)
    {
        this.client = new MongoClient(configuration.uri, {
            readPreference: "primary",
            retryReads: true,
            retryWrites: true,
        });
    }

    async connect(): Promise<void>
    {
        try
        {
            await this.client.connect();
            this.database = this.client.db(this.configuration.database);

            const buildInfo = await this.database.command({ buildInfo: 1 });
            const majorVersion = Number(String(buildInfo.version).split(".")[0]);
            if (majorVersion !== 8)
            {
                throw new Error("unsupported MongoDB server");
            }

            this.collectionPrefix = boundedCollectionName([
                this.configuration.runId,
                this.runToken.slice(0, 12),
            ]);

            const ownership: OwnershipDocument = {
                _id: this.runToken,
                runId: this.configuration.runId,
                ownerToken: this.runToken,
                collectionPrefix: this.collectionPrefix,
                collections: [],
                state: "seeding",
                leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
            };

            await this.database.collection<OwnershipDocument>(OWNERSHIP_COLLECTION).insertOne(
                ownership,
                { writeConcern: { w: "majority" } },
            );
        }
        catch
        {
            await this.client.close().catch(() => undefined);
            this.database = undefined;
            throw new Error("MongoDB oracle connection or version check failed");
        }
    }

    private getDatabase(): Db
    {
        if (!this.database)
        {
            throw new Error("MongoDB oracle is not connected");
        }

        return this.database;
    }

    private ownsCollectionName(name: string): boolean
    {
        return name.startsWith(`${this.collectionPrefix}_`);
    }

    private async markSeeding(collectionNames: readonly string[]): Promise<void>
    {
        const database = this.getDatabase();
        const result = await database.collection<OwnershipDocument>(OWNERSHIP_COLLECTION)
            .updateOne(
                {
                    _id: this.runToken,
                    ownerToken: this.runToken,
                },
                {
                    $set: {
                        state: "seeding",
                        leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
                    },
                    $addToSet: {
                        collections: {
                            $each: [...collectionNames],
                        },
                    },
                },
                { writeConcern: { w: "majority" } },
            );

        if (result.matchedCount !== 1)
        {
            throw new Error("MongoDB oracle ownership lease is unavailable");
        }
    }

    private async seedSide(
        fixtures: Readonly<Record<string, LogicalCollectionFixture>>,
        names: Readonly<Record<string, string>>,
    ): Promise<void>
    {
        const database = this.getDatabase();

        for (const [logicalId, fixture] of Object.entries(fixtures))
        {
            const collectionName = names[logicalId];
            if (!collectionName || !this.ownsCollectionName(collectionName))
            {
                throw new Error("MongoDB oracle refused an unowned collection name");
            }

            await database.createCollection(collectionName, fixture.options);
            if (fixture.documents.length > 0)
            {
                await database.collection(collectionName).insertMany(
                    cloneDocuments(fixture.documents),
                    { writeConcern: { w: "majority" } },
                );
            }
        }
    }

    private async markReady(): Promise<void>
    {
        const database = this.getDatabase();
        const result = await database.collection<OwnershipDocument>(OWNERSHIP_COLLECTION)
            .updateOne(
                {
                    _id: this.runToken,
                    ownerToken: this.runToken,
                    state: "seeding",
                },
                {
                    $set: {
                        state: "ready",
                        leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
                    },
                },
                { writeConcern: { w: "majority" } },
            );

        if (result.matchedCount !== 1)
        {
            throw new Error("MongoDB oracle could not publish fixture readiness");
        }
    }

    private async assertReady(): Promise<void>
    {
        const lease = await this.getDatabase()
            .collection<OwnershipDocument>(OWNERSHIP_COLLECTION)
            .findOne({
                _id: this.runToken,
                ownerToken: this.runToken,
                state: "ready",
            });

        if (
            !lease
            || !isCurrentLeaseOwner(lease, this.runToken)
        )
        {
            throw new Error("MongoDB oracle fixture is not ready");
        }
    }

    private async execute(
        collectionName: string,
        operation: OracleOperation,
    ): Promise<OracleExecution>
    {
        try
        {
            const collection = this.getDatabase().collection(collectionName);
            const documents = operation.kind === "aggregate"
                ? await collection.aggregate([...operation.pipeline], {
                    ...operation.options,
                    readPreference: "primary",
                }).toArray()
                : await collection.find(operation.filter, {
                    ...operation.options,
                    readPreference: "primary",
                }).toArray();

            return {
                status: "success",
                documents,
            };
        }
        catch (error)
        {
            return captureExecutionError(error);
        }
    }

    async compare(testCase: MongoDifferentialCase): Promise<MongoDifferentialResult>
    {
        assertReadOnlyPipeline(
            testCase.original.kind === "aggregate" ? testCase.original.pipeline : [],
        );
        assertReadOnlyPipeline(
            testCase.optimized.kind === "aggregate" ? testCase.optimized.pipeline : [],
        );

        const logicalCollectionIds = Object.keys(testCase.collections);
        if (!logicalCollectionIds.includes(testCase.mainCollectionId))
        {
            throw new Error("MongoDB oracle main collection fixture is missing");
        }

        const caseToken = randomBytes(12).toString("hex");
        const shared = {
            runId: this.configuration.runId,
            runToken: this.runToken,
            caseId: testCase.id,
            caseToken,
            logicalCollectionIds,
        };
        const originalNames = buildPhysicalCollectionNames({
            ...shared,
            side: "original",
        });
        const optimizedNames = buildPhysicalCollectionNames({
            ...shared,
            side: "optimized",
        });
        const collectionNames = [
            ...Object.values(originalNames),
            ...Object.values(optimizedNames),
        ];

        try
        {
            await this.markSeeding(collectionNames);
            await this.seedSide(testCase.collections, originalNames);
            await this.seedSide(testCase.collections, optimizedNames);
            await this.markReady();
            await this.assertReady();
        }
        catch
        {
            throw new Error("MongoDB oracle fixture preparation failed");
        }

        const originalOperation: OracleOperation = testCase.original.kind === "aggregate"
            ? {
                ...testCase.original,
                pipeline: bindPipelineNamespaces(
                    testCase.original.pipeline,
                    originalNames,
                ),
            }
            : testCase.original;
        const optimizedOperation: OracleOperation = testCase.optimized.kind === "aggregate"
            ? {
                ...testCase.optimized,
                pipeline: bindPipelineNamespaces(
                    testCase.optimized.pipeline,
                    optimizedNames,
                ),
            }
            : testCase.optimized;

        const original = await this.execute(
            originalNames[testCase.mainCollectionId],
            originalOperation,
        );
        const optimized = await this.execute(
            optimizedNames[testCase.mainCollectionId],
            optimizedOperation,
        );
        const comparison = compareObservations( {
            mode: testCase.observation,
            policy: testCase.policy,
            expectedOriginalOutcome: testCase.expectedOriginalOutcome,
            original,
            optimized,
            generatedNamespaces: collectionNames,
            originalForm: testCase.originalForm,
            optimizedForm: testCase.optimizedForm,
        } );

        return {
            equal: comparison.equal,
            original,
            optimized,
        };
    }

    async cleanup(): Promise<void>
    {
        if (!this.database)
        {
            return;
        }

        const ownershipCollection = this.database
            .collection<OwnershipDocument>(OWNERSHIP_COLLECTION);
        const lease = await ownershipCollection.findOne({
            _id: this.runToken,
            ownerToken: this.runToken,
        });

        if (lease)
        {
            for (const collectionName of lease.collections)
            {
                if (this.ownsCollectionName(collectionName))
                {
                    await this.database.collection(collectionName).drop().catch(() => undefined);
                }
            }

            await ownershipCollection.deleteOne({
                _id: this.runToken,
                ownerToken: this.runToken,
            });
        }
    }

    async close(): Promise<void>
    {
        await this.client.close();
        this.database = undefined;
    }
}
