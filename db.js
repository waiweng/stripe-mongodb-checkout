const { MongoClient } = require('mongodb');

/**
 * Holds the MongoDB client and database instance for the `bookstore` database.
 * The client is required for multi-document transactions (inventory + orders).
 */
let client;
let db;

/**
 * Connects to MongoDB Atlas once at application startup and selects the
 * `bookstore` database. Subsequent calls return the same connection.
 */
async function connectToMongoDB() {
  if (db) {
    return db;
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('Missing MONGODB_URI environment variable.');
  }

  client = new MongoClient(mongoUri);
  await client.connect();

  // We use a single database named `bookstore` for products, customers, orders, and webhook audit logs.
  db = client.db('bookstore');
  module.exports.client = client;
  module.exports.db = db;

  // Unique Stripe event ids so we can detect duplicate webhook deliveries and support safe retries.
  await db.collection('payment_events').createIndex({ stripe_event_id: 1 }, { unique: true });

  return db;
}

module.exports = {
  connectToMongoDB,
  client: null,
  db: null,
};
