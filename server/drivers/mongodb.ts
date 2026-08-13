import {
  MongoClient,
  Collection,
  Document,
  FindCursor,
  ObjectId,
  Decimal128,
  Long,
  Int32,
  Double,
  Binary,
  Timestamp,
  UpdateOptions,
  ReplaceOptions,
} from 'mongodb';
import { ConnectionConfigWithPassword } from '../connections';
import { ColumnNode, Driver, QueryResult, SchemaTree, SchemaNode, TableNode } from './types';
import { parseShellQuery, ParsedCall } from './mongoShellParser';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Converts BSON wrapper types into plain, JSON-safe values so results can travel
// over the wire and render sensibly in a generic table/document viewer. This is a
// display conversion, not a round-trip-safe one — reconstructing BSON types for a
// later query is the shell parser's job (ObjectId(...), ISODate(...), etc.).
function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof ObjectId) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Decimal128) return value.toString();
  if (value instanceof Long) {
    const n = value.toNumber();
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (value instanceof Int32 || value instanceof Double) return value.value;
  if (value instanceof Binary) return value.toString('base64');
  if (value instanceof Timestamp) return value.toString();
  if (value instanceof RegExp) return value.toString();
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeValue(v);
    return out;
  }
  return value;
}

function flattenInto(doc: Record<string, unknown>, prefix: string, out: Record<string, unknown>) {
  for (const [key, value] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      flattenInto(value, path, out);
    } else {
      out[path] = value;
    }
  }
}

// Builds the flattened table view: nested objects become dot-notation columns;
// arrays are left as single JSON-rendered cells. Documents are schemaless, so the
// column set is the union of keys seen across all rows, in first-seen order.
function flattenDocuments(docs: Record<string, unknown>[]): {
  columns: string[];
  rows: unknown[][];
} {
  const flatDocs: Record<string, unknown>[] = [];
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    const flat: Record<string, unknown> = {};
    flattenInto(doc, '', flat);
    for (const key of Object.keys(flat)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
    flatDocs.push(flat);
  }
  // Rows are positional (aligned to `columns`), so they can only be built once the
  // full column union is known. Keys a document lacks become null cells.
  const rows = flatDocs.map((flat) => columns.map((col) => (col in flat ? flat[col] : null)));
  return { columns, rows };
}

// Names the BSON shape of a flattened value for field inference. Deliberately coarse —
// the point is to tell the reader "this is a date, not a string", not to reconstruct
// the exact BSON type code.
function bsonTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof ObjectId) return 'objectId';
  if (value instanceof Date) return 'date';
  if (value instanceof Decimal128) return 'decimal';
  if (value instanceof Long || value instanceof Int32) return 'int';
  if (value instanceof Double) return 'double';
  if (value instanceof Binary) return 'binary';
  if (value instanceof Timestamp) return 'timestamp';
  if (value instanceof RegExp) return 'regex';
  if (Array.isArray(value)) return 'array';
  const primitive = typeof value;
  if (primitive === 'number') return Number.isInteger(value) ? 'int' : 'double';
  if (primitive === 'boolean') return 'bool';
  if (primitive === 'string') return 'string';
  return 'object';
}

function asDoc(value: unknown): Document | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error('Expected a document argument, e.g. { field: value }');
  }
  return value as Document;
}

function asFilter(value: unknown): Document {
  return asDoc(value) ?? {};
}

function requireDoc(value: unknown, context: string): Document {
  const doc = asDoc(value);
  if (!doc) throw new Error(`${context} requires a document argument, e.g. { field: value }`);
  return doc;
}

function requireArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} requires an array argument`);
  return value;
}

function ensureNoChain(chain: ParsedCall[], method: string) {
  if (chain.length > 0) {
    throw new Error(
      `'${method}()' does not return a cursor; remove the chained .${chain[0].method}() call.`
    );
  }
}

function applyCursorChain(cursor: FindCursor, chain: ParsedCall[]): FindCursor {
  let current = cursor;
  for (const { method, args } of chain) {
    switch (method) {
      case 'sort':
        current = current.sort(asFilter(args[0]));
        break;
      case 'limit':
        current = current.limit(Number(args[0]));
        break;
      case 'skip':
        current = current.skip(Number(args[0]));
        break;
      case 'project':
        current = current.project(asFilter(args[0]));
        break;
      default:
        throw new Error(
          `Unsupported chained call '.${method}()' after find(). Supported: sort, limit, skip, project.`
        );
    }
  }
  return current;
}

async function dispatch(
  coll: Collection,
  calls: ParsedCall[],
  signal: AbortSignal
): Promise<Record<string, unknown>[]> {
  const [{ method, args }, ...chain] = calls;

  switch (method) {
    case 'find': {
      const cursor = applyCursorChain(
        coll.find(asFilter(args[0]), { projection: asDoc(args[1]), signal }),
        chain
      );
      return (await cursor.toArray()) as unknown as Record<string, unknown>[];
    }
    case 'findOne': {
      ensureNoChain(chain, method);
      const doc = await coll.findOne(asFilter(args[0]), { projection: asDoc(args[1]), signal });
      return doc ? [doc as Record<string, unknown>] : [];
    }
    case 'aggregate': {
      ensureNoChain(chain, method);
      const pipeline = requireArray(args[0], 'aggregate()') as Document[];
      const cursor = coll.aggregate(pipeline, { signal });
      return (await cursor.toArray()) as unknown as Record<string, unknown>[];
    }
    case 'countDocuments': {
      ensureNoChain(chain, method);
      const count = await coll.countDocuments(asFilter(args[0]), { signal });
      return [{ count }];
    }
    case 'estimatedDocumentCount': {
      ensureNoChain(chain, method);
      const count = await coll.estimatedDocumentCount();
      return [{ count }];
    }
    case 'distinct': {
      ensureNoChain(chain, method);
      if (typeof args[0] !== 'string') throw new Error("distinct() requires a field name string, e.g. distinct('status')");
      const field = args[0];
      const values = await coll.distinct(field, asFilter(args[1]));
      return values.map((v: unknown) => ({ [field]: v }));
    }
    case 'insertOne': {
      ensureNoChain(chain, method);
      const doc = requireDoc(args[0], 'insertOne()');
      const result = await coll.insertOne(doc);
      return [{ acknowledged: result.acknowledged, insertedId: result.insertedId }];
    }
    case 'insertMany': {
      ensureNoChain(chain, method);
      const docs = requireArray(args[0], 'insertMany()') as Document[];
      const result = await coll.insertMany(docs);
      return [{
        acknowledged: result.acknowledged,
        insertedCount: result.insertedCount,
        insertedIds: result.insertedIds,
      }];
    }
    case 'updateOne':
    case 'updateMany': {
      ensureNoChain(chain, method);
      const filter = asFilter(args[0]);
      const update = requireDoc(args[1], `${method}()`);
      const options = (asDoc(args[2]) ?? {}) as UpdateOptions;
      const result = method === 'updateOne'
        ? await coll.updateOne(filter, update, options)
        : await coll.updateMany(filter, update, options);
      return [{
        acknowledged: result.acknowledged,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        upsertedCount: result.upsertedCount,
        upsertedId: result.upsertedId,
      }];
    }
    case 'replaceOne': {
      ensureNoChain(chain, method);
      const filter = asFilter(args[0]);
      const replacement = requireDoc(args[1], 'replaceOne()');
      const options = (asDoc(args[2]) ?? {}) as ReplaceOptions;
      const result = await coll.replaceOne(filter, replacement, options);
      return [{
        acknowledged: result.acknowledged,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        upsertedCount: result.upsertedCount,
        upsertedId: result.upsertedId,
      }];
    }
    case 'deleteOne':
    case 'deleteMany': {
      ensureNoChain(chain, method);
      const filter = asFilter(args[0]);
      const result = method === 'deleteOne'
        ? await coll.deleteOne(filter)
        : await coll.deleteMany(filter);
      return [{ acknowledged: result.acknowledged, deletedCount: result.deletedCount }];
    }
    default:
      throw new Error(
        `Unsupported operation '${method}()'. Supported: find, findOne, aggregate, countDocuments, ` +
          `estimatedDocumentCount, distinct, insertOne, insertMany, updateOne, updateMany, replaceOne, ` +
          `deleteOne, deleteMany.`
      );
  }
}

export class MongoDriver implements Driver {
  private client: MongoClient;
  private readonly databaseName?: string;

  constructor(config: ConnectionConfigWithPassword) {
    const credentials = config.username
      ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
      : '';
    // authSource defaults to 'admin' — the common convention for locally-managed
    // MongoDB users. Anonymous (no-auth) connections omit credentials entirely.
    const query = config.username ? '?authSource=admin' : '';
    const uri = `mongodb://${credentials}${config.host}:${config.port}/${query}`;
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
    this.databaseName = config.database;
  }

  async testConnection(): Promise<void> {
    await this.client.connect();
    await this.client.db('admin').command({ ping: 1 });
  }

  async getDatabases(): Promise<string[]> {
    await this.client.connect();
    const { databases } = await this.client.db().admin().listDatabases();
    return databases.map((d) => d.name);
  }

  async getSchemaTree(): Promise<SchemaTree> {
    await this.client.connect();
    const dbName = this.databaseName ?? this.client.db().databaseName;
    const db = this.client.db(dbName);
    const collections = await db.listCollections(undefined, { nameOnly: true }).toArray();

    const tables: TableNode[] = collections
      .filter((c) => !c.name.startsWith('system.'))
      .map((c) => ({ name: c.name, columns: [] }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Mongo has no schema layer — collections are grouped under a single synthetic
    // "collections" node so the existing schema-tree UI can render them unchanged.
    const schema: SchemaNode = { name: 'collections', tables };
    return { databases: [{ name: dbName, schemas: [schema] }] };
  }

  /**
   * Infers a collection's fields by sampling documents, because there is no catalog to read
   * them from. Nested objects are flattened to dot paths so the names line up with what the
   * results grid shows and with what a `find()` filter has to say.
   *
   * Only names and inferred types are returned — the sampled documents are read here and
   * discarded, never surfaced to the caller.
   */
  async inferFields(collection: string, sampleSize: number): Promise<ColumnNode[]> {
    await this.client.connect();
    const dbName = this.databaseName ?? this.client.db().databaseName;
    const docs = await this.client
      .db(dbName)
      .collection(collection)
      .find({}, { limit: Math.max(1, sampleSize) })
      .toArray();

    // A field absent from any sampled document is reported as nullable — the closest
    // honest equivalent of an optional column.
    const types = new Map<string, Set<string>>();
    const presence = new Map<string, number>();
    for (const doc of docs) {
      const flat: Record<string, unknown> = {};
      flattenInto(doc as Record<string, unknown>, '', flat);
      for (const [name, value] of Object.entries(flat)) {
        if (!types.has(name)) types.set(name, new Set());
        types.get(name)!.add(bsonTypeName(value));
        presence.set(name, (presence.get(name) ?? 0) + 1);
      }
    }

    return [...types.entries()].map(([name, kinds]) => ({
      name,
      type: [...kinds].sort().join(' | '),
      nullable: (presence.get(name) ?? 0) < docs.length,
    }));
  }

  async executeQuery(text: string, onCancel?: (cancel: () => void) => void): Promise<QueryResult> {
    await this.client.connect();
    const start = Date.now();
    const dbName = this.databaseName ?? this.client.db().databaseName;
    const db = this.client.db(dbName);

    const { collection: collName, calls } = parseShellQuery(text);
    const coll = db.collection(collName);

    const controller = new AbortController();
    if (onCancel) onCancel(() => controller.abort());

    let rawDocs: Record<string, unknown>[];
    try {
      rawDocs = await dispatch(coll, calls, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error('Query cancelled');
      }
      throw err;
    }

    const executionTime = Date.now() - start;
    const documents = rawDocs.map((d) => sanitizeValue(d)) as Record<string, unknown>[];
    const { columns, rows } = flattenDocuments(documents);

    return {
      columns,
      rows,
      rowCount: documents.length,
      executionTime,
      documents,
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
