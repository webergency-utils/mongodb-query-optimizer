export function isEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        if (a instanceof Date && b instanceof Date) {
            return a.getTime() === b.getTime();
        }
        if (a instanceof RegExp && b instanceof RegExp) {
            return a.toString() === b.toString();
        }
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) return false;
            return a.every((v, i) => isEqual(v, b[i]));
        }
        // Prefer valueOf/equals for BSON and similar exotic objects
        if (typeof (a as any).equals === 'function') {
            try {
                return (a as any).equals(b);
            } catch {
                // fall through
            }
        }
        if (a.constructor !== b.constructor) {
            return false;
        }
        if (a.constructor && a.constructor !== Object && a.constructor !== Array) {
            if (typeof a.valueOf === 'function' && typeof b.valueOf === 'function') {
                const va = a.valueOf();
                const vb = b.valueOf();
                if (va !== a || vb !== b) {
                    return isEqual(va, vb);
                }
            }
            if (typeof a.toString === 'function' && a.toString !== Object.prototype.toString) {
                return a.toString() === b.toString();
            }
        }
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        return keysA.every(k => k in b && isEqual(a[k], b[k]));
    }
    return false;
}

export function isPlainObject<T = Record<string, any>>( val: unknown ): val is T
{
    if( val === null || typeof val !== 'object' || Array.isArray( val )){ return false }

    const proto = Object.getPrototypeOf( val );

    return proto === Object.prototype || proto === null;
}

export function isEmptyObject( val: unknown ): boolean
{
    return isPlainObject( val ) && Object.keys( val ).length === 0;
}

export function isOperatorSubdocument( val: unknown ): boolean
{
    if( !isPlainObject( val )){ return false }

    const keys = Object.keys( val );

    return keys.length > 0 && keys.every(( key ) => key.startsWith( '$' ));
}

function isExoticObject(val: any): boolean {
    if (!val || typeof val !== 'object') return false;
    if (Array.isArray(val)) return false;
    if (val instanceof Date || val instanceof RegExp) return false;
    if (!isPlainObject(val)) return true;
    if (typeof val._bsontype === 'string') return true;
    if (typeof val.toBSON === 'function') return true;
    return false;
}

export function deepClone( val: any, seen: WeakMap<object, any> = new WeakMap() ): any
{
    if( val === null || val === undefined ){ return val; }

    if( typeof val !== 'object' ){ return val; }

    if( seen.has( val )){ return seen.get( val ); }

    if( val instanceof Date ){ return new Date( val.getTime() ); }

    if( val instanceof RegExp ){ return new RegExp( val.source, val.flags ); }

    if( typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function' && Buffer.isBuffer( val ))
    {
        return Buffer.from( val );
    }

    if( isExoticObject( val ))
    {
        return val;
    }

    if( Array.isArray( val ))
    {
        const copy: any[] = [];
        seen.set( val, copy );
        for( const item of val )
        {
            copy.push( deepClone( item, seen ));
        }
        return copy;
    }

    const res: any = {};
    seen.set( val, res );
    for( const [ k, v ] of Object.entries( val ))
    {
        res[ k ] = deepClone( v, seen );
    }
    return res;
}

function frame(tag: string, value: string): string
{
    return `${tag}${value.length}:${value}`;
}

function fingerprintNumber(value: number): string
{
    if (Number.isNaN(value))
    {
        return "number:nan";
    }

    if (value === Number.POSITIVE_INFINITY)
    {
        return "number:+infinity";
    }

    if (value === Number.NEGATIVE_INFINITY)
    {
        return "number:-infinity";
    }

    if (Object.is(value, -0))
    {
        return "number:-0";
    }

    return `number:${value}`;
}

function fingerprintFunction(value: Function): string
{
    let source: string;

    try
    {
        source = Function.prototype.toString.call(value);
    }
    catch
    {
        source = value.name;
    }

    return frame("function:", source);
}

function fingerprintBytes(value: Uint8Array): string
{
    let result = "";

    for (const byte of value)
    {
        result += byte.toString(16).padStart(2, "0");
    }

    return result;
}

function fingerprintSymbol(value: symbol): string
{
    const globalKey = Symbol.keyFor(value);
    if (globalKey !== undefined)
    {
        return frame("global-symbol:", globalKey);
    }

    return frame("local-symbol:", value.description ?? "");
}

/**
 * Produces a dependency-free, BSON-aware structural identity for scheduler
 * states. Object and array property order is intentionally significant because
 * MongoDB preserves BSON document order.
 */
export function structuralFingerprint(value: unknown): string
{
    const seen = new WeakMap<object, number>();
    let nextReference = 0;

    const visitKey = (key: PropertyKey): string =>
    {
        return typeof key === "symbol"
            ? fingerprintSymbol(key)
            : frame("string-key:", String(key));
    };

    const visitProperties = (object: object): string =>
    {
        const properties: string[] = [];

        for (const key of Reflect.ownKeys(object))
        {
            const descriptor = Object.getOwnPropertyDescriptor(object, key);
            if (!descriptor)
            {
                properties.push(frame("missing-descriptor:", visitKey(key)));
                continue;
            }

            const flags = [
                descriptor.enumerable ? "e" : "-",
                descriptor.configurable ? "c" : "-",
                "writable" in descriptor && descriptor.writable ? "w" : "-",
            ].join("");
            const descriptorValue = "value" in descriptor
                ? visit(descriptor.value)
                : [
                    descriptor.get ? fingerprintFunction(descriptor.get) : "no-getter",
                    descriptor.set ? fingerprintFunction(descriptor.set) : "no-setter",
                ].map((part) => frame("accessor:", part)).join("");

            properties.push(frame(
                "property:",
                visitKey(key) + frame("flags:", flags) + frame("value:", descriptorValue),
            ));
        }

        return properties.join("");
    };

    const visit = (current: unknown): string =>
    {
        if (current === null)
        {
            return "null";
        }

        switch (typeof current)
        {
            case "undefined":
                return "undefined";
            case "boolean":
                return current ? "boolean:true" : "boolean:false";
            case "number":
                return fingerprintNumber(current);
            case "bigint":
                return `bigint:${current}`;
            case "string":
                return frame("string:", current);
            case "symbol":
                return fingerprintSymbol(current);
            case "function":
                return fingerprintFunction(current);
            case "object":
                break;
            default:
                return frame("unknown:", String(current));
        }

        const object = current as object;
        const priorReference = seen.get(object);
        if (priorReference !== undefined)
        {
            return `reference:${priorReference}`;
        }

        const reference = nextReference++;
        seen.set(object, reference);
        const referenceTag = `reference-id:${reference};`;

        if (current instanceof Date)
        {
            return referenceTag + fingerprintNumber(current.getTime());
        }

        if (current instanceof RegExp)
        {
            return referenceTag
                + frame("regexp-source:", current.source)
                + frame("regexp-flags:", current.flags);
        }

        if (
            typeof Buffer !== "undefined"
            && typeof Buffer.isBuffer === "function"
            && Buffer.isBuffer(current)
        )
        {
            return referenceTag + frame(
                "buffer:",
                fingerprintBytes(current as Uint8Array),
            );
        }

        if (current instanceof ArrayBuffer)
        {
            return referenceTag + frame(
                "array-buffer:",
                fingerprintBytes(new Uint8Array(current)),
            );
        }

        if (ArrayBuffer.isView(current))
        {
            const view = current as ArrayBufferView;
            const bytes = new Uint8Array(
                view.buffer,
                view.byteOffset,
                view.byteLength,
            );
            const constructorName = current.constructor?.name ?? "ArrayBufferView";
            return referenceTag
                + frame("array-buffer-view:", constructorName)
                + frame("bytes:", fingerprintBytes(bytes));
        }

        if (current instanceof Map)
        {
            const entries: string[] = [];
            for (const [key, entryValue] of current)
            {
                entries.push(frame(
                    "map-entry:",
                    frame("key:", visit(key)) + frame("value:", visit(entryValue)),
                ));
            }

            return referenceTag + frame("map:", entries.join(""));
        }

        if (current instanceof Set)
        {
            const entries = Array.from(
                current,
                (entry) => frame("set-entry:", visit(entry)),
            );
            return referenceTag + frame("set:", entries.join(""));
        }

        const prototype = Object.getPrototypeOf(current);
        let kind: string;

        if (Array.isArray(current))
        {
            kind = "array";
        }
        else if (prototype === null)
        {
            kind = "null-prototype-object";
        }
        else if (prototype === Object.prototype)
        {
            kind = "plain-object";
        }
        else
        {
            const constructor = current.constructor;
            const constructorIdentity = typeof constructor === "function"
                ? fingerprintFunction(constructor)
                : frame("constructor:", String(constructor));
            const bsonType = typeof (current as { _bsontype?: unknown })._bsontype === "string"
                ? (current as { _bsontype: string })._bsontype
                : "";

            kind = frame("class:", constructorIdentity)
                + frame("bson-type:", bsonType);
        }

        return referenceTag
            + frame("kind:", kind)
            + frame("properties:", visitProperties(current));
    };

    return visit(value);
}
